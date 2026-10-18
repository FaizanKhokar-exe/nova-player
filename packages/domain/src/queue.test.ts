import { describe, expect, it } from 'vitest';
import {
  EMPTY_QUEUE,
  getCurrentTrackId,
  replaceQueue,
  appendToQueue,
  playNext,
  removeFromQueue,
  reorderQueue,
  jumpToIndex,
  setRepeatMode,
  clearQueue,
  type QueueState,
} from './queue.js';
import { disableShuffle, enableShuffle } from './shuffle.js';
import type { TrackId } from './track-id.js';

/**
 * Test-only convenience: real TrackIds are always UUIDs minted via
 * createTrackId() (Phase 1A). For queue tests, short readable labels make
 * failures far easier to read than comparing UUIDs, and the queue itself
 * treats TrackId as an opaque value throughout - it never parses or
 * validates the string, so this is safe to use here.
 */
function id(label: string): TrackId {
  return label as TrackId;
}

const A = id('A');
const B = id('B');
const C = id('C');
const D = id('D');
const E = id('E');

describe('replaceQueue', () => {
  it('replaces the queue and defaults to the first track', () => {
    const state = replaceQueue([A, B, C]);
    expect(state.tracks).toEqual([A, B, C]);
    expect(state.currentIndex).toBe(0);
  });

  it('handles an empty queue safely', () => {
    const state = replaceQueue([]);
    expect(state.tracks).toEqual([]);
    expect(state.currentIndex).toBeUndefined();
    expect(getCurrentTrackId(state)).toBeUndefined();
  });

  it('handles a one-track queue', () => {
    const state = replaceQueue([A]);
    expect(state.tracks).toEqual([A]);
    expect(state.currentIndex).toBe(0);
  });

  it('starts at the first track when startIndex is 0', () => {
    const state = replaceQueue([A, B, C], 0);
    expect(state.currentIndex).toBe(0);
  });

  it('starts at a middle track', () => {
    const state = replaceQueue([A, B, C], 1);
    expect(state.currentIndex).toBe(1);
    expect(getCurrentTrackId(state)).toBe(B);
  });

  it('starts at the last track', () => {
    const state = replaceQueue([A, B, C], 2);
    expect(state.currentIndex).toBe(2);
    expect(getCurrentTrackId(state)).toBe(C);
  });

  it('falls back to index 0 for an out-of-range startIndex (documented policy)', () => {
    const state = replaceQueue([A, B, C], 99);
    expect(state.currentIndex).toBe(0);
  });

  it('falls back to index 0 for a negative startIndex', () => {
    const state = replaceQueue([A, B, C], -1);
    expect(state.currentIndex).toBe(0);
  });

  it('resets repeat mode and shuffle to off', () => {
    const state = replaceQueue([A, B, C]);
    expect(state.repeatMode).toBe('off');
    expect(state.unshuffledTracks).toBeUndefined();
  });

  it('does not mutate the caller-provided array', () => {
    const original = [A, B, C];
    const originalCopy = [...original];
    replaceQueue(original);
    expect(original).toEqual(originalCopy);
  });
});

describe('appendToQueue', () => {
  it('appends tracks after the existing queue, preserving order', () => {
    const state = replaceQueue([A, B, C]);
    const result = appendToQueue(state, [D, E]);
    expect(result.tracks).toEqual([A, B, C, D, E]);
  });

  it('preserves the current track', () => {
    const state = replaceQueue([A, B, C], 1);
    const result = appendToQueue(state, [D, E]);
    expect(result.currentIndex).toBe(1);
    expect(getCurrentTrackId(result)).toBe(B);
  });

  it('establishes a current track when appending to an empty queue', () => {
    const result = appendToQueue(EMPTY_QUEUE, [A, B]);
    expect(result.tracks).toEqual([A, B]);
    expect(result.currentIndex).toBe(0);
  });

  it('handles an empty append with no changes', () => {
    const state = replaceQueue([A, B, C], 1);
    const result = appendToQueue(state, []);
    expect(result).toEqual(state);
  });

  it('does not mutate the caller-provided arrays', () => {
    const state = replaceQueue([A, B, C]);
    const toAppend = [D, E];
    const toAppendCopy = [...toAppend];
    appendToQueue(state, toAppend);
    expect(toAppend).toEqual(toAppendCopy);
    expect(state.tracks).toEqual([A, B, C]);
  });
});

