import { describe, expect, it } from 'vitest';
import {
  decideOnTrackFinished,
  decideOnNextPressed,
  decideOnPreviousPressed,
  PREVIOUS_RESTART_THRESHOLD_MS,
} from './playback-decisions.js';
import { replaceQueue, setRepeatMode, EMPTY_QUEUE } from './queue.js';
import type { TrackId } from './track-id.js';

function id(label: string): TrackId {
  return label as TrackId;
}

const A = id('A');
const B = id('B');
const C = id('C');

describe('decideOnTrackFinished - repeat OFF', () => {
  it('advances to the next track', () => {
    const state = replaceQueue([A, B, C], 0);
    expect(decideOnTrackFinished(state)).toEqual({ kind: 'playIndex', index: 1 });
  });

  it('reports no next track at the end of the queue', () => {
    const state = replaceQueue([A, B, C], 2);
    expect(decideOnTrackFinished(state)).toEqual({ kind: 'noNextTrack' });
  });

  it('reports queueEmpty for an empty queue', () => {
    expect(decideOnTrackFinished(EMPTY_QUEUE)).toEqual({ kind: 'queueEmpty' });
  });

  it('reports no next track for a single-track queue', () => {
    const state = replaceQueue([A], 0);
    expect(decideOnTrackFinished(state)).toEqual({ kind: 'noNextTrack' });
  });
});

describe('decideOnTrackFinished - repeat ALL', () => {
  it('wraps to the first track at the end of the queue', () => {
    const state = setRepeatMode(replaceQueue([A, B, C], 2), 'all');
    expect(decideOnTrackFinished(state)).toEqual({ kind: 'playIndex', index: 0 });
  });

  it('still advances normally when not at the end', () => {
    const state = setRepeatMode(replaceQueue([A, B, C], 0), 'all');
    expect(decideOnTrackFinished(state)).toEqual({ kind: 'playIndex', index: 1 });
  });

  it('wraps a single-track queue back to itself', () => {
    const state = setRepeatMode(replaceQueue([A], 0), 'all');
    expect(decideOnTrackFinished(state)).toEqual({ kind: 'playIndex', index: 0 });
  });
});

describe('decideOnTrackFinished - repeat ONE', () => {
  it('restarts the current track regardless of queue position', () => {
    const state = setRepeatMode(replaceQueue([A, B, C], 1), 'one');
    expect(decideOnTrackFinished(state)).toEqual({ kind: 'restartCurrent' });
  });

  it('restarts even at the last track', () => {
    const state = setRepeatMode(replaceQueue([A, B, C], 2), 'one');
    expect(decideOnTrackFinished(state)).toEqual({ kind: 'restartCurrent' });
  });

  it('restarts a single-track queue', () => {
    const state = setRepeatMode(replaceQueue([A], 0), 'one');
    expect(decideOnTrackFinished(state)).toEqual({ kind: 'restartCurrent' });
  });
});

describe('decideOnNextPressed - explicit skip always advances, ignoring repeat ONE', () => {
  it('advances normally under repeat OFF', () => {
    const state = replaceQueue([A, B, C], 0);
    expect(decideOnNextPressed(state)).toEqual({ kind: 'playIndex', index: 1 });
  });

  it('does NOT restart the current track under repeat ONE - an explicit skip is never trapped', () => {
    const state = setRepeatMode(replaceQueue([A, B, C], 0), 'one');
    expect(decideOnNextPressed(state)).toEqual({ kind: 'playIndex', index: 1 });
  });

  it('wraps under repeat ALL at the end of the queue', () => {
    const state = setRepeatMode(replaceQueue([A, B, C], 2), 'all');
    expect(decideOnNextPressed(state)).toEqual({ kind: 'playIndex', index: 0 });
  });

  it('reports no next track under repeat OFF at the end of the queue', () => {
    const state = replaceQueue([A, B, C], 2);
    expect(decideOnNextPressed(state)).toEqual({ kind: 'noNextTrack' });
  });

  it('reports no next track under repeat ONE at the end of the queue (still an explicit skip)', () => {
    const state = setRepeatMode(replaceQueue([A, B, C], 2), 'one');
    expect(decideOnNextPressed(state)).toEqual({ kind: 'noNextTrack' });
  });

  it('reports queueEmpty for an empty queue', () => {
    expect(decideOnNextPressed(EMPTY_QUEUE)).toEqual({ kind: 'queueEmpty' });
  });
});

describe('decideOnPreviousPressed - restart-current threshold', () => {
  it('moves to the previous track when position is below the threshold', () => {
    const state = replaceQueue([A, B, C], 1);
    expect(decideOnPreviousPressed(state, 1000)).toEqual({ kind: 'playIndex', index: 0 });
  });

  it('restarts the current track when position is at or above the threshold', () => {
    const state = replaceQueue([A, B, C], 1);
    expect(decideOnPreviousPressed(state, PREVIOUS_RESTART_THRESHOLD_MS)).toEqual({
      kind: 'restartCurrent',
    });
  });

  it('restarts the current track well past the threshold', () => {
    const state = replaceQueue([A, B, C], 1);
    expect(decideOnPreviousPressed(state, 47_000)).toEqual({ kind: 'restartCurrent' });
  });

  it('uses exactly the ~3 second product requirement expressed in milliseconds, not an invented threshold', () => {
    expect(PREVIOUS_RESTART_THRESHOLD_MS).toBe(3000);
  });

  it('restarts even the first track once past the threshold (no previous track exists, but restart wins)', () => {
    const state = replaceQueue([A, B, C], 0);
    expect(decideOnPreviousPressed(state, 10_000)).toEqual({ kind: 'restartCurrent' });
  });

  it('reports no previous track at the beginning of the queue, below the threshold, under repeat OFF', () => {
    const state = replaceQueue([A, B, C], 0);
    expect(decideOnPreviousPressed(state, 1000)).toEqual({ kind: 'noPreviousTrack' });
  });

  it('wraps to the last track at the beginning of the queue, below the threshold, under repeat ALL', () => {
    const state = setRepeatMode(replaceQueue([A, B, C], 0), 'all');
    expect(decideOnPreviousPressed(state, 1000)).toEqual({ kind: 'playIndex', index: 2 });
  });

  it('does NOT wrap under repeat ONE (repeat-one only governs natural track-end, not previous navigation)', () => {
    const state = setRepeatMode(replaceQueue([A, B, C], 0), 'one');
    expect(decideOnPreviousPressed(state, 1000)).toEqual({ kind: 'noPreviousTrack' });
  });

  it('reports queueEmpty for an empty queue', () => {
    expect(decideOnPreviousPressed(EMPTY_QUEUE, 1000)).toEqual({ kind: 'queueEmpty' });
  });

  it('handles a zero playback position as below the threshold', () => {
    const state = replaceQueue([A, B, C], 1);
    expect(decideOnPreviousPressed(state, 0)).toEqual({ kind: 'playIndex', index: 0 });
  });
});
