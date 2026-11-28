import { describe, expect, it } from 'vitest';
import { aliveCount, BURST_MAX, BURST_MIN, createParticles, MAX_PARTICLE_SPEED, particleAlpha, stepParticles } from './particles.js';

const seeded = () => {
  let s = 1;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
};
const quiet = { dt: 1 / 60, beat: false, strength: 0, width: 800, height: 600 };
const hit = (strength: number) => ({ ...quiet, beat: true, strength });

describe('beat-born particles', () => {
  it('start empty and stay empty without a beat, however long it runs (no idle drifting)', () => {
    const p = createParticles(120);
    expect(aliveCount(p)).toBe(0);
    for (let i = 0; i < 600; i += 1) stepParticles(p, quiet, seeded());
    expect(aliveCount(p)).toBe(0);
    expect([...p.x].every((v) => v === 0)).toBe(true);
  });

  it('a beat releases a burst, bigger for a harder hit', () => {
    const soft = createParticles(120);
    const hard = createParticles(120);
    stepParticles(soft, hit(0), seeded());
    stepParticles(hard, hit(1), seeded());
    expect(aliveCount(soft)).toBe(BURST_MIN);
    expect(aliveCount(hard)).toBe(BURST_MAX);
  });

  it('the performance budget scales the burst down', () => {
    const p = createParticles(120);
    stepParticles(p, { ...hit(1), detail: 0.5 }, seeded());
    expect(aliveCount(p)).toBe(Math.round(BURST_MAX * 0.5));
  });

  it('released particles fly outward from the middle and are inside the box when born', () => {
    const p = createParticles(60);
    stepParticles(p, { ...hit(1), dt: 0 }, seeded());
    for (let i = 0; i < p.count; i += 1) {
      if ((p.life[i] as number) <= 0) continue;
      expect(p.x[i]).toBeGreaterThanOrEqual(0);
      expect(p.x[i]).toBeLessThanOrEqual(800);
      const outward = ((p.x[i] as number) - 400) * (p.vx[i] as number) + ((p.y[i] as number) - 300) * ((p.vy[i] as number) + 14);
      expect(outward).toBeGreaterThan(-1); // away from the centre (the small lift aside)
    }
  });

  it('every particle fades out by itself, and the field is empty again about two seconds after the last beat', () => {
    const p = createParticles(80);
    const random = seeded();
    stepParticles(p, hit(1), random);
    expect(aliveCount(p)).toBeGreaterThan(0);
    for (let i = 0; i < 130; i += 1) stepParticles(p, quiet, random); // ~2.2 s
    expect(aliveCount(p)).toBe(0);
  });

  it('frequent beats reuse the pool: never more alive than slots, never faster than the cap, always finite', () => {
    const p = createParticles(60);
    const random = seeded();
    for (let frame = 0; frame < 1200; frame += 1) {
      stepParticles(p, frame % 7 === 0 ? hit(1) : quiet, random);
      expect(aliveCount(p)).toBeLessThanOrEqual(60);
      for (let i = 0; i < p.count; i += 1) {
        expect(Number.isFinite(p.x[i])).toBe(true);
        expect(Math.hypot(p.vx[i] as number, p.vy[i] as number)).toBeLessThanOrEqual(MAX_PARTICLE_SPEED + 1e-3);
      }
    }
  });

  it('is safe with a huge or negative dt, an empty pool and an out-of-range strength', () => {
    const p = createParticles(5);
    expect(() => stepParticles(p, { ...hit(5), dt: 99 })).not.toThrow();
    expect(() => stepParticles(p, { ...hit(-3), dt: -1 })).not.toThrow();
    expect(() => stepParticles(createParticles(0), hit(1))).not.toThrow();
  });

  it('opacity swells in quickly, peaks, and eases to zero at the end of life', () => {
    expect(particleAlpha(1)).toBe(0);
    expect(particleAlpha(0)).toBe(0);
    expect(particleAlpha(0.9)).toBeGreaterThan(0.6);
    expect(particleAlpha(0.5)).toBeLessThan(particleAlpha(0.9));
    expect(particleAlpha(0.1)).toBeLessThan(particleAlpha(0.5));
  });
});
