import { describe, expect, it } from 'vitest';
import { createParticles, stepParticles } from './particles.js';

const seeded = () => {
  let s = 1;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
};
const input = { dt: 0.016, level: 0.3, pulse: 0, beat: false, width: 800, height: 600 };

describe('particles', () => {
  it('creates the requested number inside the box', () => {
    const p = createParticles(100, 800, 600, seeded());
    expect(p.count).toBe(100);
    expect([...p.x].every((v) => v >= 0 && v <= 800)).toBe(true);
    expect([...p.y].every((v) => v >= 0 && v <= 600)).toBe(true);
  });
  it('drifts upward and respawns below when leaving the top', () => {
    const random = seeded();
    const p = createParticles(20, 800, 600, random);
    const before = Float32Array.from(p.y);
    stepParticles(p, input, random);
    expect([...p.y].filter((v, i) => v < (before[i] as number)).length).toBeGreaterThan(15);
    for (let i = 0; i < 4000; i += 1) stepParticles(p, input, random);
    expect([...p.y].every((v) => v > -60 && v < 600 + 180)).toBe(true); // never lost
  });
  it('a beat lights every particle and kicks it away from the centre', () => {
    const random = seeded();
    const p = createParticles(30, 800, 600, random);
    p.x.fill(700);
    p.y.fill(300);
    p.vx.fill(0);
    stepParticles(p, { ...input, beat: true }, random);
    expect([...p.glow].every((g) => g > 0.9)).toBe(true);
    expect([...p.vx].every((v) => v > 0)).toBe(true); // pushed right, away from the centre
  });
  it('glow decays and louder music moves particles faster', () => {
    const random = seeded();
    const quiet = createParticles(10, 800, 600, seeded());
    const loud = createParticles(10, 800, 600, seeded());
    stepParticles(quiet, { ...input, beat: true }, random);
    for (let i = 0; i < 60; i += 1) stepParticles(quiet, input, random);
    expect([...quiet.glow].every((g) => g === 0)).toBe(true);
    const y0 = loud.y[0] as number;
    const y1 = quiet.y[0] as number;
    void y1;
    stepParticles(loud, { ...input, level: 1 }, seeded());
    const slow = createParticles(10, 800, 600, seeded());
    stepParticles(slow, { ...input, level: 0 }, seeded());
    expect(y0 - (loud.y[0] as number)).toBeGreaterThan(y0 - (slow.y[0] as number));
  });
  it('is safe with a huge or negative dt', () => {
    const p = createParticles(5, 100, 100, seeded());
    expect(() => stepParticles(p, { ...input, dt: 99 })).not.toThrow();
    expect(() => stepParticles(p, { ...input, dt: -1 })).not.toThrow();
    expect([...p.x].every(Number.isFinite)).toBe(true);
  });
});
