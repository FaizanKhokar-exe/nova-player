import { describe, expect, it } from 'vitest';
import { calibrateTimes, snapLines } from './calibrate.js';
import { synthSong } from './synthetic.js';
import { analyseSignal } from './vocal-features.js';

async function song() {
  const truth = [2000, 6200, 9100, 14800, 18000, 23500, 27200, 31900];
  const bursts = truth.map((t, i) => ({ startMs: t, durMs: 1500 + (i % 3) * 700, hz: 500 + (i % 4) * 130 }));
  const f = (await analyseSignal(synthSong(38_000, bursts), 16_000))!;
  return { truth, f };
}

describe('calibrateTimes', () => {
  it('undoes a wrong intro length (shift)', async () => {
    const { truth, f } = await song();
    const found = truth.map((t) => t + 2840); // another recording starts 2.84 s later
    const result = calibrateTimes(found, f);
    result.times.forEach((t, i) => expect(Math.abs(t - (truth[i] ?? 0)), `line ${i}`).toBeLessThan(120));
    expect(result.changed).toBe(true);
  });
  it('undoes a shift plus a slight speed difference', async () => {
    const { truth, f } = await song();
    const found = truth.map((t) => Math.round((t - 800) / 1.015));
    const result = calibrateTimes(found, f, Math.round(38_000 / 1.015));
    result.times.forEach((t, i) => expect(Math.abs(t - (truth[i] ?? 0)), `line ${i}`).toBeLessThan(150));
  });
  it('leaves already-correct timing alone, and does nothing without enough lines or sound', async () => {
    const { truth, f } = await song();
    expect(calibrateTimes(truth, f)).toMatchObject({ changed: false, times: truth });
    expect(calibrateTimes([1000, 2000], f).changed).toBe(false);
    const silent = (await analyseSignal(synthSong(10_000, []), 16_000))!;
    expect(calibrateTimes([1000, 2000, 3000, 4000], silent).changed).toBe(false);
  });
});

describe('snapLines', () => {
  it('pulls slightly-off starts onto real onsets and keeps the order', async () => {
    const { truth, f } = await song();
    const off = truth.map((t, i) => t + (i % 2 === 0 ? 180 : -150));
    const snapped = snapLines(off, f);
    snapped.forEach((t, i) => expect(Math.abs(t - (truth[i] ?? 0)), `line ${i}`).toBeLessThan(80));
    expect(snapped.every((v, i) => i === 0 || v >= (snapped[i - 1] ?? 0))).toBe(true);
  });
});
