import {
  EMPTY_QUEUE,
  appendToQueue,
  clearQueue as clearQueueRule,
  decideOnNextPressed,
  decideOnPreviousPressed,
  decideOnTrackFinished,
  disableShuffle,
  enableShuffle,
  getCurrentTrackId,
  isShuffleEnabled,
  jumpToIndex,
  parseTrackId,
  playNext,
  removeFromQueue,
  reorderQueue,
  replaceQueue,
  setRepeatMode as setQueueRepeatMode,
  type PlaybackDecision,
  type PlaybackSessionRepository,
  type QueueState,
  type RandomSource,
  type RepeatMode,
  type GroupKind,
  type Track,
  type TrackId,
  type TrackRepository,
  type TrackSort,
} from '@nova/domain';
import type { MediaAccess, MediaDenial } from '../media/media-access.js';
import { buildTrackMediaUrl, MAX_SOURCE_VERSION } from '../media/media-url.js';
import type { LibraryApplication } from './library-application.js';
import type { CollectionsApplication, ListSource } from './collections-application.js';

/* ------------------------------------------------------------------ *
 * Views: plain data with no infrastructure types. NOT the IPC DTOs - the
 * desktop main process maps them (the explicit renderer boundary).
 * ------------------------------------------------------------------ */

export interface PlaybackStateView {
  /** Bumped by every change of the queue, current track or modes (not by position reports). */
  readonly revision: number;
  readonly current: { readonly track: Track; readonly mediaUrl: string } | undefined;
  /** Whole milliseconds into the current track, as last reported. */
  readonly positionMs: number;
  readonly repeatMode: RepeatMode;
  readonly shuffle: boolean;
  readonly queueLength: number;
  readonly queueIndex: number | undefined;
  /** Whether Next would go anywhere, per the domain rules. */
  readonly canNext: boolean;
}

/** What the player must do about the new state - see `PlaybackOutcomeDto`. */
export type PlaybackOutcome = 'started' | 'restart' | 'stop' | 'none';

export interface PlaybackCommandResult {
  readonly outcome: PlaybackOutcome;
  readonly state: PlaybackStateView;
}

/** Where the queue is built from: always the list the user is looking at, in the order it is shown. */
export type PlaybackContext =
  | { readonly kind: 'library'; readonly sort?: TrackSort }
  | { readonly kind: 'search'; readonly query: string }
  | { readonly kind: 'group'; readonly group: { readonly kind: GroupKind; readonly key: string }; readonly sort?: TrackSort }
  /** Phase 11: favourites, recently played or a playlist, in the order the listener sees it. */
  | { readonly kind: 'list'; readonly source: ListSource };

export interface QueueItemView {
  /** Absolute position in the queue (0-based). */
  readonly position: number;
  readonly track: Track;
}

/** A window onto the queue (the queue can hold the whole library). */
export interface QueueView {
  readonly revision: number;
  readonly total: number;
  readonly currentIndex: number | undefined;
  readonly offset: number;
  readonly items: readonly QueueItemView[];
}

export interface EnqueueCommandResult extends PlaybackCommandResult {
  /** How many tracks were added. */
  readonly added: number;
}

export type PlaybackChangeReason = 'library-changed' | 'track-removed';

/**
 * Events main-process code can subscribe to.
 *  - `state-changed`: main changed the playback state on its own (a library change). Forwarded to the renderer.
 *  - `track-started` (Phase 7): a COMMAND started a track (play, play group, queue jump, Next/Previous,
 *    a track ending into the next one). It is the one reliable "a track was started" signal - the
 *    renderer only learns it from the command's reply - and it is used by the desktop shell (notifications).
 *    It is NOT sent for a restart of the same track (repeat one, Previous past the threshold), for a
 *    restored session at launch, or for queue edits. It is not forwarded to the renderer.
 */
export type PlaybackApplicationEvent =
  | { readonly type: 'state-changed'; readonly reason: PlaybackChangeReason; readonly state: PlaybackStateView }
  | { readonly type: 'track-started'; readonly state: PlaybackStateView };

