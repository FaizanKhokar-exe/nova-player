import { describe, expect, it } from 'vitest';
import { fisherYatesShuffle, isShuffleEnabled, enableShuffle, disableShuffle } from './shuffle.js';
import { replaceQueue, getCurrentTrackId, appendToQueue } from './queue.js';
import type { TrackId } from './track-id.js';
import type { RandomSource } from './shuffle.js';

function id(label: string): TrackId {
  return label as TrackId;
}

const A = id('A');
const B = id('B');
const C = id('C');
const D = id('D');

/** Returns a fixed sequence of values on successive calls (looping if the
 *  algorithm calls it more times than the sequence has entries). */
function fakeRandom(sequence: readonly number[]): RandomSource {
  let cursor = 0;
  return () => {
    const value = sequence[cursor % sequence.length] as number;
    cursor += 1;
    return value;
  };
}

describe('fisherYatesShuffle', () => {
  it('produces a fully deterministic permutation for a deterministic random source', () => {
    const result = fisherYatesShuffle([1, 2, 3, 4], fakeRandom([0]));
    // Hand-verified Fisher-Yates trace with random() always returning 0:
    // [1,2,3,4] -> swap(3,0) -> [4,2,3,1] -> swap(2,0) -> [3,2,4,1]
    // -> swap(1,0) -> [2,3,4,1]
    expect(result).toEqual([2, 3, 4, 1]);
  });

  it('produces the exact same output for the exact same input and random sequence', () => {
    const a = fisherYatesShuffle(['x', 'y', 'z', 'w'], fakeRandom([0.9, 0.1, 0.5]));
    const b = fisherYatesShuffle(['x', 'y', 'z', 'w'], fakeRandom([0.9, 0.1, 0.5]));
    expect(a).toEqual(b);
  });

  it('never introduces or drops elements', () => {
    const input = [A, B, C, D];
    const result = fisherYatesShuffle(input, fakeRandom([0.3, 0.7, 0.1]));
    expect(result).toHaveLength(input.length);
    expect([...result].sort()).toEqual([...input].sort());
  });

  it('does not mutate its input', () => {
    const input = [A, B, C, D];
    const inputCopy = [...input];
    fisherYatesShuffle(input, fakeRandom([0.5]));
    expect(input).toEqual(inputCopy);
  });

  it('leaves a single-element array unchanged', () => {
    expect(fisherYatesShuffle([A], fakeRandom([0.5]))).toEqual([A]);
  });

  it('leaves an empty array unchanged', () => {
    expect(fisherYatesShuffle([], fakeRandom([0.5]))).toEqual([]);
  });
});

