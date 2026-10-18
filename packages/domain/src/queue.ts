import type { TrackId } from './track-id.js';

/**
 * Queue traversal mode - what happens at the end of the queue. This is
 * deliberately the ONLY "mode" concept the queue owns; volume, lyrics,
 * visualizer, theme, and settings state all live elsewhere (later phases),
 * per the Phase 1B brief.
 */
export type RepeatMode = 'off' | 'all' | 'one';

/**
 * The queue's domain state. Deliberately holds `TrackId` references, not
 * full `Track` objects (see track-id.ts / track.ts from Phase 1A) - the
 * queue only needs to know WHICH tracks and in WHAT order; resolving an ID
 * to display metadata is a repository/application concern for a later
 * phase. This keeps the queue decoupled from wherever track metadata
 * actually lives, and avoids duplicating the Track type here.
 *
 * `tracks` is always the single active playback order - the one thing a
 * user is currently seeing/hearing, whether shuffled or not. There is no
 * separate "shuffled order" array: shuffling (see shuffle.ts) works by
 * physically reordering `tracks` itself. `unshuffledTracks`, when present,
 * is a snapshot of `tracks` taken at the moment shuffle was enabled, used
 * only to restore ordering when shuffle is disabled again - see shuffle.ts
 * for the full policy, including its documented limitations around
 * structural edits made while shuffled.
 *
 * `currentIndex` always indexes into `tracks` directly - never into some
 * separate "original order" - so "what track is current" is always a
 * simple, unambiguous lookup.
 */
export interface QueueState {
  readonly tracks: readonly TrackId[];
  readonly currentIndex: number | undefined;
  readonly repeatMode: RepeatMode;
  readonly unshuffledTracks: readonly TrackId[] | undefined;
}

export const EMPTY_QUEUE: QueueState = {
  tracks: [],
  currentIndex: undefined,
  repeatMode: 'off',
  unshuffledTracks: undefined,
};

export function getCurrentTrackId(state: QueueState): TrackId | undefined {
  return state.currentIndex !== undefined ? state.tracks[state.currentIndex] : undefined;
}

function isValidIndex(index: number, length: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < length;
}

/**
 * Builds a brand-new queue from scratch, replacing anything that existed
 * before. This is the literal 2-argument operation the Phase 1B brief
 * specifies - it does not take a previous QueueState - so it always starts
 * with repeat OFF and shuffle OFF. Preserving a previously-set repeat mode
 * or shuffle preference across a full queue replacement is an
 * application-layer decision for a later phase (compose `setRepeatMode` /
 * `enableShuffle` after calling this, if that behavior is wanted).
 *
 * Policy for `startIndex`: omitted, non-integer, negative, or out-of-range
 * values all resolve to `0` whenever the new queue is non-empty - the least
 * surprising fallback, since replacing the queue always implies wanting to
 * play something. An empty `tracks` array always yields `currentIndex:
 * undefined`, regardless of `startIndex`.
 */
export function replaceQueue(tracks: readonly TrackId[], startIndex?: number): QueueState {
  const nextTracks = [...tracks];
  const currentIndex =
    nextTracks.length === 0
      ? undefined
      : startIndex !== undefined && isValidIndex(startIndex, nextTracks.length)
        ? startIndex
        : 0;

  return { tracks: nextTracks, currentIndex, repeatMode: 'off', unshuffledTracks: undefined };
}

/**
 * Appends tracks to the end of the queue, preserving existing order and the
 * current track. If the queue was empty, the first appended track becomes
 * current (there is nothing to "preserve" in that case, and an appended
 * queue with no current track would be a confusing state to be in).
 *
 * Kept in sync with `unshuffledTracks` when shuffle is enabled: the new
 * tracks are appended to both arrays' ends, so appending while shuffled
 * remains fully restorable when shuffle is later disabled.
 */