describe('playNext', () => {
  it('inserts immediately after the current track when current is at the beginning', () => {
    const state = replaceQueue([A, B, C], 0);
    const result = playNext(state, [D, E]);
    expect(result.tracks).toEqual([A, D, E, B, C]);
    expect(getCurrentTrackId(result)).toBe(A);
  });

  it('inserts immediately after the current track when current is in the middle', () => {
    const state = replaceQueue([A, B, C], 1);
    const result = playNext(state, [D, E]);
    expect(result.tracks).toEqual([A, B, D, E, C]);
    expect(getCurrentTrackId(result)).toBe(B);
  });

  it('inserts immediately after the current track when current is at the end', () => {
    const state = replaceQueue([A, B, C], 2);
    const result = playNext(state, [D, E]);
    expect(result.tracks).toEqual([A, B, C, D, E]);
    expect(getCurrentTrackId(result)).toBe(C);
  });

  it('starts a fresh queue when playNext is called on an empty queue', () => {
    const result = playNext(EMPTY_QUEUE, [A, B]);
    expect(result.tracks).toEqual([A, B]);
    expect(result.currentIndex).toBe(0);
  });

  it('supports inserting multiple tracks in one call, preserving their relative order', () => {
    const state = replaceQueue([A, C], 0);
    const result = playNext(state, [B]);
    expect(result.tracks).toEqual([A, B, C]);
  });

  it('handles an empty insertion list as a no-op', () => {
    const state = replaceQueue([A, B, C], 1);
    const result = playNext(state, []);
    expect(result).toEqual(state);
  });

  it('does not mutate the caller-provided arrays', () => {
    const state = replaceQueue([A, B, C], 1);
    const toInsert = [D, E];
    playNext(state, toInsert);
    expect(state.tracks).toEqual([A, B, C]);
    expect(toInsert).toEqual([D, E]);
  });
});

describe('removeFromQueue', () => {
  it('removing a track before current shifts currentIndex but not the current track', () => {
    const state = replaceQueue([A, B, C], 2); // current: C
    const result = removeFromQueue(state, [0]); // remove A
    expect(result.tracks).toEqual([B, C]);
    expect(getCurrentTrackId(result)).toBe(C);
    expect(result.currentIndex).toBe(1);
  });

  it('removing a track after current does not change currentIndex', () => {
    const state = replaceQueue([A, B, C], 0); // current: A
    const result = removeFromQueue(state, [2]); // remove C
    expect(result.tracks).toEqual([A, B]);
    expect(getCurrentTrackId(result)).toBe(A);
    expect(result.currentIndex).toBe(0);
  });

  it('removing the current track advances current to the track that would have played next', () => {
    const state = replaceQueue([A, B, C], 1); // current: B
    const result = removeFromQueue(state, [1]); // remove B
    expect(result.tracks).toEqual([A, C]);
    expect(getCurrentTrackId(result)).toBe(C);
  });

  it('removing the current track when it was last falls back to the new last track', () => {
    const state = replaceQueue([A, B, C], 2); // current: C
    const result = removeFromQueue(state, [2]); // remove C
    expect(result.tracks).toEqual([A, B]);
    expect(getCurrentTrackId(result)).toBe(B);
  });

  it('removing the only track empties the queue and clears the current track', () => {
    const state = replaceQueue([A], 0);
    const result = removeFromQueue(state, [0]);
    expect(result.tracks).toEqual([]);
    expect(result.currentIndex).toBeUndefined();
  });

  it('removes multiple tracks in one call', () => {
    const state = replaceQueue([A, B, C, D, E], 4); // current: E
    const result = removeFromQueue(state, [0, 2]); // remove A and C
    expect(result.tracks).toEqual([B, D, E]);
    expect(getCurrentTrackId(result)).toBe(E);
  });

  it('ignores an invalid index and returns the state unchanged', () => {
    const state = replaceQueue([A, B, C], 1);
    const result = removeFromQueue(state, [99]);
    expect(result).toEqual(state);
  });

  it('ignores negative indexes among a mixed valid/invalid list', () => {
    const state = replaceQueue([A, B, C], 1);
    const result = removeFromQueue(state, [-1, 0]);
    expect(result.tracks).toEqual([B, C]);
  });

  it('does not mutate the caller-provided state', () => {
    const state = replaceQueue([A, B, C], 1);
    removeFromQueue(state, [0]);
    expect(state.tracks).toEqual([A, B, C]);
  });

  it('removing current together with an earlier track lands on the track that would have played next', () => {
    const state = replaceQueue([A, B, C, D, E], 2); // current: C
    const result = removeFromQueue(state, [1, 2]); // remove B and C
    expect(result.tracks).toEqual([A, D, E]);
    expect(getCurrentTrackId(result)).toBe(D);
  });

  it('removing current together with the track right after it skips to the next survivor', () => {
    const state = replaceQueue([A, B, C, D], 1); // current: B
    const result = removeFromQueue(state, [1, 2]); // remove B and C
    expect(result.tracks).toEqual([A, D]);
    expect(getCurrentTrackId(result)).toBe(D);
  });

  it('removing current (last) together with an earlier track falls back to the new last track', () => {
    const state = replaceQueue([A, B, C], 2); // current: C
    const result = removeFromQueue(state, [0, 2]); // remove A and C
    expect(result.tracks).toEqual([B]);
    expect(getCurrentTrackId(result)).toBe(B);
  });

  it('the same index listed twice is treated as one removal', () => {
    const state = replaceQueue([A, B, C], 0);
    const result = removeFromQueue(state, [1, 1]);
    expect(result.tracks).toEqual([A, C]);
  });
});

