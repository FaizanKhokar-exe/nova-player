import type { QueueState } from './queue.js';

/**
 * A source of randomness shaped exactly like `Math.random` (returns a float
 * in [0, 1)). Injected rather than called directly inside the shuffle
 * algorithm so tests can supply a deterministic sequence - see the Phase 1B
 * brief's explicit instruction not to let `Math.random()` make shuffle
 * tests nondeterministic. Production/application code supplies
 * `Math.random` itself; this module never reaches for it internally.
 */
export type RandomSource = () => number;

/**
 * Standard Fisher-Yates shuffle. Pure: returns a new array, never mutates
 * `items`. Given the same `items` and a `random` source that returns the
 * same sequence of values, the output is fully deterministic - this is what
 * makes it testable without relying on statistical assertions about
 * randomness.
 */
export function fisherYatesShuffle<T>(items: readonly T[], random: RandomSource): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const temp = result[i] as T;
    result[i] = result[j] as T;
    result[j] = temp;
  }
  return result;
}

export function isShuffleEnabled(state: QueueState): boolean {
  return state.unshuffledTracks !== undefined;
}

/**
 * Enables shuffle, or re-shuffles if it's already enabled.
 *
 * Policy, matching the reference product's behavior (shuffling never jumps
 * you to a different song mid-playback - it only randomizes what comes
 * after): the current track, if any, stays first/current; every OTHER
 * track is Fisher-Yates shuffled and placed after it.
 *
 * The true original order is preserved across repeated shuffle calls: if
 * shuffle is already on, the EXISTING `unshuffledTracks` snapshot is kept
 * (not overwritten with the already-shuffled `tracks`), so calling this
 * repeatedly re-shuffles the play order without ever losing the ability to
 * restore the real original.
 *
 * A queue of 0 or 1 tracks has nothing meaningful to reorder; shuffle is
 * still recorded as "on" (so `disableShuffle` remains well-defined) but no
 * reordering happens.
 */
export function enableShuffle(state: QueueState, random: RandomSource): QueueState {
  const snapshot = state.unshuffledTracks ?? state.tracks;

  if (state.tracks.length <= 1) {
    return state.unshuffledTracks !== undefined ? state : { ...state, unshuffledTracks: snapshot };
  }

  const currentTrackId = state.currentIndex !== undefined ? state.tracks[state.currentIndex] : undefined;

  const indexesToShuffle = state.tracks
    .map((_, index) => index)
    .filter((index) => index !== state.currentIndex);
  const shuffledRemaining = fisherYatesShuffle(indexesToShuffle, random).map(
    (index) => state.tracks[index]!,
  );

  const tracks = currentTrackId !== undefined ? [currentTrackId, ...shuffledRemaining] : shuffledRemaining;
  const currentIndex = currentTrackId !== undefined ? 0 : undefined;

  return { ...state, tracks, currentIndex, unshuffledTracks: snapshot };
}

/**
 * Restores the pre-shuffle order. A no-op if shuffle isn't currently
 * enabled.
 *
 * Known, documented limitation: this restores the snapshot exactly as it
 * was captured when shuffle was enabled. If `appendToQueue`/`playNext`/
 * `removeFromQueue` were called while shuffled, THOSE functions keep
 * `unshuffledTracks` in sync (see queue.ts), so the restored order correctly
 * reflects them. A manual `reorderQueue` performed while shuffled is the one
 * exception - queue.ts documents why reordering does not attempt to stay
 * synced with the unshuffled snapshot, so such a reorder is not preserved
 * once shuffle is disabled.
 *
 * The current track is preserved by identity, not by position: whichever
 * track was current in the shuffled order remains current in the restored
 * order (found by value; with duplicate TrackIds, the first matching
 * occurrence is used - the same documented duplicate-ID limitation as
 * elsewhere in this module).
 */
export function disableShuffle(state: QueueState): QueueState {
  if (state.unshuffledTracks === undefined) return state;

  const currentTrackId = state.currentIndex !== undefined ? state.tracks[state.currentIndex] : undefined;
  const tracks = state.unshuffledTracks;

  let currentIndex: number | undefined;
  if (currentTrackId === undefined) {
    currentIndex = undefined;
  } else {
    const foundIndex = tracks.indexOf(currentTrackId);
    currentIndex = foundIndex !== -1 ? foundIndex : tracks.length > 0 ? 0 : undefined;
  }

  return { ...state, tracks, currentIndex, unshuffledTracks: undefined };
}
