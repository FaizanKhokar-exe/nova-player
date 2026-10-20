import { createStore, type StoreApi } from 'zustand/vanilla';
import { createProfileLoader } from './energy-profile.js';
import type {
  IpcRequest,
  IpcResponse,
  MediaProblemDto,
  NovaBridge,
  PlaybackCommandResultDto,
  PlaybackContextDto,
  PlaybackIpcContract,
  PlaybackStateDto,
  QueueDto,
  RepeatModeDto,
  EnqueuePosition,
  GroupRefDto,
  ListSourceDto,
  TrackSortDto,
} from '@nova/shared';

/**
 * Renderer state for playback (Phase 4).
 *
 * Who owns what:
 *  - The native `<audio>` element owns playback itself: whether it is playing,
 *    where it is, how long the file is, the volume. This store LISTENS to its
 *    events and copies what the UI needs; it does not simulate a player, and
 *    it never polls.
 *  - The main process owns the queue. Every rule about what plays next -
 *    next/previous, repeat, shuffle, what happens when a track ends - runs
 *    there, in the Phase 1 domain code. This store sends the user's intent
 *    over the typed `playback:*` channels and carries out the answer
 *    (`started` / `restart` / `stop` / `none`). No queue logic lives here.
 *
 * It is created by a factory from a `NovaBridge` and an audio element (so
 * there is no global instance and tests inject fakes), is separate from the
 * library store, and holds no lyrics/playlist/settings state.
 *
 * Units: the domain's playback position is whole MILLISECONDS; the browser's
 * `currentTime` is fractional seconds. The conversion happens only here, in
 * `toMs` / `audio.currentTime = ms / 1000`.
 *
 * Performance: the position changes ~4 times a second, so it lives in its own
 * tiny store (`positionStore`) that only the progress display subscribes to.
 * Nothing that renders the track list ever sees it.
 */

/** The slice of `HTMLAudioElement` the store uses. The real element satisfies it;
 *  tests supply a scripted one. */
export interface AudioLike extends EventTarget {
  src: string;
  currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  volume: number;
  muted: boolean;
  readonly error: { readonly code: number } | null;
  play(): Promise<void>;
  pause(): void;
  load(): void;
  removeAttribute(name: string): void;
}

/** Why playback cannot continue, in words fit for the user. Never contains a path. */
export interface PlaybackUiError {
  readonly message: string;
  /** The track it concerns, when it concerns one. */
  readonly trackId: string | undefined;
  /** Whether trying again can help (the source failed, as opposed to a refused command). */
  readonly retryable: boolean;
}

export interface EngineState {
  /** The current source has loaded its metadata, so seeking is possible. */
  readonly loaded: boolean;
  /** The audio element is playing (follows its `play`/`pause`/`ended` events). */
  readonly playing: boolean;
  /** Waiting for data: loading a source, or stalled mid-play. */
  readonly buffering: boolean;
  readonly durationMs: number | undefined;
  readonly volume: number;
  readonly muted: boolean;
}

export interface PositionState {
  readonly positionMs: number;
}
export type PositionStoreApi = StoreApi<PositionState>;

/** The queue panel's data: a WINDOW onto main's queue (a few tracks before the current one,
 *  then the upcoming ones), never the whole queue - it can hold the entire library. */
export interface QueueSlice {
  /** The panel is showing; the window is only kept fresh while it is. */
  readonly open: boolean;
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  readonly window: QueueDto | undefined;
  /** How many upcoming tracks are requested ("Show more" raises it). */
  readonly upcomingLimit: number;
  readonly error: string | undefined;
}

export const QUEUE_HISTORY = 20;
export const QUEUE_PAGE = 200;
const QUEUE_MAX_REQUEST = 1_000;

export interface PlaybackState {
  readonly connection: 'disconnected' | 'loading' | 'ready' | 'failed';
  /** A mirror of the main process's playback state: current track, modes, queue size. */
  readonly session: PlaybackStateDto | undefined;
  readonly engine: EngineState;
  readonly error: PlaybackUiError | undefined;
  /** A non-error remark (e.g. the playing track left the library). */
  readonly notice: string | undefined;
  /** High-frequency position, kept apart on purpose. */
  readonly positionStore: PositionStoreApi;
  readonly queue: QueueSlice;
}