export function appendToQueue(state: QueueState, tracksToAppend: readonly TrackId[]): QueueState {
  if (tracksToAppend.length === 0) return state;

  const tracks = [...state.tracks, ...tracksToAppend];
  const currentIndex = state.currentIndex ?? 0;
  const unshuffledTracks =
    state.unshuffledTracks !== undefined ? [...state.unshuffledTracks, ...tracksToAppend] : undefined;

  return { ...state, tracks, currentIndex, unshuffledTracks };
}

/**
 * Inserts tracks immediately after the current track, so they play next
 * without disturbing anything already queued before or after them. If the
 * queue has no current track (it's empty), this degrades to simply starting
 * a fresh queue with these tracks - there is no "after current" to insert
 * relative to.
 *
 * In the unshuffled snapshot, inserted tracks are appended to the END
 * rather than positionally inserted - "immediately after current" is only
 * a meaningful position in the ACTIVE sequence being played right now; see
 * shuffle.ts for the full rationale.
 */
export function playNext(state: QueueState, tracksToInsert: readonly TrackId[]): QueueState {
  if (tracksToInsert.length === 0) return state;
  if (state.currentIndex === undefined) {
    return replaceQueue(tracksToInsert, 0);
  }

  const insertAt = state.currentIndex + 1;
  const tracks = [...state.tracks.slice(0, insertAt), ...tracksToInsert, ...state.tracks.slice(insertAt)];
  const unshuffledTracks =
    state.unshuffledTracks !== undefined ? [...state.unshuffledTracks, ...tracksToInsert] : undefined;

  return { ...state, tracks, unshuffledTracks };
}

function removeFirstOccurrencesByValue(
  array: readonly TrackId[],
  valuesToRemove: readonly TrackId[],
): TrackId[] {
  const remaining = [...array];
  for (const value of valuesToRemove) {
    const index = remaining.indexOf(value);
    if (index !== -1) remaining.splice(index, 1);
  }
  return remaining;
}

/**
 * Removes tracks at the given indexes. Out-of-range/non-integer indexes are
 * silently ignored rather than throwing (matching the rest of this
 * module's "invalid input is a documented no-op-for-that-part" policy).
 *
 * Current-track policy, chosen deliberately:
 *   - Removing tracks entirely before or after the current track shifts
 *     `currentIndex` as needed but never changes WHICH track is current.
 *   - Removing the current track itself: the track that would have played
 *     next automatically becomes current (skipping forward past whatever
 *     was removed). If the removed current track was the last one, the new
 *     last track becomes current instead. If the queue becomes empty,
 *     there is no current track.
 *
 * Duplicate TrackIds in `unshuffledTracks`, if shuffle is enabled, are
 * reconciled by value: one matching occurrence is removed per removed
 * track, first-match-first-removed. This cannot perfectly disambiguate
 * which physical occurrence corresponded to which if IDs repeat - a
 * documented, accepted limitation, consistent with the deduplication key's
 * own documented limitations in Phase 1A.
 */
export function removeFromQueue(state: QueueState, indexesToRemove: readonly number[]): QueueState {
  const validIndexes = new Set(indexesToRemove.filter((index) => isValidIndex(index, state.tracks.length)));
  if (validIndexes.size === 0) return state;

  const removedTrackIds = [...validIndexes].map((index) => state.tracks[index] as TrackId);
  const tracks = state.tracks.filter((_, index) => !validIndexes.has(index));

  let currentIndex: number | undefined;
  if (state.currentIndex === undefined) {
    currentIndex = undefined;
  } else if (validIndexes.has(state.currentIndex)) {
    const removedAtOrBeforeCurrent = [...validIndexes].filter((index) => index <= state.currentIndex!).length;
    const candidateIndex = state.currentIndex - removedAtOrBeforeCurrent + 1;
    currentIndex = tracks.length === 0 ? undefined : Math.min(candidateIndex, tracks.length - 1);
  } else {
    const removedBeforeCurrent = [...validIndexes].filter((index) => index < state.currentIndex!).length;
    currentIndex = state.currentIndex - removedBeforeCurrent;
  }

  const unshuffledTracks =
    state.unshuffledTracks !== undefined
      ? removeFirstOccurrencesByValue(state.unshuffledTracks, removedTrackIds)
      : undefined;

  return { ...state, tracks, currentIndex, unshuffledTracks };
}