describe('reorderQueue', () => {
  it('moves a track from the end to the beginning, preserving every track exactly once', () => {
    const state = replaceQueue([A, B, C, D]);
    const result = reorderQueue(state, 2, 0); // move C to first
    expect(result.tracks).toEqual([C, A, B, D]);
    expect(result.tracks).toHaveLength(4);
    expect(new Set(result.tracks).size).toBe(4);
  });

  it('preserves current-track identity when the move does not involve current', () => {
    const state = replaceQueue([A, B, C, D], 3); // current: D
    const result = reorderQueue(state, 0, 1); // move A after B
    expect(getCurrentTrackId(result)).toBe(D);
  });

  it('preserves current-track identity when the current track itself is moved', () => {
    const state = replaceQueue([A, B, C, D], 1); // current: B
    const result = reorderQueue(state, 1, 3); // move B to the end
    expect(result.tracks).toEqual([A, C, D, B]);
    expect(getCurrentTrackId(result)).toBe(B);
    expect(result.currentIndex).toBe(3);
  });

  it('shifts currentIndex down when a move crosses over it moving forward', () => {
    const state = replaceQueue([A, B, C, D], 1); // current: B, index 1
    const result = reorderQueue(state, 0, 2); // move A from 0 to 2, passing over B
    expect(result.tracks).toEqual([B, C, A, D]);
    expect(getCurrentTrackId(result)).toBe(B);
    expect(result.currentIndex).toBe(0);
  });

  it('shifts currentIndex up when a move crosses over it moving backward', () => {
    const state = replaceQueue([A, B, C, D], 2); // current: C, index 2
    const result = reorderQueue(state, 3, 0); // move D from 3 to 0, passing over C and B
    expect(result.tracks).toEqual([D, A, B, C]);
    expect(getCurrentTrackId(result)).toBe(C);
    expect(result.currentIndex).toBe(3);
  });

  it('treats fromIndex === toIndex as a documented no-op', () => {
    const state = replaceQueue([A, B, C], 1);
    const result = reorderQueue(state, 1, 1);
    expect(result).toEqual(state);
  });

  it('ignores an out-of-range fromIndex', () => {
    const state = replaceQueue([A, B, C], 0);
    const result = reorderQueue(state, 99, 0);
    expect(result).toEqual(state);
  });

  it('ignores an out-of-range toIndex', () => {
    const state = replaceQueue([A, B, C], 0);
    const result = reorderQueue(state, 0, 99);
    expect(result).toEqual(state);
  });

  it('does not mutate the caller-provided state', () => {
    const state = replaceQueue([A, B, C, D]);
    reorderQueue(state, 0, 3);
    expect(state.tracks).toEqual([A, B, C, D]);
  });
});

