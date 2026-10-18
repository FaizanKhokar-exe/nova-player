import { describe, expect, it } from 'vitest';
import { createTrack } from './track.js';
import { createTrackId } from './track-id.js';
import { searchTracks } from './search.js';
import {
  replaceQueue,
  appendToQueue,
  removeFromQueue,
  reorderQueue,
  getCurrentTrackId,
  setRepeatMode,
} from './queue.js';
import { enableShuffle, disableShuffle } from './shuffle.js';
import {
  decideOnNextPressed,
  decideOnPreviousPressed,
  decideOnTrackFinished,
} from './playback-decisions.js';
import { parseLyrics } from './lrc.js';
import { getActiveLyric } from './active-lyric.js';

/**
 * Phase 1E: integration tests only - these verify the four domain areas
 * built in Phases 1A-1D actually work together as one coherent domain, not
 * new behavior. Each unit behavior these scenarios touch is already
 * covered in depth by that area's own test file; keeping this file small
 * per the Phase 1E brief.
 */

describe('Scenario A - Track + Search: real Tracks, deterministic ordering', () => {
  it('creates tracks via the real Phase 1A policy and gets the expected Phase 1C ranking', () => {
    const believe = createTrack({
      id: createTrackId(),
      sourcePath: '/music/Believe.mp3',
      raw: { title: 'Believe', artist: 'Cher', album: 'Believe', genre: 'Pop' },
    });
    const queenSong = createTrack({
      id: createTrackId(),
      sourcePath: '/music/Long Live The Queen.mp3',
      raw: { title: 'Long Live The Queen', artist: 'Someone Else' },
    });
    const queenArtist = createTrack({
      id: createTrackId(),
      sourcePath: '/music/Bohemian Rhapsody.mp3',
      raw: { title: 'Bohemian Rhapsody', artist: 'Queen' },
    });

    // Title match outranks an exact artist match - the Phase 1C field-
    // priority policy, exercised here against real Track objects rather
    // than the hand-built fixtures in search.test.ts.
    const results = searchTracks([queenArtist, queenSong], 'queen');
    expect(results.map((r) => r.track.id)).toEqual([queenSong.id, queenArtist.id]);

    expect(searchTracks([believe, queenSong, queenArtist], 'cher').map((r) => r.track.id)).toEqual([
      believe.id,
    ]);
  });

  it('finds a track by its filename-derived fallback title (Phase 1A -> 1C)', () => {
    const track = createTrack({
      id: createTrackId(),
      sourcePath: '/music/Daft Punk - One More Time.mp3',
      raw: {},
    });
    expect(track.titleSource).toBe('filename');
    expect(searchTracks([track], 'one more time').map((r) => r.track.id)).toEqual([track.id]);
  });
});

describe('Scenario B - Track + Queue: stable identity through queue operations', () => {
  const trackA = createTrack({ id: createTrackId(), sourcePath: '/a.mp3', raw: { title: 'A' } });
  const trackB = createTrack({ id: createTrackId(), sourcePath: '/b.mp3', raw: { title: 'B' } });
  const trackC = createTrack({ id: createTrackId(), sourcePath: '/c.mp3', raw: { title: 'C' } });

  it('carries real TrackIds through replace, next/previous, reorder, and repeat', () => {
    let state = replaceQueue([trackA.id, trackB.id, trackC.id], 0);
    expect(getCurrentTrackId(state)).toBe(trackA.id);

    const next = decideOnNextPressed(state);
    expect(next).toEqual({ kind: 'playIndex', index: 1 });
    state = { ...state, currentIndex: next.kind === 'playIndex' ? next.index : state.currentIndex };
    expect(getCurrentTrackId(state)).toBe(trackB.id);

    const previous = decideOnPreviousPressed(state, 500);
    expect(previous).toEqual({ kind: 'playIndex', index: 0 });

    state = reorderQueue(state, 0, 2); // move A after C; current (B) shifts index
    expect(state.tracks).toEqual([trackB.id, trackC.id, trackA.id]);
    expect(getCurrentTrackId(state)).toBe(trackB.id);

    state = setRepeatMode(state, 'all');
    state = { ...state, currentIndex: 2 }; // now on A, the last track
    expect(decideOnTrackFinished(state)).toEqual({ kind: 'playIndex', index: 0 });
  });

  it('removing the current track by real TrackId identity advances correctly', () => {
    const state = replaceQueue([trackA.id, trackB.id, trackC.id], 1);
    const result = removeFromQueue(state, [1]);
    expect(getCurrentTrackId(result)).toBe(trackC.id);
  });
});