function recomputeIndexAfterMove(index: number, fromIndex: number, toIndex: number): number {
  if (index === fromIndex) return toIndex;
  if (fromIndex < toIndex) {
    return index > fromIndex && index <= toIndex ? index - 1 : index;
  }
  return index >= toIndex && index < fromIndex ? index + 1 : index;
}

/**
 * Moves the track at `fromIndex` to `toIndex`, preserving every other
 * track's relative order and, critically, preserving WHICH track is
 * current even when the move crosses the current-track boundary (this is
 * `recomputeIndexAfterMove`'s entire job).
 *
 * Invalid input (out-of-range or non-integer indexes, or `fromIndex ===
 * toIndex`) is a documented no-op: the state is returned unchanged rather
 * than throwing.
 *
 * Operates only on the ACTIVE order (`tracks`) - `unshuffledTracks` is
 * deliberately left untouched by a reorder. This is the one place this
 * module accepts imperfect shuffle/structural-edit consistency: a manual
 * reorder performed while shuffled affects only the current shuffled
 * sequence, and is not preserved once shuffle is disabled and the original
 * order is restored. Reordering while unshuffled is fully persistent, since
 * in that state `tracks` and `unshuffledTracks` are the same order and
 * shuffle isn't involved at all.
 */
export function reorderQueue(state: QueueState, fromIndex: number, toIndex: number): QueueState {
  const length = state.tracks.length;
  if (
    !isValidIndex(fromIndex, length) ||
    !isValidIndex(toIndex, length) ||
    fromIndex === toIndex
  ) {
    return state;
  }

  const tracks = [...state.tracks];
  const moved = tracks.splice(fromIndex, 1)[0] as TrackId;
  tracks.splice(toIndex, 0, moved);

  const currentIndex =
    state.currentIndex !== undefined ? recomputeIndexAfterMove(state.currentIndex, fromIndex, toIndex) : undefined;

  return { ...state, tracks, currentIndex };
}

/**
 * Changes the current position without performing any playback - jumping
 * is purely a queue-state change. Deciding what should audibly happen as a
 * result is the caller's job (a future application-layer/infrastructure
 * concern), never this function's.
 *
 * An invalid target index (out of range, non-integer, or any index at all
 * against an empty queue) is a no-op: the state is returned unchanged.
 */
export function jumpToIndex(state: QueueState, index: number): QueueState {
  if (!isValidIndex(index, state.tracks.length)) return state;
  return { ...state, currentIndex: index };
}

export function setRepeatMode(state: QueueState, mode: RepeatMode): QueueState {
  return { ...state, repeatMode: mode };
}

/**
 * Phase 5 - "clear the queue".
 *
 * Whatever is playing keeps playing: the queue becomes just the current track
 * (the user asked to empty the queue, not to stop the music). With no current
 * track the queue is simply empty. The repeat mode is kept; a shuffled queue
 * stays "shuffled" with a one-track snapshot, so turning shuffle off later
 * restores that single track rather than resurrecting what was cleared.
 */
export function clearQueue(state: QueueState): QueueState {
  const current = getCurrentTrackId(state);
  if (current === undefined) {
    return { ...state, tracks: [], currentIndex: undefined, unshuffledTracks: state.unshuffledTracks === undefined ? undefined : [] };
  }
  return {
    ...state,
    tracks: [current],
    currentIndex: 0,
    unshuffledTracks: state.unshuffledTracks === undefined ? undefined : [current],
  };
}
