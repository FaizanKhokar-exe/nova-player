import type { IpcResult, PlaybackCommandResultDto, PlaybackOutcomeDto, PlaybackStateDto, RepeatModeDto, TrackDto } from '@nova/shared';
import { createFakeBridge, failure, ID, result, track, type FakeBridge } from '../library/test-support.js';
import type { AudioLike } from './playback-store.js';

/* Test-only. A scripted stand-in for the browser's <audio> element and DTO builders
 * for the playback channels. Nothing here is imported by application code. */

export { flush, ID, failure, result, track } from '../library/test-support.js';

/**
 * Behaves like the parts of `HTMLAudioElement` the store uses: setting `src`
 * resets position and pauses (the media load algorithm), `currentTime = x`
 * raises `seeked` asynchronously, `play()` flips `paused` and raises `play`.
 * What the browser does by itself over time (decoding, buffering, advancing,
 * ending) is driven explicitly by the `sim*` methods, so tests are
 * deterministic and need no sleeps.
 */
export class FakeAudio extends EventTarget implements AudioLike {
  private time = 0;
  duration = Number.NaN;
  paused = true;
  volume = 1;
  muted = false;
  error: { code: number } | null = null;

  readonly srcHistory: string[] = [];
  playCalls = 0;
  pauseCalls = 0;
  loadCalls = 0;
  /** Make the NEXT play() reject with this error name (then back to normal). */
  rejectNextPlayWith: string | undefined;

  private source = '';

  get currentTime(): number {
    return this.time;
  }
  /** Assigning `currentTime` from outside is a seek; like the browser, `seeked` follows asynchronously. */
  set currentTime(seconds: number) {
    this.time = seconds;
    queueMicrotask(() => this.dispatch('seeked'));
  }
  private readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

  get src(): string {
    return this.source;
  }
  set src(value: string) {
    this.source = value;
    this.srcHistory.push(value);
    this.time = 0;
    this.duration = Number.NaN;
    this.paused = true; // the load algorithm pauses (it raises no `pause` event)
    this.error = null;
  }

  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void {
    if (listener === null) return;
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
    super.addEventListener(type, listener, options);
  }
  override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions): void {
    if (listener !== null) this.listeners.get(type)?.delete(listener);
    super.removeEventListener(type, listener, options);
  }
  /** Total listeners attached right now (a leak detector). */
  listenerCount(type?: string): number {
    return type === undefined ? [...this.listeners.values()].reduce((n, s) => n + s.size, 0) : (this.listeners.get(type)?.size ?? 0);
  }

  play(): Promise<void> {
    this.playCalls += 1;
    if (this.rejectNextPlayWith !== undefined) {
      const name = this.rejectNextPlayWith;
      this.rejectNextPlayWith = undefined;
      return Promise.reject(Object.assign(new Error(name), { name }));
    }
    if (this.paused) {
      this.paused = false;
      this.dispatch('play');
    }
    return Promise.resolve();
  }
  pause(): void {
    this.pauseCalls += 1;
    if (!this.paused) {
      this.paused = true;
      this.dispatch('pause');
    }
  }
  load(): void {
    this.loadCalls += 1;
  }
  removeAttribute(name: string): void {
    if (name === 'src') {
      this.source = '';
      this.time = 0;
      this.duration = Number.NaN;
    }
  }

  dispatch(type: string): void {
    this.dispatchEvent(new Event(type));
  }

  /* --- what the browser would do by itself --- */
  simLoadedMetadata(durationSeconds: number): void {
    this.duration = durationSeconds;
    this.dispatch('loadedmetadata');
    this.dispatch('durationchange');
  }
  simCanPlay(): void {
    this.dispatch('canplay');
  }
  simPlaying(): void {
    this.dispatch('playing');
  }
  /** Playback advances to `seconds` (fractional, like the real thing). */
  simTick(seconds: number): void {
    this.time = seconds; // playback advancing is not a seek
    this.dispatch('timeupdate');
  }
  simWaiting(): void {
    this.dispatch('waiting');
  }
  simEnded(): void {
    this.pause(); // browsers raise `pause` just before `ended`
    this.dispatch('ended');
  }
  simFail(code: number): void {
    this.error = { code };
    this.dispatch('error');
  }
  simVolumeChanged(): void {
    this.dispatch('volumechange');
  }
  /** Loaded, buffered and playing - the normal happy path after `play()`. */
  simStartPlayback(durationSeconds = 180): void {
    this.simLoadedMetadata(durationSeconds);
    this.simCanPlay();
    this.simPlaying();
  }
}

/* ------------------------------ DTO builders ------------------------------ */

export const mediaUrlFor = (t: TrackDto): string => `nova-media://track/${t.id}`;

export function playbackState(overrides: Omit<Partial<PlaybackStateDto>, 'current'> & { current?: TrackDto | undefined } = {}): PlaybackStateDto {
  const { current: currentTrack, ...rest } = overrides;
  return {
    revision: 1,
    ...(currentTrack !== undefined && { current: { track: currentTrack, mediaUrl: mediaUrlFor(currentTrack) } }),
    positionMs: 0,
    repeatMode: 'off',
    shuffle: false,
    queueLength: currentTrack === undefined ? 0 : 3,
    ...(currentTrack !== undefined && { queueIndex: 0 }),
    canNext: currentTrack !== undefined,
    ...rest,
  };
}

export function command(outcome: PlaybackOutcomeDto, state: PlaybackStateDto): IpcResult<PlaybackCommandResultDto> {
  return result({ outcome, state });
}

export interface PlaybackFakes {
  readonly bridge: FakeBridge;
  readonly audio: FakeAudio;
  /** The state the fake main process currently holds (getState answers with it). */
  backend: { state: PlaybackStateDto; diagnosis: { problem?: string } | 'fail' };
  /** Every channel call, in order, for just the playback channels. */
  playbackCalls(): { channel: string; request: unknown }[];
}

/** A fake bridge with scripted `playback:*` answers and a fake audio element. Override any
 *  channel afterwards with `bridge.on(channel, handler)`. */
export function createPlaybackFakes(initial: PlaybackStateDto = playbackState(), library: Parameters<typeof createFakeBridge>[0] = {}): PlaybackFakes {
  const bridge = createFakeBridge(library);
  const audio = new FakeAudio();
  const fakes: PlaybackFakes = {
    bridge,
    audio,
    backend: { state: initial, diagnosis: {} },
    playbackCalls: () => bridge.calls.filter((c) => c.channel.startsWith('playback:')),
  };
  bridge.on('playback:getState', () => result(fakes.backend.state));
  bridge.on('playback:playTrack', () => command('started', fakes.backend.state));
  bridge.on('playback:next', () => command('started', fakes.backend.state));
  bridge.on('playback:previous', () => command('started', fakes.backend.state));
  bridge.on('playback:trackFinished', () => command('started', fakes.backend.state));
  bridge.on('playback:setRepeatMode', (r) => result((fakes.backend.state = { ...fakes.backend.state, revision: fakes.backend.state.revision + 1, repeatMode: (r as { mode: RepeatModeDto }).mode })));
  bridge.on('playback:setShuffle', (r) => result((fakes.backend.state = { ...fakes.backend.state, revision: fakes.backend.state.revision + 1, shuffle: (r as { enabled: boolean }).enabled })));
  bridge.on('playback:reportPosition', () => result({ saved: true }));
  bridge.on('playback:diagnoseSource', () => (fakes.backend.diagnosis === 'fail' ? failure('internal', 'x') : result(fakes.backend.diagnosis)));
  return fakes;
}

void ID;
void track;