describe('Scenario C - Queue + Shuffle: original set and identity preserved', () => {
  it('preserves every real TrackId and the current track through a full shuffle/restore cycle', () => {
    const tracks = Array.from({ length: 6 }, (_, i) =>
      createTrack({ id: createTrackId(), sourcePath: `/t${i}.mp3`, raw: { title: `T${i}` } }),
    );
    const trackIds = tracks.map((t) => t.id);

    const state = replaceQueue(trackIds, 3);
    const currentBefore = getCurrentTrackId(state);

    const shuffled = enableShuffle(state, () => 0.42);
    expect([...shuffled.tracks].sort()).toEqual([...trackIds].sort());
    expect(getCurrentTrackId(shuffled)).toBe(currentBefore);

    const restored = disableShuffle(shuffled);
    expect(restored.tracks).toEqual(trackIds);
    expect(getCurrentTrackId(restored)).toBe(currentBefore);
  });

  it('appending real tracks while shuffled keeps them present after restoring', () => {
    const tracks = [
      createTrack({ id: createTrackId(), sourcePath: '/a.mp3', raw: { title: 'A' } }),
      createTrack({ id: createTrackId(), sourcePath: '/b.mp3', raw: { title: 'B' } }),
    ];
    const extra = createTrack({ id: createTrackId(), sourcePath: '/c.mp3', raw: { title: 'C' } });

    const shuffled = enableShuffle(
      replaceQueue(
        tracks.map((t) => t.id),
        0,
      ),
      () => 0.9,
    );
    const withExtra = appendToQueue(shuffled, [extra.id]);
    const restored = disableShuffle(withExtra);

    expect(restored.tracks).toEqual([...tracks.map((t) => t.id), extra.id]);
  });
});

describe('Scenario D - Lyrics + Playback Time: consistent millisecond units', () => {
  it('looks up the active lyric using the same millisecond unit the parser produces', () => {
    const { lines } = parseLyrics('[00:10.00]First\n[00:20.00]Second\n[00:30.00]Third');

    expect(getActiveLyric(lines, 5000)).toBeUndefined(); // before first
    expect(getActiveLyric(lines, 20_000)?.text).toBe('Second'); // exact
    expect(getActiveLyric(lines, 25_000)?.text).toBe('Second'); // between
    expect(getActiveLyric(lines, 999_999)?.text).toBe('Third'); // after final
  });

  it('applies an offset before lookup, and the result stays in the same millisecond unit', () => {
    const { lines } = parseLyrics('[offset:500]\n[00:10.00]First');
    expect(getActiveLyric(lines, 10_499)).toBeUndefined();
    expect(getActiveLyric(lines, 10_500)?.text).toBe('First');
  });

  it('uses the same millisecond unit as the playback-position threshold used elsewhere in the domain', () => {
    // Phase 1E fix: decideOnPreviousPressed and lyric lookup both take a
    // playback position in milliseconds now - a single value can be passed
    // to both without unit conversion.
    const currentTimeMs = 3000;
    const state = replaceQueue([createTrackId(), createTrackId()], 0);
    const decision = decideOnPreviousPressed(state, currentTimeMs);
    expect(decision).toEqual({ kind: 'restartCurrent' });

    const { lines } = parseLyrics('[00:03.00]Right at the threshold');
    expect(getActiveLyric(lines, currentTimeMs)?.text).toBe('Right at the threshold');
  });
});

describe('Scenario E - Metadata + Search: Phase 1A normalization drives Phase 1C matching', () => {
  it('finds a track by a fallback-derived, whitespace-normalized artist', () => {
    const track = createTrack({
      id: createTrackId(),
      sourcePath: '/music/  Daft   Punk  -  One More Time  .mp3',
      raw: {},
    });
    expect(track.artist).toBe('Daft Punk');
    expect(searchTracks([track], 'daft punk').map((r) => r.track.id)).toEqual([track.id]);
  });

  it('search matching is case-insensitive because it reuses the same normalizeForComparison as metadata policy', () => {
    const track = createTrack({
      id: createTrackId(),
      sourcePath: '/music/x.mp3',
      raw: { title: 'MGMT', artist: 'MGMT' },
    });
    expect(searchTracks([track], 'mgmt').map((r) => r.track.id)).toEqual([track.id]);
  });

  it('a track with only the "Unknown Artist" fallback is still findable, and displayed metadata is unaffected by search', () => {
    const track = createTrack({
      id: createTrackId(),
      sourcePath: '/music/track.mp3',
      raw: { title: 'Track' },
    });
    expect(track.artist).toBe('Unknown Artist');
    const [result] = searchTracks([track], 'unknown artist');
    expect(result?.track.artist).toBe('Unknown Artist'); // unchanged, not lowercased
  });
});
