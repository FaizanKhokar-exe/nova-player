import { createStore, type StoreApi } from 'zustand/vanilla';
import type { PlaybackStoreApi } from '../playback/playback-store.js';
import type { PrefsStoreApi } from '../prefs/prefs-store.js';
import type { AudioEngine } from './audio-engine.js';

/**
 * Playback speed, the equaliser and the sleep timer - the "listening controls" that sit on top of the playback
 * store without changing it. Speed and EQ come from the persisted preferences and are PUSHED to the audio element /
 * engine whenever they change (and re-applied after each track load, because a media element resets its rate on load).
 *
 * Sleep timer: either "pause in N minutes" or "pause when this track ends". The second works by watching which track is
 * current: the moment a DIFFERENT track becomes current, playback is paused (the next track is cued, not heard).
 */

export interface AudioElementLike {
  playbackRate: number;
  defaultPlaybackRate: number;
  preservesPitch?: boolean;
}

export type SleepState =
  | { readonly mode: 'off' }
  | { readonly mode: 'timer'; readonly minutes: number; readonly endsAtMs: number }
  | { readonly mode: 'track'; readonly trackId: string };

export interface AudioControlsState {
  readonly sleep: SleepState;
  /** Whole milliseconds until the timer fires (0 when there is no timer). Ticks once a second. */
  readonly sleepRemainingMs: number;
  /** One-line message when something happened by itself (the sleep timer paused playback). */
  readonly notice: string | undefined;
  /** False when Web Audio is unavailable: the EQ and spectrum are off, everything else works. */
  readonly engineReady: boolean;
  setSleepTimer(minutes: number): void;
  setSleepEndOfTrack(): void;
  cancelSleep(): void;
  /** Builds the audio graph (first call) and resumes it; call when playback starts or the user opens a visual. */
  activateEngine(): void;
  dismissNotice(): void;
}
export type AudioControlsApi = StoreApi<AudioControlsState> & { dispose(): void };

export const SLEEP_CHOICES_MINUTES = [5, 10, 15, 30, 45, 60, 90] as const;

export interface AudioControlsDependencies {
  readonly audio: AudioElementLike;
  readonly engine: AudioEngine;
  readonly prefs: PrefsStoreApi;
  readonly playback: Pick<PlaybackStoreApi, 'getState' | 'subscribe'>;
  readonly now?: () => number;
  readonly setInterval?: (handler: () => void, ms: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
}

export function createAudioControls(dependencies: AudioControlsDependencies): AudioControlsApi {
  const { audio, engine, prefs, playback } = dependencies;
  const now = dependencies.now ?? Date.now;
  const startTicker = dependencies.setInterval ?? ((handler, ms) => setInterval(handler, ms));
  const stopTicker = dependencies.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  let ticker: unknown;

  const store = createStore<AudioControlsState>((set, get) => {
    const stopTicking = (): void => {
      if (ticker !== undefined) stopTicker(ticker);
      ticker = undefined;
    };
    const fire = (message: string): void => {
      stopTicking();
      set({ sleep: { mode: 'off' }, sleepRemainingMs: 0, notice: message });
      playback.getState().pause();
    };
    const tick = (): void => {
      const sleep = get().sleep;
      if (sleep.mode !== 'timer') return stopTicking();
      const remaining = Math.max(0, sleep.endsAtMs - now());
      if (remaining === 0) return fire('Sleep timer finished - playback paused.');
      set({ sleepRemainingMs: remaining });
    };
    return {
      sleep: { mode: 'off' },
      sleepRemainingMs: 0,
      notice: undefined,
      engineReady: false,
      setSleepTimer(minutes) {
        if (!Number.isFinite(minutes) || minutes <= 0) return get().cancelSleep();
        const clamped = Math.min(600, Math.max(1, Math.round(minutes)));
        stopTicking();
        set({ sleep: { mode: 'timer', minutes: clamped, endsAtMs: now() + clamped * 60_000 }, sleepRemainingMs: clamped * 60_000, notice: undefined });
        ticker = startTicker(tick, 1_000);
      },
      setSleepEndOfTrack() {
        const trackId = playback.getState().session?.current?.track.id;
        if (trackId === undefined) return;
        stopTicking();
        set({ sleep: { mode: 'track', trackId }, sleepRemainingMs: 0, notice: undefined });
      },
      cancelSleep() {
        stopTicking();
        set({ sleep: { mode: 'off' }, sleepRemainingMs: 0 });
      },
      activateEngine() {
        const ready = engine.connect();
        if (ready) {
          engine.resume();
          pushEq();
        }
        if (ready !== get().engineReady) set({ engineReady: ready });
      },
      dismissNotice() {
        set({ notice: undefined });
      },
    };
  });

  function pushEq(): void {
    const { eqEnabled, eqGains } = prefs.getState();
    engine.setGains(eqGains);
    engine.setEqEnabled(eqEnabled);
  }
  function pushSpeed(): void {
    const { speed } = prefs.getState();
    audio.defaultPlaybackRate = speed; // a media element falls back to this on every load
    audio.playbackRate = speed;
    audio.preservesPitch = true;
  }

  pushSpeed();
  const stopPrefs = prefs.subscribe((state, previous) => {
    if (state.speed !== previous.speed) pushSpeed();
    if (state.eqEnabled !== previous.eqEnabled || state.eqGains !== previous.eqGains) pushEq();
  });
  const stopPlayback = playback.subscribe((state, previous) => {
    const id = state.session?.current?.track.id;
    if (id !== previous.session?.current?.track.id) pushSpeed();
    const sleep = store.getState().sleep;
    if (sleep.mode === 'track' && id !== undefined && id !== sleep.trackId) {
      store.setState({ sleep: { mode: 'off' }, notice: 'Paused at the end of the track.' });
      playback.getState().pause();
    }
  });

  return Object.assign(store, {
    dispose() {
      stopPrefs();
      stopPlayback();
      if (ticker !== undefined) stopTicker(ticker);
      ticker = undefined;
    },
  });
}

/** "12:05" or "45 min" style text for the remaining sleep time. */
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
