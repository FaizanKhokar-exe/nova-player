import type { QueueState } from './queue.js';

/**
 * What survives an app restart about playback: the queue exactly as the
 * Phase 1 domain models it (active order, current index, repeat mode, and the
 * pre-shuffle snapshot when shuffle is on) plus how far into the current
 * track the listener was.
 *
 * `positionMs` is whole MILLISECONDS - the domain's canonical playback-position
 * unit. It is meaningful only while `queue` has a current track; otherwise 0.
 *
 * Nothing about whether audio was playing is stored: a restored session always
 * comes back paused. Volume and mute are not part of the queue and are not
 * persisted in Phase 4 (they belong with the later settings work).
 */
export interface PersistedPlaybackSession {
  readonly queue: QueueState;
  readonly positionMs: number;
}

/**
 * Persistence port for the single playback session. Synchronous for the same
 * reason as the other repositories (the only planned implementation is
 * in-process SQLite). There is exactly one session: `save` replaces it.
 */
export interface PlaybackSessionRepository {
  /** The saved session, or `undefined` if none was ever saved (or it was cleared).
   *  @throws if the stored data cannot be turned back into a valid queue */
  load(): PersistedPlaybackSession | undefined;

  /** Replaces the whole saved session. */
  save(session: PersistedPlaybackSession): void;

  /**
   * Updates only the position of the saved session - the frequent case, which
   * must not rewrite the (possibly large) queue. A no-op when nothing is saved.
   * `positionMs` must be a non-negative integer.
   */
  savePosition(positionMs: number): void;

  /** Forgets the saved session. */
  clear(): void;
}