describe('enableShuffle / disableShuffle', () => {
  it('keeps all tracks present after shuffling', () => {
    const state = replaceQueue([A, B, C, D], 0);
    const shuffled = enableShuffle(state, fakeRandom([0.2, 0.8, 0.4]));
    expect([...shuffled.tracks].sort()).toEqual([A, B, C, D].sort());
    expect(shuffled.tracks).toHaveLength(4);
  });

  it('introduces no duplicate tracks', () => {
    const state = replaceQueue([A, B, C, D], 0);
    const shuffled = enableShuffle(state, fakeRandom([0.6, 0.1]));
    expect(new Set(shuffled.tracks).size).toBe(4);
  });

  it('keeps the current track current after shuffling (never jumps to a different song)', () => {
    const state = replaceQueue([A, B, C, D], 2); // current: C
    const shuffled = enableShuffle(state, fakeRandom([0.9, 0.1]));
    expect(getCurrentTrackId(shuffled)).toBe(C);
  });

  it('reports shuffle as enabled', () => {
    const state = replaceQueue([A, B, C], 0);
    expect(isShuffleEnabled(state)).toBe(false);
    const shuffled = enableShuffle(state, fakeRandom([0.5]));
    expect(isShuffleEnabled(shuffled)).toBe(true);
  });

  it('restores the exact original order when disabled', () => {
    const state = replaceQueue([A, B, C, D], 0);
    const shuffled = enableShuffle(state, fakeRandom([0.9, 0.2, 0.6]));
    const restored = disableShuffle(shuffled);
    expect(restored.tracks).toEqual([A, B, C, D]);
    expect(isShuffleEnabled(restored)).toBe(false);
  });

  it('restores the correct current track when disabled, even if its position changed', () => {
    const state = replaceQueue([A, B, C, D], 3); // current: D
    const shuffled = enableShuffle(state, fakeRandom([0.9, 0.2, 0.6]));
    const restored = disableShuffle(shuffled);
    expect(getCurrentTrackId(restored)).toBe(D);
    expect(restored.currentIndex).toBe(3);
  });

  it('disabling shuffle when it was never enabled is a harmless no-op', () => {
    const state = replaceQueue([A, B, C], 1);
    const result = disableShuffle(state);
    expect(result).toEqual(state);
  });

  it('re-enabling shuffle after it is already on still preserves the TRUE original order for later restore', () => {
    const state = replaceQueue([A, B, C, D], 0);
    const shuffledOnce = enableShuffle(state, fakeRandom([0.9]));
    const shuffledTwice = enableShuffle(shuffledOnce, fakeRandom([0.1]));
    const restored = disableShuffle(shuffledTwice);
    expect(restored.tracks).toEqual([A, B, C, D]);
  });

  it('repeated enable/disable cycles do not corrupt queue state', () => {
    let state = replaceQueue([A, B, C, D], 1);
    for (let i = 0; i < 5; i += 1) {
      state = enableShuffle(state, fakeRandom([i / 5, 0.5]));
      state = disableShuffle(state);
    }
    expect(state.tracks).toEqual([A, B, C, D]);
    expect(getCurrentTrackId(state)).toBe(B);
  });

  it('shuffling a single-track queue is a safe no-op on order, but still marks shuffle enabled', () => {
    const state = replaceQueue([A], 0);
    const shuffled = enableShuffle(state, fakeRandom([0.5]));
    expect(shuffled.tracks).toEqual([A]);
    expect(isShuffleEnabled(shuffled)).toBe(true);
    expect(disableShuffle(shuffled).tracks).toEqual([A]);
  });

  it('shuffling an empty queue is a safe no-op', () => {
    const shuffled = enableShuffle(replaceQueue([]), fakeRandom([0.5]));
    expect(shuffled.tracks).toEqual([]);
    expect(getCurrentTrackId(shuffled)).toBeUndefined();
  });

  it('appending tracks while shuffled keeps the unshuffled snapshot in sync, so disabling shuffle still restores correctly', () => {
    const state = replaceQueue([A, B, C], 0);
    const shuffled = enableShuffle(state, fakeRandom([0.9, 0.1]));
    const withAppend = appendToQueue(shuffled, [D]);
    const restored = disableShuffle(withAppend);
    expect(restored.tracks).toEqual([A, B, C, D]);
  });
});

describe('shuffle immutability', () => {
  it('enableShuffle does not mutate the input state or its arrays', () => {
    const state = replaceQueue([A, B, C, D], 1);
    const tracksBefore = [...state.tracks];

    enableShuffle(state, fakeRandom([0.9, 0.2, 0.6]));

    expect(state.tracks).toEqual(tracksBefore);
    expect(state.currentIndex).toBe(1);
    expect(state.unshuffledTracks).toBeUndefined();
  });

  it('disableShuffle does not mutate the shuffled input state', () => {
    const shuffled = enableShuffle(replaceQueue([A, B, C, D], 0), fakeRandom([0.9, 0.2, 0.6]));
    const tracksBefore = [...shuffled.tracks];
    const snapshotBefore = [...(shuffled.unshuffledTracks ?? [])];

    disableShuffle(shuffled);

    expect(shuffled.tracks).toEqual(tracksBefore);
    expect(shuffled.unshuffledTracks).toEqual(snapshotBefore);
  });
});

/**
 * A small, fully deterministic linear congruential generator, so the
 * invariant sweep below is reproducible run to run - this is a sweep over
 * many DIFFERENT fixed seeds, not a statistical/probabilistic test.
 */
function seededRandom(seed: number): RandomSource {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

describe('shuffle invariants across many seeds and queue sizes', () => {
  it('always preserves the exact set of tracks, the current track, and restorability', () => {
    for (let size = 0; size <= 8; size += 1) {
      const tracks = Array.from({ length: size }, (_, index) => id(`T${index}`));

      for (let seed = 1; seed <= 25; seed += 1) {
        const startIndex = size === 0 ? 0 : seed % size;
        const original = replaceQueue(tracks, startIndex);
        const shuffled = enableShuffle(original, seededRandom(seed));

        // Same tracks, exactly once each.
        expect([...shuffled.tracks].sort()).toEqual([...tracks].sort());

        // Current track identity survives shuffling.
        expect(getCurrentTrackId(shuffled)).toBe(getCurrentTrackId(original));

        // Original order is always fully restorable.
        const restored = disableShuffle(shuffled);
        expect(restored.tracks).toEqual(tracks);
        expect(getCurrentTrackId(restored)).toBe(getCurrentTrackId(original));
      }
    }
  });
});