export interface PlaybackActions {
  /** Subscribes to main's playback events and the audio element, and restores the saved session
   *  (paused). Reference-counted, like the library store's `connect`. Returns the undo function. */
  connect(): () => void;
  /** Plays `trackId`, queueing the given list (default: the whole library). */
  playTrack(trackId: string, context?: PlaybackContextDto): Promise<void>;
  /** Play when paused, pause when playing; retries a failed source. */
  togglePlay(): void;
  pause(): void;
  next(): Promise<void>;
  previous(): Promise<void>;
  /** Seeks to a position in whole milliseconds. */
  seekMs(positionMs: number): void;
  /** Loudness per slice of the CURRENT song (for the seek-bar hover preview); undefined when it cannot be analysed. */
  energyProfile(): Promise<readonly number[] | undefined>;
  /** 0..1. Raising the volume above 0 also un-mutes. */
  setVolume(volume: number): void;
  toggleMute(): void;
  setRepeatMode(mode: RepeatModeDto): Promise<void>;
  cycleRepeatMode(): Promise<void>;
  setShuffle(enabled: boolean): Promise<void>;
  dismissError(): void;
  dismissNotice(): void;
  reload(): Promise<void>;
  /**
   * Saves the current position now (the page is being hidden or closed). While playing the position is only
   * checkpointed every few seconds, so without this a window closed mid-song lost up to that long. Nothing
   * is saved while a restored position is still waiting to be applied (the element would report 0).
   */
  flushPosition(): void;

  /** Replaces the queue with an album / artist / genre (optionally in the order the user sorted it) and plays it. */
  playGroup(group: GroupRefDto, sort?: TrackSortDto): Promise<void>;
  /** Adds a track or a whole group after the current track (`next`) or at the end (`last`).
   *  `label` is only for the confirmation the user sees. */
  enqueue(request: { readonly position: EnqueuePosition; readonly trackId?: string; readonly group?: GroupRefDto; readonly source?: ListSourceDto }, label?: string): Promise<void>;
  /** Replaces the queue with favourites / recently played / a playlist and plays it (optionally from one track, optionally shuffled). */
  playList(source: ListSourceDto, options?: { readonly startTrackId?: string; readonly shuffle?: boolean }): Promise<void>;
  /** Shows / hides the queue panel; the window is loaded while it is showing. */
  setQueueOpen(open: boolean): void;
  loadMoreQueue(): void;
  retryQueue(): void;
  /** Queue edits name the item by position AND track id, so a stale view can never hit the wrong track. */
  playQueueItem(index: number, trackId: string): Promise<void>;
  removeFromQueue(index: number, trackId: string): Promise<void>;
  moveQueueItem(index: number, trackId: string, toIndex: number): Promise<void>;
  /** Empties the queue except the current track (main decides; see the domain rule `clearQueue`). */
  clearQueue(): Promise<void>;
}

export type PlaybackStore = PlaybackState & PlaybackActions;
export type PlaybackStoreApi = StoreApi<PlaybackStore>;

export interface PlaybackStoreOptions {
  /** Minimum time between position saves while playing. Default 5 000 ms. */
  readonly positionSaveIntervalMs?: number;
  /** Clock, for the save throttle. Default `Date.now`. */
  readonly now?: () => number;
}

type PlaybackChannel = keyof PlaybackIpcContract | 'playback:playList';

const MEDIA_ERR_ABORTED = 1;
const MEDIA_ERR_NETWORK = 2;
const MEDIA_ERR_DECODE = 3;
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

const PROBLEM_MESSAGES: Record<MediaProblemDto, string> = {
  'file-missing': "This file can't be found. It may have been moved or deleted.",
  'folder-unavailable': "The folder this track is in isn't available right now. Is the drive connected?",
  'file-inaccessible': "Nova Player can't open this file.",
  'not-in-library': 'This track is no longer in your library.',
  'unsupported-format': "This type of file can't be played.",
  'invalid-source': "This track can't be played.",
};