describe('jumpToIndex', () => {
  it('jumps forward to a later track', () => {
    const state = replaceQueue([A, B, C], 0);
    const result = jumpToIndex(state, 2);
    expect(result.currentIndex).toBe(2);
    expect(getCurrentTrackId(result)).toBe(C);
  });

  it('jumps backward to an earlier track', () => {
    const state = replaceQueue([A, B, C], 2);
    const result = jumpToIndex(state, 0);
    expect(result.currentIndex).toBe(0);
  });

  it('jumping to the current index is a harmless no-op', () => {
    const state = replaceQueue([A, B, C], 1);
    const result = jumpToIndex(state, 1);
    expect(result.currentIndex).toBe(1);
  });

  it('jumps to the first track', () => {
    const state = replaceQueue([A, B, C], 2);
    expect(jumpToIndex(state, 0).currentIndex).toBe(0);
  });

  it('jumps to the last track', () => {
    const state = replaceQueue([A, B, C], 0);
    expect(jumpToIndex(state, 2).currentIndex).toBe(2);
  });

  it('ignores an invalid (out-of-range) position', () => {
    const state = replaceQueue([A, B, C], 1);
    const result = jumpToIndex(state, 99);
    expect(result).toEqual(state);
  });

  it('is a no-op against an empty queue', () => {
    const result = jumpToIndex(EMPTY_QUEUE, 0);
    expect(result).toEqual(EMPTY_QUEUE);
  });

  it('does not perform playback - it only changes queue state', () => {
    // This is really a documentation-as-test assertion: jumpToIndex's
    // return type is QueueState, not a playback instruction of any kind.
    const state = replaceQueue([A, B, C], 0);
    const result: QueueState = jumpToIndex(state, 1);
    expect(result.currentIndex).toBe(1);
  });
});

describe('setRepeatMode', () => {
  it('sets the repeat mode without affecting anything else', () => {
    const state = replaceQueue([A, B, C], 1);
    const result = setRepeatMode(state, 'all');
    expect(result.repeatMode).toBe('all');
    expect(result.tracks).toEqual(state.tracks);
    expect(result.currentIndex).toBe(state.currentIndex);
  });
});

describe('edge cases', () => {
  it('a two-track queue behaves correctly for remove-current-when-last', () => {
    const state = replaceQueue([A, B], 1);
    const result = removeFromQueue(state, [1]);
    expect(result.tracks).toEqual([A]);
    expect(getCurrentTrackId(result)).toBe(A);
  });

  it('duplicate TrackIds are permitted in the queue', () => {
    const state = replaceQueue([A, A, B]);
    expect(state.tracks).toEqual([A, A, B]);
  });

  it('removing one occurrence of a duplicated TrackId leaves the other in place', () => {
    const state = replaceQueue([A, A, B], 0);
    const result = removeFromQueue(state, [0]);
    expect(result.tracks).toEqual([A, B]);
  });
});

describe('clearQueue (Phase 5)', () => {
  const a = id('a');
  const b = id('b');
  const c = id('c');

  it('keeps only the current track, as current, and keeps the repeat mode', () => {
    const state = setRepeatMode(replaceQueue([a, b, c], 1), 'all');
    const cleared = clearQueue(state);
    expect(cleared.tracks).toEqual([b]);
    expect(cleared.currentIndex).toBe(0);
    expect(cleared.repeatMode).toBe('all');
    expect(getCurrentTrackId(cleared)).toBe(b);
  });

  it('empties a queue that has no current track', () => {
    expect(clearQueue(EMPTY_QUEUE)).toEqual(EMPTY_QUEUE);
  });

  it('leaves a one-track shuffle snapshot so turning shuffle off does not resurrect the cleared tracks', () => {
    const shuffled = enableShuffle(replaceQueue([a, b, c], 0), () => 0.3);
    const cleared = clearQueue(shuffled);
    expect(cleared.unshuffledTracks).toEqual([a]);
    expect(disableShuffle(cleared).tracks).toEqual([a]);
  });

  it('does not modify the state it was given', () => {
    const state = replaceQueue([a, b, c], 2);
    const before = JSON.stringify(state);
    clearQueue(state);
    expect(JSON.stringify(state)).toBe(before);
  });

  it('documents how editing interacts with the current track and modes', () => {
    // Removing the current track plays what would have played next, repeat mode untouched.
    const repeatOne = setRepeatMode(replaceQueue([a, b, c], 1), 'one');
    const removed = removeFromQueue(repeatOne, [1]);
    expect(removed.tracks).toEqual([a, c]);
    expect(getCurrentTrackId(removed)).toBe(c);
    expect(removed.repeatMode).toBe('one');
    // Removing the current LAST track makes the new last track current (the queue does not wrap).
    const last = removeFromQueue(setRepeatMode(replaceQueue([a, b, c], 2), 'all'), [2]);
    expect(getCurrentTrackId(last)).toBe(b);
    expect(last.repeatMode).toBe('all');
    // Reordering never changes which track is current.
    const moved = reorderQueue(replaceQueue([a, b, c], 1), 0, 2);
    expect(moved.tracks).toEqual([b, c, a]);
    expect(getCurrentTrackId(moved)).toBe(b);
  });
});