/**
 * Phase 11: what happened to the CURRENT track, for main-process code that reacts to listening (the play-history
 * recorder). The renderer already reports these facts through `playback:reportPosition` / `playback:trackFinished`
 * and the commands; they are re-published here - separately from `subscribe`, whose events describe state changes
 * for the renderer and the shell - so no extra IPC channel is needed. Never forwarded to the renderer.
 */
export type PlaybackActivityEvent =
  | { readonly type: 'track-started'; readonly trackId: string }
  | { readonly type: 'position-reported'; readonly trackId: string; readonly positionMs: number }
  | { readonly type: 'track-finished'; readonly trackId: string };

export type PlaybackApplicationErrorCode = 'track-not-found';

export class PlaybackApplicationError extends Error {
  readonly code: PlaybackApplicationErrorCode;
  constructor(code: PlaybackApplicationErrorCode, message: string) {
    super(message);
    this.name = 'PlaybackApplicationError';
    this.code = code;
  }
}

/* ------------------------------------------------------------------ *
 * The service
 * ------------------------------------------------------------------ */

export interface PlaybackApplication {
  getState(): PlaybackStateView;
  /** Replaces the queue with `context` (default: the whole library) and makes `trackId` current.
   *  @throws PlaybackApplicationError `track-not-found` */
  playTrack(request: { readonly trackId: string; readonly context?: PlaybackContext }): PlaybackCommandResult;
  /**
   * Phase 11: replaces the queue with a whole list (favourites, history, a playlist) and starts it: at
   * `startTrackId` (must be in the list), else at the first track - or at a random one when `shuffle`.
   * `shuffle: true` turns shuffle on first; otherwise the listener's current modes are kept.
   * @throws PlaybackApplicationError `track-not-found` (empty list, or `startTrackId` not in it) | CollectionsApplicationError `playlist-not-found`
   */
  playList(request: { readonly source: ListSource; readonly startTrackId?: string; readonly shuffle?: boolean }): PlaybackCommandResult;
  /** Replaces the queue with an album/artist/genre (natural order, or `sort`) and starts its first track.
   *  @throws LibraryApplicationError `group-not-found` */
  playGroup(request: { readonly group: { readonly kind: GroupKind; readonly key: string }; readonly sort?: TrackSort }): PlaybackCommandResult;

  /**
   * Adds a track or a whole group to the queue: right after the current track (`next`) or at the
   * end (`last`). The queue is a deliberate snapshot: it changes ONLY through commands like this
   * one. A library change never adds to it (new files appear in the library, not in a queue the
   * user already built); it only prunes tracks that no longer exist.
   * @throws PlaybackApplicationError `track-not-found` | LibraryApplicationError `group-not-found`
   */
  enqueue(request: { readonly position: 'next' | 'last'; readonly trackId?: string; readonly group?: { readonly kind: GroupKind; readonly key: string }; readonly source?: ListSource }): EnqueueCommandResult;

  /** A window onto the queue: positions `offset` ... `offset + limit - 1`. */
  getQueue(request?: { readonly offset?: number; readonly limit?: number }): QueueView;

  /** Jumps to a queued track and starts it. A no-op when `trackId` is not at `index` (a stale click). */
  playQueueItem(index: number, trackId: string): PlaybackCommandResult;
  /** Removes one queued track. Removing the current one plays what would have played next
   *  (the Phase 1 rule); the modes are untouched. A no-op when `trackId` is not at `index`. */
  removeFromQueue(index: number, trackId: string): PlaybackCommandResult;
  /** Moves a queued track. Which track is current never changes. A no-op when `trackId` is not at `index`. */
  moveQueueItem(index: number, trackId: string, toIndex: number): PlaybackCommandResult;
  /** Empties the queue except the current track, which keeps playing (Phase 5 domain rule `clearQueue`). */
  clearQueue(): PlaybackCommandResult;

