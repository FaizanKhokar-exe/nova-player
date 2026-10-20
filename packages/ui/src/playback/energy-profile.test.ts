import { describe, expect, it, vi } from 'vitest';
import { bucketEnergy, createProfileLoader } from './energy-profile.js';

describe('bucketEnergy', () => {
  it('is loud where the signal is loud and quiet where it is quiet', () => {
    const samples = new Float32Array(16_000);
    for (let i = 8_000; i < 16_000; i += 1) samples[i] = Math.sin(i / 5) * 0.8;
    const profile = bucketEnergy([samples], 8);
    expect(profile).toHaveLength(8);
    expect(Math.max(...profile.slice(0, 4))).toBeLessThan(0.05);
    expect(Math.min(...profile.slice(4))).toBeGreaterThan(0.7);
  });
  it('returns nothing for silence-free emptiness and zeros for pure silence', () => {
    expect(bucketEnergy([])).toEqual([]);
    expect(bucketEnergy([new Float32Array(1000)], 4)).toEqual([0, 0, 0, 0]);
  });
});

describe('createProfileLoader', () => {
  it('fetches once per track, remembers the answer, and retries after a failure', async () => {
    const fetchBytes = vi.fn(async () => new ArrayBuffer(8));
    const decode = vi.fn(async () => [Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i))]);
    const load = createProfileLoader({ fetchBytes, decode });
    const a = await load('t1', 'u1');
    await load('t1', 'u1');
    expect(a?.length).toBeGreaterThan(0);
    expect(fetchBytes).toHaveBeenCalledTimes(1);

    const failing = vi.fn(async () => { throw new Error('nope'); });
    const loadFail = createProfileLoader({ fetchBytes: failing, decode });
    expect(await loadFail('t2', 'u2')).toBeUndefined();
    await Promise.resolve();
    expect(await loadFail('t2', 'u2')).toBeUndefined();
    expect(failing).toHaveBeenCalledTimes(2);
  });
});