/** What to say when main CAN open the file but the browser's decoder still failed. */
function decoderMessage(code: number | undefined): string {
  switch (code) {
    case MEDIA_ERR_SRC_NOT_SUPPORTED:
      return "This audio format isn't supported by the player.";
    case MEDIA_ERR_DECODE:
      return 'This file looks damaged and could not be decoded.';
    case MEDIA_ERR_NETWORK:
      return 'This file could not be read.';
    default:
      return "This track can't be played.";
  }
}

const REPEAT_CYCLE: Record<RepeatModeDto, RepeatModeDto> = { off: 'all', all: 'one', one: 'off' };

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1;
}

/** Seconds (fractional, as the browser reports) to whole milliseconds. */
function toMs(seconds: number): number {
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0;
}

export function createPlaybackStore(bridge: NovaBridge, audio: AudioLike, options: PlaybackStoreOptions = {}): PlaybackStoreApi {
  const loadProfile = createProfileLoader();
  const saveIntervalMs = options.positionSaveIntervalMs ?? 5_000;
  const now = options.now ?? Date.now;
  const positionStore = createStore<PositionState>(() => ({ positionMs: 0 }));

  async function call<K extends PlaybackChannel>(
    channel: K,
    request: IpcRequest<K>,
  ): Promise<IpcResponse<K> | { readonly ok: false; readonly error: { readonly code: 'unavailable'; readonly message: string; readonly operation: string } }> {
    try {
      return await bridge.invoke(channel, request);
    } catch {
      return { ok: false, error: { code: 'unavailable', message: 'Could not reach the application. Try restarting Nova Player.', operation: channel } };
    }
  }

  return createStore<PlaybackStore>((set, get) => {
    let connections = 0;
    let generation = 0; // bumped on every 0 -> 1 connect; discards a stale initial load
    let unsubscribers: (() => void)[] = [];
    let audioListeners: Array<readonly [string, EventListener]> = [];

    /** The track currently loaded into the audio element (not necessarily main's "current" yet). */
    let loadedTrackId: string | undefined;
    /** A position to seek to as soon as the loaded source has metadata (a restored session). */
    let pendingSeekMs: number | undefined;
    /** Newest user command wins: a response older than the latest command is not applied. */
    let commandSequence = 0;
    let lastRevision = -1;
    let queueSequence = 0;
    let lastSavedAt = Number.NEGATIVE_INFINITY;

    const setEngine = (patch: Partial<EngineState>): void => set((s) => ({ engine: { ...s.engine, ...patch } }));
    const currentTrackIdOfSession = (): string | undefined => get().session?.current?.track.id;
    const positionMs = (): number => toMs(audio.currentTime);
    const setPosition = (ms: number): void => {
      if (positionStore.getState().positionMs !== ms) positionStore.setState({ positionMs: ms });
    };

    /* ------------------------- position persistence ------------------------- */

    function savePosition(force: boolean): void {
      const trackId = loadedTrackId;
      if (trackId === undefined) return;
      const time = now();
      if (!force && time - lastSavedAt < saveIntervalMs) return;
      lastSavedAt = time;
      // Fire and forget: a failed save must never interrupt the music.
      void call('playback:reportPosition', { trackId, positionMs: positionMs() }).catch(() => undefined);
    }

    /* ------------------------------ the engine ------------------------------ */

    function durationMsFor(fallbackSeconds: number | undefined): number | undefined {
      if (Number.isFinite(audio.duration) && audio.duration > 0) return toMs(audio.duration);
      return fallbackSeconds === undefined ? undefined : toMs(fallbackSeconds);
    }

    function startPlaying(): void {
      void audio.play().catch((error: unknown) => {
        // An interrupted play() (a newer load or a pause) is normal. A real failure
        // also raises the element's `error` event, which is where it is reported.
        const name = error instanceof Error ? error.name : '';
        if (name === 'NotAllowedError') {
          set({ error: { message: 'Playback was blocked. Press Play to start.', trackId: loadedTrackId, retryable: false } });
        }
      });
    }

    /** Loads a source into the element. `autoplay` decides whether it starts. */
    function loadSource(current: NonNullable<PlaybackStateDto['current']>, autoplay: boolean, startAtMs: number): void {
      loadedTrackId = current.track.id;
      pendingSeekMs = startAtMs > 0 ? startAtMs : undefined;
      lastSavedAt = Number.NEGATIVE_INFINITY;
      set({ error: undefined });
      setEngine({ loaded: false, playing: false, buffering: true, durationMs: durationMsFor(current.track.durationSeconds) });
      setPosition(startAtMs);
      audio.src = current.mediaUrl;
      if (autoplay) startPlaying();
    }

    function unloadSource(): void {
      loadedTrackId = undefined;
      pendingSeekMs = undefined;
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      setEngine({ loaded: false, playing: false, buffering: false, durationMs: undefined });
      setPosition(0);
    }

    /** Re-reads the queue window (only while the panel is open, and only when main's revision moved). */
    async function refreshQueue(force = false): Promise<void> {
      const { queue, session } = get();
      if (!queue.open) return;
      if (!force && queue.window !== undefined && session !== undefined && queue.window.revision === session.revision && queue.status === 'ready') return;
      const sequence = ++queueSequence;
      const index = session?.queueIndex ?? 0;
      const offset = Math.max(0, index - QUEUE_HISTORY);
      const limit = Math.min(QUEUE_MAX_REQUEST, index - offset + 1 + queue.upcomingLimit);
      // The list stays on screen while it is refreshed: loading is shown only when there is nothing yet.
      if (queue.window === undefined) set((s) => ({ queue: { ...s.queue, status: 'loading', error: undefined } }));
      const result = await call('playback:getQueue', { offset, limit });
      if (sequence !== queueSequence) return;
      if (result.ok) set((s) => ({ queue: { ...s.queue, status: 'ready', window: result.value, error: undefined } }));
      else set((s) => ({ queue: { ...s.queue, status: 'error', error: result.error.message } }));
    }

    /** Brings the audio element in line with the session main just reported. */
    function applySession(state: PlaybackStateDto, outcome: PlaybackCommandResultDto['outcome'] | 'sync'): void {
      if (state.revision < lastRevision) return; // an older snapshot overtaken by a newer one
      lastRevision = state.revision;
      set({ session: state });
      if (get().queue.open) void refreshQueue();

      const current = state.current;
      if (current === undefined) {
        if (loadedTrackId !== undefined) unloadSource();
        return;
      }

      const wasPlaying = !audio.paused;
      switch (outcome) {
        case 'restart':
          // The same track again (repeat-one, or Previous past the threshold).
          if (loadedTrackId === current.track.id) {
            audio.currentTime = 0;
            setPosition(0);
            startPlaying();
          } else loadSource(current, true, 0);
          return;
        case 'stop':
          // The queue ran out: stay on the track, stopped, at the start.
          audio.pause();
          if (loadedTrackId === current.track.id) {
            audio.currentTime = 0;
            setEngine({ playing: false, buffering: false });
            setPosition(0);
          } else loadSource(current, false, 0);
          return;
        case 'started':
          // A queue change that starts a track. Even the SAME track starts over (double-clicking it).
          if (loadedTrackId === current.track.id) {
            audio.currentTime = 0;
            setPosition(0);
            startPlaying();
          } else loadSource(current, true, 0);
          return;
        case 'none':
        case 'sync':
          // Nothing to do unless the element is not on main's current track (a superseded
          // command, or main moved on by itself): then follow main, keeping the play/pause state.
          if (loadedTrackId !== current.track.id) loadSource(current, outcome === 'none' && wasPlaying, 0);
          return;
      }
    }

    /* ------------------------- audio element events ------------------------- */

    async function reportMediaError(): Promise<void> {
      const mediaError = audio.error;
      if (mediaError?.code === MEDIA_ERR_ABORTED) return; // we replaced the source ourselves
      const trackId = loadedTrackId;
      if (trackId === undefined) return;
      setEngine({ playing: false, buffering: false });
      // Ask main WHY: it knows about missing files, unplugged folders and refused paths;
      // the browser only says "could not load".
      const diagnosis = await call('playback:diagnoseSource', { trackId });
      if (loadedTrackId !== trackId) return; // a newer track took over while we asked
      const problem = diagnosis.ok ? diagnosis.value.problem : undefined;
      set({
        error: {
          message: problem !== undefined ? PROBLEM_MESSAGES[problem] : decoderMessage(mediaError?.code),
          trackId,
          retryable: true,
        },
      });
    }

    async function trackEnded(): Promise<void> {
      const endedId = loadedTrackId;
      if (endedId === undefined) return;
      savePositionAtEnd();
      setEngine({ playing: false, buffering: false });
      const sequence = ++commandSequence;
      const result = await call('playback:trackFinished', { trackId: endedId });
      if (sequence !== commandSequence) return; // the user took over while main decided
      if (!result.ok) {
        set({ error: { message: result.error.message, trackId: endedId, retryable: false } });
        return;
      }
      applySession(result.value.state, result.value.outcome);
    }

    function savePositionAtEnd(): void {
      // The track is over: main resets the saved position itself (trackFinished). Nothing to save.
      lastSavedAt = now();
    }

    function attachAudioListeners(): void {
      const on = (type: string, listener: () => void): void => {
        const handler: EventListener = () => listener();
        audio.addEventListener(type, handler);
        audioListeners.push([type, handler]);
      };

      on('loadedmetadata', () => {
        const session = get().session;
        setEngine({ loaded: true, durationMs: durationMsFor(session?.current?.track.durationSeconds) });
        if (pendingSeekMs !== undefined) {
          audio.currentTime = pendingSeekMs / 1000; // a restored position
          setPosition(pendingSeekMs);
          pendingSeekMs = undefined;
        }
      });
      on('durationchange', () => setEngine({ durationMs: durationMsFor(get().session?.current?.track.durationSeconds) }));
      on('canplay', () => setEngine({ buffering: false }));
      on('play', () => setEngine({ playing: true }));
      on('playing', () => setEngine({ playing: true, buffering: false }));
      on('waiting', () => setEngine({ buffering: true }));
      on('pause', () => {
        // Also fires just before `ended`; trackEnded() handles that case itself.
        setEngine({ playing: false, buffering: false });
        savePosition(true);
      });
      on('timeupdate', () => {
        setPosition(positionMs());
        if (!audio.paused) savePosition(false);
      });
      on('seeked', () => {
        setPosition(positionMs());
        savePosition(true);
      });
      on('ended', () => void trackEnded());
      on('error', () => void reportMediaError());
      on('volumechange', () => setEngine({ volume: clamp01(audio.volume), muted: audio.muted }));
    }

    function detachAudioListeners(): void {
      for (const [type, handler] of audioListeners) audio.removeEventListener(type, handler);
      audioListeners = [];
    }

    /* ------------------------------ main events ----------------------------- */

    function subscribeToEvents(): (() => void)[] {
      return [
        bridge.subscribe('playback:stateChanged', (event) => {
          const before = currentTrackIdOfSession();
          applySession(event.state, 'sync');
          if (event.reason === 'track-removed' && before !== undefined && event.state.current?.track.id !== before) {
            // Do not leave the UI claiming the removed track is playing: the element was
            // pointed at what main now calls current, but paused; or unloaded if nothing is left.
            audio.pause();
            set({ notice: 'The track that was playing is no longer in your library.' });
          }
        }),
        // Phase 7: the tray / media keys. Main only names the command; it runs through the very
        // same store actions as the on-screen buttons (so Next/Previous still go through main's
        // queue rules with the real position, and Previous keeps the restart threshold).
        bridge.subscribe('shell:command', (event) => {
          if (event.command === 'toggle-play') get().togglePlay();
          else if (event.command === 'next') void get().next();
          else if (event.command === 'previous') void get().previous();
        }),
      ];
    }

    async function loadInitial(forGeneration: number): Promise<void> {
      set({ connection: 'loading' });
      const result = await call('playback:getState', undefined);
      if (forGeneration !== generation) return; // disconnected (or reconnected) meanwhile
      if (!result.ok) {
        set({ connection: 'failed', error: { message: result.error.message, trackId: undefined, retryable: false } });
        return;
      }
      const state = result.value;
      set({ connection: 'ready', error: undefined });
      // A newer snapshot may already have arrived as an event while this request was in flight.
      if (state.revision < lastRevision) return;
      lastRevision = state.revision;
      set({ session: state });
      if (state.current !== undefined) loadSource(state.current, false, state.positionMs); // restored, paused
    }

    /**
     * Retries the current track from where it was. The source address is asked of main again first:
     * after a failure main hands out the same track under a fresh address, because the browser
     * remembers a failed load per address and would otherwise refuse the retry without asking
     * (an unplugged drive that was reconnected would stay "broken" for several seconds).
     */
    async function retryCurrent(): Promise<void> {
      const stale = get().session?.current;
      if (stale === undefined) return;
      const resumeAtMs = Math.max(positionMs(), positionStore.getState().positionMs);
      const sequence = ++commandSequence;
      const fresh = await call('playback:getState', undefined);
      if (sequence !== commandSequence) return; // the user did something else meanwhile
      if (fresh.ok && fresh.value.revision >= lastRevision) {
        lastRevision = fresh.value.revision;
        set({ session: fresh.value });
      }
      const target = get().session?.current ?? stale;
      loadSource(target, true, target.track.id === stale.track.id ? resumeAtMs : 0);
    }

    /* -------------------------------- actions ------------------------------- */

    async function runCommand(invokeCommand: () => Promise<{ readonly ok: true; readonly value: PlaybackCommandResultDto } | { readonly ok: false; readonly error: { readonly message: string } }>): Promise<void> {
      const sequence = ++commandSequence;
      savePosition(true); // the track we are leaving keeps its position
      const result = await invokeCommand();
      if (sequence !== commandSequence) return; // a newer command superseded this one
      if (!result.ok) {
        set({ error: { message: result.error.message, trackId: loadedTrackId, retryable: false } });
        return;
      }
      set({ notice: undefined });
      applySession(result.value.state, result.value.outcome);
    }

    return {
      connection: 'disconnected',
      session: undefined,
      engine: { loaded: false, playing: false, buffering: false, durationMs: undefined, volume: clamp01(audio.volume), muted: audio.muted },
      error: undefined,
      notice: undefined,
      positionStore,
      queue: { open: false, status: 'idle', window: undefined, upcomingLimit: QUEUE_PAGE, error: undefined },

      connect() {
        connections += 1;
        if (connections === 1) {
          generation += 1;
          unsubscribers = subscribeToEvents();
          attachAudioListeners();
          void loadInitial(generation);
        }
        let released = false;
        return () => {
          if (released) return;
          released = true;
          connections -= 1;
          if (connections === 0) {
            savePosition(true);
            for (const unsubscribe of unsubscribers) unsubscribe();
            unsubscribers = [];
            detachAudioListeners();
            generation += 1; // an in-flight initial load must not touch a torn-down store
            audio.pause();
            loadedTrackId = undefined;
            lastRevision = -1;
            set({ connection: 'disconnected' });
          }
        };
      },

      reload: () => loadInitial(generation),

      flushPosition() {
        if (pendingSeekMs === undefined) savePosition(true);
      },

      playTrack(trackId, context) {
        return runCommand(() => call('playback:playTrack', context === undefined ? { trackId } : { trackId, context }));
      },

      togglePlay() {
        const current = get().session?.current;
        if (current === undefined) return;
        // A failed source comes first: after a media error the element can still report
        // `paused === false`, but the button shows "Play" - and pressing it must retry, not pause.
        if (get().error !== undefined || loadedTrackId !== current.track.id) {
          void retryCurrent();
          return;
        }
        if (!audio.paused) {
          audio.pause();
          return;
        }
        startPlaying();
      },

      pause() {
        audio.pause();
      },

      next() {
        if (get().session?.current === undefined) return Promise.resolve();
        return runCommand(() => call('playback:next', { positionMs: positionMs() }));
      },

      previous() {
        if (get().session?.current === undefined) return Promise.resolve();
        return runCommand(() => call('playback:previous', { positionMs: positionMs() }));
      },

      energyProfile() {
        const current = get().session?.current;
        return current === undefined ? Promise.resolve(undefined) : loadProfile(current.track.id, current.mediaUrl);
      },

      seekMs(target) {
        if (!get().engine.loaded) return;
        const duration = get().engine.durationMs;
        const clamped = Math.max(0, duration === undefined ? target : Math.min(target, duration));
        const whole = Math.round(clamped);
        audio.currentTime = whole / 1000;
        setPosition(whole);
      },

      setVolume(volume) {
        const value = clamp01(volume);
        audio.volume = value;
        if (value > 0 && audio.muted) audio.muted = false;
      },

      toggleMute() {
        audio.muted = !audio.muted;
      },

      async setRepeatMode(mode) {
        const result = await call('playback:setRepeatMode', { mode });
        if (result.ok) applySession(result.value, 'sync');
        else set({ error: { message: result.error.message, trackId: undefined, retryable: false } });
      },

      async cycleRepeatMode() {
        const mode = get().session?.repeatMode ?? 'off';
        await get().setRepeatMode(REPEAT_CYCLE[mode]);
      },

      async setShuffle(enabled) {
        const result = await call('playback:setShuffle', { enabled });
        if (result.ok) applySession(result.value, 'sync');
        else set({ error: { message: result.error.message, trackId: undefined, retryable: false } });
      },

      playGroup(group, sort) {
        return runCommand(() => call('playback:playGroup', sort === undefined ? { group } : { group, sort }));
      },

      playList(source, options = {}) {
        return runCommand(() =>
          call('playback:playList', {
            source,
            ...(options.startTrackId !== undefined && { startTrackId: options.startTrackId }),
            ...(options.shuffle !== undefined && { shuffle: options.shuffle }),
          }),
        );
      },

      async enqueue(request, label) {
        const result = await call('playback:enqueue', request);
        if (!result.ok) {
          set({ error: { message: result.error.message, trackId: undefined, retryable: false } });
          return;
        }
        applySession(result.value.state, 'none');
        const what = label ?? 'Tracks';
        set({ notice: request.position === 'next' ? `${what} will play next.` : `${what} added to the queue.` });
      },

      setQueueOpen(open) {
        if (get().queue.open === open) return;
        set((s) => ({ queue: { ...s.queue, open, ...(open ? {} : { status: 'idle' as const, window: undefined, upcomingLimit: QUEUE_PAGE }) } }));
        if (open) void refreshQueue(true);
      },

      loadMoreQueue() {
        set((s) => ({ queue: { ...s.queue, upcomingLimit: Math.min(s.queue.upcomingLimit + QUEUE_PAGE, QUEUE_MAX_REQUEST - QUEUE_HISTORY - 1) } }));
        void refreshQueue(true);
      },

      retryQueue() {
        void refreshQueue(true);
      },

      playQueueItem(index, trackId) {
        return runCommand(() => call('playback:playQueueItem', { index, trackId }));
      },

      removeFromQueue(index, trackId) {
        return runCommand(() => call('playback:removeFromQueue', { index, trackId }));
      },

      moveQueueItem(index, trackId, toIndex) {
        return runCommand(() => call('playback:moveQueueItem', { index, trackId, toIndex }));
      },

      clearQueue() {
        return runCommand(() => call('playback:clearQueue', undefined));
      },

      dismissError() {
        set({ error: undefined });
      },
      dismissNotice() {
        set({ notice: undefined });
      },
    };
  });
}
