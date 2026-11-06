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

describe('help from the listener and from stereo', () => {
  it('uses "singing starts / ends here" instead of mistaking an instrumental intro for the voice', async () => {
    const s = scenario([1200, 1200, 1200, 1200, 1200, 1200]);
    const shifted = s.bursts.map((b) => ({ ...b, startMs: b.startMs + 9000 }));
    const intro: Burst = { startMs: 500, durMs: 7500, hz: 900 }; // a lead guitar in the voice band, long before anyone sings
    const f = (await analyseSignal(synthSong(s.total + 9000, [intro, ...shifted], 16_000, { hum: true }), 16_000))!;
    const marked = alignLines(s.weights, f, { windowStartMs: 9000 - 100, windowEndMs: s.total + 9000 });
    s.truth.forEach((t, k) => expect(Math.abs((marked.startsMs[k] ?? -9999) - (t + 9000))).toBeLessThan(500));
    expect(marked.startsMs[0]).toBeGreaterThanOrEqual(8800);
  });
  it('ignores a marker window that is too small for the lines', async () => {
    const s = scenario([1200, 1200, 1200, 1200, 1200, 1200]);
    const f = (await analyseSignal(synthSong(s.total, s.bursts, 16_000, { hum: true }), 16_000))!;
    const r = alignLines(s.weights, f, { windowStartMs: 5000, windowEndMs: 5100 });
    expect(r.startsMs[LINES.length - 1]! - r.startsMs[0]!).toBeGreaterThan(LINES.length * 300);
  });
  it('turns down a guitar that lives only in the stereo sides, and leaves the centred voice alone', async () => {
    const voice: Burst = { startMs: 1000, durMs: 2000, hz: 600 };
    const guitar: Burst = { startMs: 5000, durMs: 2000, hz: 900 };
    const mid = synthSong(9000, [voice, guitar], 16_000);
    const side = synthSong(9000, [guitar], 16_000);
    const mean = (f: { level: Float32Array }, fromMs: number, toMs: number): number => {
      let sum = 0;
      for (let i = fromMs / 20; i < toMs / 20; i += 1) sum += f.level[i] ?? 0;
      return sum / ((toMs - fromMs) / 20);
    };
    const plain = (await analyseSignal(mid, 16_000))!;
    const stereo = (await analyseSignal(mid, 16_000, { side }))!;
    expect(mean(stereo, 1200, 2800)).toBeGreaterThan(0.6); // voice kept
    expect(mean(stereo, 5200, 6800)).toBeLessThan(mean(plain, 5200, 6800) - 0.1); // guitar reduced
  });
});