  /** The user pressed Next. `positionMs` is where playback is now. */
  next(positionMs: number): PlaybackCommandResult;
  /** The user pressed Previous. At or past the domain's restart threshold - and on the very first
   *  track, where the domain reports "no previous track" - this restarts the current track. */
  previous(positionMs: number): PlaybackCommandResult;
  /** The current track ended on its own. Reports about any other track are ignored (`none`). */
  trackFinished(trackId: string): PlaybackCommandResult;
  setRepeatMode(mode: RepeatMode): PlaybackStateView;
  setShuffle(enabled: boolean): PlaybackStateView;
  /** Records the current position (whole ms). Ignored (`saved: false`) for a track that is not current. */
  reportPosition(trackId: string, positionMs: number): { readonly saved: boolean };
  /** Why this track's media cannot be opened, or `undefined` if it can. Also refreshes the media URL
   *  handed out for the current track, so a retry is a genuinely new request. */
  diagnoseSource(trackId: string): Promise<MediaDenial | undefined>;
  /** Re-checks the queue against the library: drops tracks that are gone and refreshes what changed. */
  reconcileLibrary(): void;
  subscribe(listener: (event: PlaybackApplicationEvent) => void): () => void;
  /** Phase 11: listening activity of the current track (see `PlaybackActivityEvent`). Returns the unsubscribe function. */
  subscribeActivity(listener: (event: PlaybackActivityEvent) => void): () => void;
  dispose(): void;
}

export interface PlaybackApplicationDependencies {
  readonly trackRepository: Pick<TrackRepository, 'getById' | 'listFileStates'>;
  readonly playbackSessionRepository: PlaybackSessionRepository;
  /** The library's own listing and search, so a queue follows exactly what the track list shows. */
  readonly library: Pick<LibraryApplication, 'listTracks' | 'searchTracks' | 'getGroup'>;
  readonly mediaAccess: Pick<MediaAccess, 'resolveTrack'>;
  /** Phase 11: where list contexts (favourites, history, playlists) come from. Without it those contexts are refused. */
  readonly collections?: Pick<CollectionsApplication, 'listSourceTrackIds'>;
  /** Injected so shuffle is deterministic in tests. Defaults to `Math.random`. */
  readonly random?: RandomSource;
  /** Called with errors the service contained (e.g. a failed save). Never receives control flow. */
  readonly onInternalError?: (error: unknown) => void;
}

