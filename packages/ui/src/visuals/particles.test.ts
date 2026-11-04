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

describe('v0.11.3: frequent beats keep the particles on screen', () => {
  it('after hundreds of beats nothing is outside the width, and nothing exceeds the speed cap', async () => {
    const { createParticles, stepParticles, MAX_PARTICLE_SPEED } = await import('./particles.js');
    const system = createParticles(180, 800, 500);
    for (let frame = 0; frame < 900; frame += 1) {
      stepParticles(system, { dt: 1 / 60, level: 0.9, pulse: 1, beat: frame % 8 === 0, width: 800, height: 500 });
      for (let i = 0; i < system.count; i += 1) {
        expect(system.x[i]).toBeGreaterThanOrEqual(-14);
        expect(system.x[i]).toBeLessThanOrEqual(814);
        expect(Math.hypot(system.vx[i] as number, system.vy[i] as number)).toBeLessThanOrEqual(MAX_PARTICLE_SPEED + 1e-3);
      }
    }
  });
});

describe('v0.13.1: the particles fill the whole width, including both outer edges', () => {
  it('after many beats there are particles in the outer 10% on the left AND the right', async () => {
    const { createParticles, stepParticles } = await import('./particles.js');
    const system = createParticles(150, 1000, 600);
    for (let frame = 0; frame < 1500; frame += 1) stepParticles(system, { dt: 1 / 60, level: 0.8, pulse: 1, beat: frame % 10 === 0, width: 1000, height: 600 });
    let left = 0;
    let right = 0;
    for (let i = 0; i < system.count; i += 1) {
      if ((system.x[i] as number) < 100) left += 1;
      if ((system.x[i] as number) > 900) right += 1;
    }
    expect(left).toBeGreaterThanOrEqual(8);
    expect(right).toBeGreaterThanOrEqual(8);
  });
});
