import { describe, expect, it, vi } from 'vitest';
import type { NovaBridge } from '@nova/shared';
import type { PlaybackStoreApi } from '../playback/playback-store.js';
import { createStudioStore } from './studio-store.js';
import { synthSong } from './synthetic.js';
import { lineWeight } from './syllables.js';

const TRACK = '123e4567-e89b-42d3-a456-426614174000';
const LYRICS = ['hello darling come to me', 'I have been waiting', 'under the silver moon tonight', 'hold me'];

function song() {
  const weights = LYRICS.map(lineWeight);
  const bursts: { startMs: number; durMs: number }[] = [];
  const truth: number[] = [];
  let at = 2000;
  for (const w of weights) {
    truth.push(at);
    bursts.push({ startMs: at, durMs: w * 330 });
    at += w * 330 + 1300;
  }
  return { truth, samples: synthSong(at + 1500, bursts), total: at + 1500 };
}

function harness(options: { signal?: boolean; live?: number } = {}) {
  const s = song();
  const calls: [string, unknown][] = [];
  let live = options.live ?? 0;
  const playback = {
    getState: () => ({
      session: { current: { track: { id: TRACK, title: 'Moon', artist: 'Someone' } } },
      engine: { durationMs: s.total, playing: true },
      monoSignal: async () => (options.signal === false ? undefined : { samples: s.samples, sampleRate: 16_000 }),
      livePositionMs: () => live,
      seekMs: vi.fn(),
      togglePlay: vi.fn(),
    }),
  } as unknown as PlaybackStoreApi;
  const bridge = {
    invoke: async (channel: string, request: unknown) => {
      calls.push([channel, request]);
      if (channel === 'lyrics:search') return { ok: true, value: { status: 'ok', title: 'Moon', artist: 'Someone', candidates: [{ id: 1, title: 'Moon', artist: 'Someone', album: '', instrumental: false, plain: LYRICS.join('\n'), syncedLines: [{ timeMs: 2000, text: 'hello darling come to me' }, { timeMs: 5000, text: 'I have been waiting' }, { timeMs: 8000, text: 'under the silver moon tonight' }, { timeMs: 12000, text: 'hold me' }], match: 1 }] } };
      return { ok: true, value: { outcome: 'saved-beside' } };
    },
  } as unknown as NovaBridge;
  const saved = vi.fn();
  const store = createStudioStore(bridge, playback, saved);
  return { store, calls, saved, truth: s.truth, setLive: (v: number) => void (live = v) };
}

describe('Lyric Studio store', () => {
  it('opens on the playing song, searches with the tags, and fills the text from a result', async () => {
    const h = harness();
    h.store.getState().openStudio();
    expect(h.store.getState()).toMatchObject({ open: true, trackId: TRACK, queryTitle: 'Moon', queryArtist: 'Someone' });
    h.store.getState().setQuery('Moon (live)', 'Someone');
    await h.store.getState().runSearch();
    expect(h.calls[0]).toEqual(['lyrics:search', { trackId: TRACK, title: 'Moon (live)', artist: 'Someone' }]);
    expect(h.store.getState().search.status).toBe('done');
    h.store.getState().pickCandidate(h.store.getState().search.candidates[0]!, false);
    expect(h.store.getState().text.split('\n')).toHaveLength(4);
    expect(h.store.getState().startFromSynced).toBe(false);
  });

  it('estimates times from the audio, then stamping a line locks it and pulls the later lines along', async () => {
    const h = harness();
    h.store.getState().openStudio();
    h.store.getState().setText(LYRICS.join('\n'));
    await h.store.getState().begin();
    const s = h.store.getState();
    expect(s.step).toBe('timing');
    s.times.forEach((t, k) => expect(Math.abs(t - (h.truth[k] ?? 0)), `line ${k}`).toBeLessThan(250));
    // the listener taps line 0 a little late; it snaps to the real onset and locks
    h.setLive((h.truth[0] ?? 0) + 120 + 90);
    h.store.getState().stamp();
    expect(Math.abs((h.store.getState().times[0] ?? 0) - (h.truth[0] ?? 0))).toBeLessThanOrEqual(80);
    expect(h.store.getState().locks.has(0)).toBe(true);
    expect(h.store.getState().selected).toBe(1);
    expect(h.store.getState().canUndo).toBe(true);
    h.store.getState().undo();
    expect(h.store.getState().locks.has(0)).toBe(false);
  });

  it('nudges inside its neighbours, shifts everything, and keeps times in order', async () => {
    const h = harness();
    h.store.getState().openStudio();
    h.store.getState().setText(LYRICS.join('\n'));
    await h.store.getState().begin();
    const before = h.store.getState().times;
    h.store.getState().nudge(1, 100);
    expect(h.store.getState().times[1]).toBe((before[1] ?? 0) + 100);
    h.store.getState().nudge(1, 999_999);
    expect(h.store.getState().times[1]).toBe(before[2]);
    h.store.getState().shiftAll(-500);
    const t = h.store.getState().times;
    expect(t.every((v, k) => k === 0 || v >= (t[k - 1] ?? 0))).toBe(true);
    expect(h.store.getState().locks.has(1)).toBe(true);
  });

  it('can start from a result\'s own timestamps', async () => {
    const h = harness();
    h.store.getState().openStudio();
    await h.store.getState().runSearch();
    h.store.getState().pickCandidate(h.store.getState().search.candidates[0]!, true);
    await h.store.getState().begin();
    expect(h.store.getState().times).toEqual([2000, 5000, 8000, 12000]);
    expect(h.store.getState().confidence.every((c) => c === 0.8)).toBe(true);
  });

  it('falls back to evenly spaced, flagged guesses when the audio cannot be read', async () => {
    const h = harness({ signal: false });
    h.store.getState().openStudio();
    h.store.getState().setText(LYRICS.join('\n'));
    await h.store.getState().begin();
    const s = h.store.getState();
    expect(s.analysisFailed).toBe(true);
    expect(s.times).toHaveLength(4);
    expect(Math.max(...s.confidence)).toBeLessThan(0.45);
  });

  it('saves the built .lrc and tells the app; close() resets everything', async () => {
    const h = harness();
    h.store.getState().openStudio();
    h.store.getState().setText(LYRICS.join('\n'));
    await h.store.getState().begin();
    await h.store.getState().saveLrc();
    const call = h.calls.find(([channel]) => channel === 'lyrics:save');
    expect(call?.[1]).toMatchObject({ trackId: TRACK });
    const lrc = (call?.[1] as { lrc: string }).lrc;
    expect(lrc).toMatch(/^\[ti:Moon\]\n\[ar:Someone\]\n\[by:Nova Player Lyric Studio\]\n\[00:0\d\.\d\d\]hello darling come to me\n/);
    expect(h.store.getState().save).toMatchObject({ status: 'saved', outcome: 'saved-beside' });
    expect(h.saved).toHaveBeenCalledTimes(1);
    h.store.getState().close();
    expect(h.store.getState()).toMatchObject({ open: false, step: 'source', text: '', times: [] });
  });

  it('does nothing without a playing song or without any lines', async () => {
    const h = harness();
    h.store.getState().openStudio();
    await h.store.getState().begin();
    expect(h.store.getState().step).toBe('source');
  });
});