function isPositionMs(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function createPlaybackApplication(dependencies: PlaybackApplicationDependencies): PlaybackApplication {
  const { trackRepository, playbackSessionRepository, library, mediaAccess, collections } = dependencies;
  const random = dependencies.random ?? Math.random;
  const reportInternal = (error: unknown): void => {
    try {
      dependencies.onInternalError?.(error);
    } catch {
      // the error sink itself failed; nothing sensible is left to do
    }
  };

  let disposed = false;
  let queue: QueueState = EMPTY_QUEUE;
  let positionMs = 0;
  let revision = 0;
  let lastSignature = '';
  /** Bumped when a media failure is diagnosed, so the next load of the same track uses a fresh URL (see `buildTrackMediaUrl`). */
  let sourceVersion = 0;
  const listeners = new Set<(event: PlaybackApplicationEvent) => void>();
  const activityListeners = new Set<(event: PlaybackActivityEvent) => void>();

  /* ----- persistence: never allowed to break a command ----- */
  function persist(): void {
    try {
      playbackSessionRepository.save({ queue, positionMs });
    } catch (error) {
      reportInternal(error);
    }
  }

  /* ----- views ----- */
  function view(): PlaybackStateView {
    const currentId = getCurrentTrackId(queue);
    const track = currentId === undefined ? undefined : trackRepository.getById(currentId);
    return {
      revision,
      current: track === undefined ? undefined : { track, mediaUrl: buildTrackMediaUrl(track.id, sourceVersion) },
      positionMs: track === undefined ? 0 : positionMs,
      repeatMode: queue.repeatMode,
      shuffle: isShuffleEnabled(queue),
      queueLength: queue.tracks.length,
      queueIndex: queue.currentIndex,
      canNext: decideOnNextPressed(queue).kind === 'playIndex',
    };
  }

  /** Everything about a state a listener could display, EXCEPT the revision and the position. */
  function signatureOf(state: PlaybackStateView): string {
    return JSON.stringify([state.current?.track, state.repeatMode, state.shuffle, state.queueLength, state.queueIndex, state.canNext]);
  }

  /** Called after every change a command makes: bumps the revision and records what was reported. */
  function commit(): PlaybackStateView {
    revision += 1;
    const state = view();
    lastSignature = signatureOf(state);
    persist();
    return state;
  }

  function emit(event: PlaybackApplicationEvent): void {
    if (disposed) return;
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (error) {
        reportInternal(error); // a broken subscriber must never break playback
      }
    }
  }

  function emitActivity(event: PlaybackActivityEvent): void {
    if (disposed) return;
    for (const listener of [...activityListeners]) {
      try {
        listener(event);
      } catch (error) {
        reportInternal(error);
      }
    }
  }

  /* ----- queue helpers ----- */
  function prune(candidate: QueueState, knownIds: ReadonlySet<string>): { readonly queue: QueueState; readonly removedCurrent: boolean; readonly changed: boolean } {
    const gone = candidate.tracks.flatMap((id, index) => (knownIds.has(id) ? [] : [index]));
    if (gone.length === 0) return { queue: candidate, removedCurrent: false, changed: false };
    const removedCurrent = candidate.currentIndex !== undefined && gone.includes(candidate.currentIndex);
    return { queue: removeFromQueue(candidate, gone), removedCurrent, changed: true };
  }

  function knownTrackIds(): Set<string> {
    return new Set(trackRepository.listFileStates().map((state) => state.id));
  }

  /** The one place a command reports "a track was started": commits, tells subscribers, returns the reply. */
  function started(): PlaybackCommandResult {
    const state = commit();
    emit({ type: 'track-started', state });
    const startedId = state.current?.track.id;
    if (startedId !== undefined) emitActivity({ type: 'track-started', trackId: startedId });
    return { outcome: 'started', state };
  }

  function applyDecision(decision: PlaybackDecision): PlaybackCommandResult {
    switch (decision.kind) {
      case 'playIndex':
        queue = jumpToIndex(queue, decision.index);
        positionMs = 0;
        return started();
      case 'restartCurrent':
        positionMs = 0;
        return { outcome: 'restart', state: commit() };
      case 'noNextTrack':
      case 'noPreviousTrack':
      case 'queueEmpty':
        return { outcome: 'none', state: view() };
    }
  }

  function listForContext(context: PlaybackContext): readonly TrackId[] {
    switch (context.kind) {
      case 'search':
        return library.searchTracks(context.query).map((result) => result.track.id);
      case 'group':
        return library.getGroup(context.group.kind, context.group.key, context.sort).tracks.map((track) => track.id);
      case 'list':
        return listSourceIds(context.source);
      case 'library':
        return library.listTracks(context.sort).map((track) => track.id);
    }
  }

  function listSourceIds(source: ListSource): readonly TrackId[] {
    if (collections === undefined) throw new Error('Lists are not available: no collections service was given.');
    return collections.listSourceTrackIds(source);
  }

  /** Replaces the queue with `ids` and starts `index`. `replaceQueue` starts with repeat OFF and
   *  shuffle OFF by definition; the listener's modes are re-applied, as the domain's own docs prescribe. */
  function startQueue(ids: readonly TrackId[], index: number, forceShuffle = false): PlaybackCommandResult {
    const keepRepeat = queue.repeatMode;
    const keepShuffle = forceShuffle || isShuffleEnabled(queue);
    let next = setQueueRepeatMode(replaceQueue(ids, index), keepRepeat);
    if (keepShuffle) next = enableShuffle(next, random);
    queue = next;
    positionMs = 0;
    return started();
  }

  /** Whether `trackId` is really at `index` (a queue edit names both, so a stale view cannot hit the wrong track). */
  function queueHolds(index: number, trackId: string): boolean {
    return Number.isInteger(index) && index >= 0 && index < queue.tracks.length && queue.tracks[index] === trackId;
  }

  /* ----- restore the saved session, reconciled against the library ----- */
  try {
    const saved = playbackSessionRepository.load();
    if (saved !== undefined) {
      const pruned = prune(saved.queue, knownTrackIds());
      queue = pruned.queue;
      positionMs = pruned.removedCurrent || queue.currentIndex === undefined ? 0 : saved.positionMs;
      if (pruned.changed) persist();
    }
  } catch (error) {
    // A session that cannot be read must not stop the app: report it, forget it, start empty.
    reportInternal(error);
    try {
      playbackSessionRepository.clear();
    } catch (clearError) {
      reportInternal(clearError);
    }
  }
  lastSignature = signatureOf(view());

  return {
    getState: view,

    playTrack(request) {
      const trackId = parseTrackId(request.trackId);
      if (trackId === undefined || trackRepository.getById(trackId) === undefined) {
        throw new PlaybackApplicationError('track-not-found', 'That track is not in the library.');
      }
      const listed = listForContext(request.context ?? { kind: 'library' });
      const index = listed.indexOf(trackId);
      // The track was played from a list that no longer holds it (the library changed
      // under the user): play just that track rather than refuse.
      return startQueue(index === -1 ? [trackId] : listed, index === -1 ? 0 : index);
    },

    playGroup(request) {
      const ids = library.getGroup(request.group.kind, request.group.key, request.sort).tracks.map((track) => track.id);
      return startQueue(ids, 0);
    },

    playList(request) {
      const ids = listSourceIds(request.source);
      if (ids.length === 0) throw new PlaybackApplicationError('track-not-found', 'There is nothing to play in that list.');
      let index = 0;
      if (request.startTrackId !== undefined) {
        index = ids.indexOf(request.startTrackId as TrackId);
        if (index === -1) throw new PlaybackApplicationError('track-not-found', 'That track is not in this list.');
      } else if (request.shuffle === true) {
        index = Math.min(ids.length - 1, Math.floor(random() * ids.length));
      }
      return startQueue(ids, index, request.shuffle === true);
    },

    enqueue(request) {
      let ids: readonly TrackId[];
      if (request.source !== undefined) {
        ids = listSourceIds(request.source);
      } else if (request.group !== undefined) {
        ids = library.getGroup(request.group.kind, request.group.key).tracks.map((track) => track.id);
      } else {
        const trackId = request.trackId === undefined ? undefined : parseTrackId(request.trackId);
        if (trackId === undefined || trackRepository.getById(trackId) === undefined) {
          throw new PlaybackApplicationError('track-not-found', 'That track is not in the library.');
        }
        ids = [trackId];
      }
      queue = request.position === 'next' ? playNext(queue, ids) : appendToQueue(queue, ids);
      // Adding to an EMPTY queue makes the first added track current, paused (nothing autoplays).
      return { outcome: 'none', state: commit(), added: ids.length };
    },

    getQueue(request = {}) {
      const total = queue.tracks.length;
      const offset = Math.min(Math.max(0, Math.trunc(request.offset ?? 0)), total);
      const limit = Math.max(0, Math.trunc(request.limit ?? 200));
      const items: QueueItemView[] = [];
      for (let position = offset; position < Math.min(total, offset + limit); position += 1) {
        const track = trackRepository.getById(queue.tracks[position] as TrackId);
        if (track !== undefined) items.push({ position, track });
      }
      return { revision, total, currentIndex: queue.currentIndex, offset, items };
    },

    playQueueItem(index, trackId) {
      if (!queueHolds(index, trackId)) return { outcome: 'none', state: view() };
      queue = jumpToIndex(queue, index);
      positionMs = 0;
      return started();
    },

    removeFromQueue(index, trackId) {
      if (!queueHolds(index, trackId)) return { outcome: 'none', state: view() };
      const before = getCurrentTrackId(queue);
      queue = removeFromQueue(queue, [index]);
      if (getCurrentTrackId(queue) !== before) positionMs = 0; // a different track is current now
      return { outcome: 'none', state: commit() };
    },

    moveQueueItem(index, trackId, toIndex) {
      if (!queueHolds(index, trackId) || !Number.isInteger(toIndex) || toIndex < 0 || toIndex >= queue.tracks.length || toIndex === index) {
        return { outcome: 'none', state: view() };
      }
      queue = reorderQueue(queue, index, toIndex);
      return { outcome: 'none', state: commit() };
    },

    clearQueue() {
      if (queue.tracks.length === 0 || (queue.tracks.length === 1 && queue.currentIndex === 0)) return { outcome: 'none', state: view() };
      queue = clearQueueRule(queue);
      return { outcome: 'none', state: commit() };
    },

    next() {
      // Next never depends on the position: an explicit skip always advances (domain rule).
      return applyDecision(decideOnNextPressed(queue));
    },

    previous(position) {
      const decision = decideOnPreviousPressed(queue, isPositionMs(position) ? position : 0);
      // The domain reports "no previous track" on the first track; what to DO about it is the
      // application's call. Restarting the track is what players do, and keeps the button useful.
      return applyDecision(decision.kind === 'noPreviousTrack' ? { kind: 'restartCurrent' } : decision);
    },

    trackFinished(trackId) {
      if (getCurrentTrackId(queue) !== trackId) return { outcome: 'none', state: view() };
      emitActivity({ type: 'track-finished', trackId });
      const decision = decideOnTrackFinished(queue);
      if (decision.kind === 'noNextTrack') {
        // Queue exhausted under repeat OFF: stay on the last track, stopped, at the start.
        positionMs = 0;
        return { outcome: 'stop', state: commit() };
      }
      return applyDecision(decision);
    },

    setRepeatMode(mode) {
      queue = setQueueRepeatMode(queue, mode);
      return commit();
    },

    setShuffle(enabled) {
      queue = enabled ? enableShuffle(queue, random) : disableShuffle(queue);
      return commit();
    },

    reportPosition(trackId, position) {
      if (getCurrentTrackId(queue) !== trackId || !isPositionMs(position)) return { saved: false };
      positionMs = position;
      try {
        playbackSessionRepository.savePosition(position);
      } catch (error) {
        reportInternal(error);
        return { saved: false };
      }
      emitActivity({ type: 'position-reported', trackId, positionMs: position });
      return { saved: true };
    },

    async diagnoseSource(trackId) {
      // Called only after the renderer's element failed to load: whatever the verdict, the
      // next attempt must not be answered from the browser's memory of this failure.
      sourceVersion = Math.min(sourceVersion + 1, MAX_SOURCE_VERSION);
      const resolution = await mediaAccess.resolveTrack(trackId);
      return resolution.ok ? undefined : resolution.denial;
    },

    reconcileLibrary() {
      if (disposed) return;
      const pruned = prune(queue, knownTrackIds());
      if (pruned.changed) {
        queue = pruned.queue;
        if (pruned.removedCurrent) positionMs = 0;
        revision += 1;
        persist();
        const state = view();
        lastSignature = signatureOf(state);
        emit({ type: 'state-changed', reason: pruned.removedCurrent ? 'track-removed' : 'library-changed', state });
        return;
      }
      // Nothing was pruned, but the current track's metadata may have been refreshed.
      const state = view();
      const signature = signatureOf(state);
      if (signature === lastSignature) return;
      lastSignature = signature;
      revision += 1;
      emit({ type: 'state-changed', reason: 'library-changed', state: view() });
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    subscribeActivity(listener) {
      activityListeners.add(listener);
      return () => {
        activityListeners.delete(listener);
      };
    },

    dispose() {
      disposed = true;
      listeners.clear();
      activityListeners.clear();
    },
  };
}
