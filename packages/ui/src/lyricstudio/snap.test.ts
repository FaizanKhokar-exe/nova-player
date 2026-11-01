import { describe, expect, it } from 'vitest';
import { overview, snapToOnset } from './snap.js';
import { synthSong } from './synthetic.js';
import { analyseSignal } from './vocal-features.js';

describe('snapToOnset', () => {
  it('pulls a late or early tap to the real onset, and leaves it alone far from any', async () => {
    const f = (await analyseSignal(synthSong(8000, [{ startMs: 3000, durMs: 1500 }]), 16_000))!;
    for (const tap of [2800, 2900, 3100, 3200]) expect(Math.abs(snapToOnset(f, tap) - 3000), `tap ${tap}`).toBeLessThanOrEqual(60);
    expect(snapToOnset(f, 6500)).toBe(6500);
    expect(snapToOnset(f, -50)).toBe(0);
  });
  it('summarises loudness into a fixed number of buckets', async () => {
    const f = (await analyseSignal(synthSong(8000, [{ startMs: 4000, durMs: 2000 }]), 16_000))!;
    const o = overview(f, 8);
    expect(o).toHaveLength(8);
    expect(o[0]).toBeLessThan(0.2);
    expect(Math.max(...o.slice(4, 6))).toBeGreaterThan(0.6);
  });
});
