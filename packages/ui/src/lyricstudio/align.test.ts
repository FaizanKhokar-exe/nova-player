import { describe, expect, it } from 'vitest';
import { alignLines } from './align.js';
import { synthSong, type Burst } from './synthetic.js';
import { analyseSignal } from './vocal-features.js';
import { lineWeight } from './syllables.js';

const LINES = ['hello darling come to me', 'I have been waiting', 'under the silver moon tonight', 'hold me', 'never let me go away from here', 'goodbye'];

/** Lines sung at 250 ms per syllable-unit with pauses of varying length between them. */
function scenario(pauses: readonly number[]) {
  const weights = LINES.map(lineWeight);
  const bursts: Burst[] = [];
  const truth: number[] = [];
  let at = 2000;
  LINES.forEach((_, index) => {
    const dur = (weights[index] ?? 1) * 330;
    truth.push(at);
    bursts.push({ startMs: at, durMs: dur, hz: 500 + (index % 3) * 150 });
    at += dur + (pauses[index] ?? 1200);
  });
  return { weights, bursts, truth, total: at + 1500 };
}

describe('the analysis', () => {
  it('finds one phrase per sung burst and ignores a bass hum', async () => {
    const s = scenario([1200, 1200, 1200, 1200, 1200, 1200]);
    const f = await analyseSignal(synthSong(s.total, s.bursts, 16_000, { hum: true }), 16_000);
    expect(f?.phrases).toHaveLength(LINES.length);
    s.truth.forEach((t, k) => expect(Math.abs((f?.phrases[k]?.startMs ?? -9999) - t)).toBeLessThan(120));
  });
  it('can be cancelled', async () => {
    expect(await analyseSignal(new Float32Array(16_000 * 30), 16_000, { isCancelled: () => true })).toBeUndefined();
  });
});

describe('alignLines on a synthetic song', () => {
  it('places every line within 250 ms of the truth when the voice pauses between lines', async () => {
    const s = scenario([1500, 900, 1800, 1100, 1300, 1000]);
    const f = (await analyseSignal(synthSong(s.total, s.bursts, 16_000, { hum: true }), 16_000))!;
    const r = alignLines(s.weights, f);
    s.truth.forEach((t, k) => expect(Math.abs((r.startsMs[k] ?? -9999) - t), `line ${k}`).toBeLessThan(250));
    expect(Math.min(...r.confidence)).toBeGreaterThan(0.45);
  });

  it('copes with a long instrumental gap in the middle', async () => {
    const s = scenario([1200, 1200, 9000, 1200, 1200, 1200]);
    const f = (await analyseSignal(synthSong(s.total, s.bursts), 16_000))!;
    const r = alignLines(s.weights, f);
    s.truth.forEach((t, k) => expect(Math.abs((r.startsMs[k] ?? -9999) - t), `line ${k}`).toBeLessThan(300));
  });

  it('falls back to proportional spacing, flagged low confidence, when nothing is sung', async () => {
    const f = (await analyseSignal(synthSong(60_000, []), 16_000))!;
    const r = alignLines(LINES.map(lineWeight), f);
    expect(r.startsMs[0]).toBeLessThan(1000);
    expect(r.startsMs.every((v, k) => k === 0 || v >= (r.startsMs[k - 1] ?? 0))).toBe(true);
    expect(Math.max(...r.confidence)).toBeLessThan(0.45);
  });

  it('keeps locked lines exactly and re-solves the gap around them', async () => {
    const s = scenario([1500, 900, 1800, 1100, 1300, 1000]);
    const f = (await analyseSignal(synthSong(s.total, s.bursts), 16_000))!;
    const anchors = new Map<number, number>([[2, Math.round(s.truth[2] ?? 0)]]);
    const r = alignLines(s.weights, f, { anchors });
    expect(r.startsMs[2]).toBe(Math.round(s.truth[2] ?? 0));
    expect(r.confidence[2]).toBe(1);
    s.truth.forEach((t, k) => expect(Math.abs((r.startsMs[k] ?? -9999) - t), `line ${k}`).toBeLessThan(250));
    // a wrong lock is obeyed, and lines after it stay in order inside the song
    const moved = alignLines(s.weights, f, { anchors: new Map([[3, Math.round(s.truth[3] ?? 0) + 4000]]) });
    expect(moved.startsMs[3]).toBe(Math.round(s.truth[3] ?? 0) + 4000);
    expect(moved.startsMs.every((v, k) => k === 0 || v >= (moved.startsMs[k - 1] ?? 0))).toBe(true);
  });

  it('handles one line, no lines, and more lines than the song can hold', async () => {
    const f = (await analyseSignal(synthSong(5000, [{ startMs: 500, durMs: 2000 }]), 16_000))!;
    expect(alignLines([], f).startsMs).toEqual([]);
    expect(Math.abs((alignLines([3], f).startsMs[0] ?? 0) - 500)).toBeLessThan(250);
    const many = alignLines(new Array<number>(40).fill(2), f);
    expect(many.startsMs).toHaveLength(40);
    expect(many.startsMs.every((v, k) => k === 0 || v >= (many.startsMs[k - 1] ?? 0))).toBe(true);
  });
});
