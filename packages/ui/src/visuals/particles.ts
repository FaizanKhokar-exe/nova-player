/**
 * The particle field behind Lyrics Mode. A small, allocation-free simulation: every particle drifts upward and
 * sideways, the music's level scales the drift speed, and a BEAT kicks every particle outward from the centre and
 * pulses its size. Pure maths over typed arrays (no canvas, no DOM), so it is unit-tested; the canvas component
 * only draws what this computes.
 */

export interface ParticleSystem {
  readonly count: number;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  /** Base radius in px. */
  readonly size: Float32Array;
  /** 0..1, how strongly the particle is lit by a beat; decays. */
  readonly glow: Float32Array;
  /** 0..1 depth: far particles are small, slow and dim. */
  readonly depth: Float32Array;
  /** Which of the three accent sprites to use (0, 1, 2). */
  readonly tint: Uint8Array;
}

/** A small seeded generator for visual jitter only (no queue or shuffle logic lives here). */
let seed = 0x9e3779b9;
export function visualRandom(): number {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function createParticles(count: number, width: number, height: number, random: () => number = visualRandom): ParticleSystem {
  const system: ParticleSystem = {
    count,
    x: new Float32Array(count),
    y: new Float32Array(count),
    vx: new Float32Array(count),
    vy: new Float32Array(count),
    size: new Float32Array(count),
    glow: new Float32Array(count),
    depth: new Float32Array(count),
    tint: new Uint8Array(count),
  };
  for (let i = 0; i < count; i += 1) respawn(system, i, width, height, random, true);
  return system;
}

function respawn(s: ParticleSystem, i: number, width: number, height: number, random: () => number, anywhere: boolean): void {
  const depth = random();
  s.depth[i] = depth;
  s.x[i] = random() * width;
  s.y[i] = anywhere ? random() * height : height + 20 + random() * 40;
  s.vx[i] = (random() - 0.5) * 8 * (0.4 + depth);
  s.vy[i] = -(6 + random() * 14) * (0.4 + depth);
  s.size[i] = 1.4 + depth * 4.6 + random() * 1.5;
  s.glow[i] = 0;
  s.tint[i] = Math.floor(random() * 3);
}

export interface ParticleInput {
  /** Seconds since the previous step (clamped inside). */
  readonly dt: number;
  /** 0..1 overall music level. */
  readonly level: number;
  /** 0..1 pulse (1 on a beat, decaying). */
  readonly pulse: number;
  readonly beat: boolean;
  readonly width: number;
  readonly height: number;
}

export function stepParticles(s: ParticleSystem, input: ParticleInput, random: () => number = visualRandom): void {
  const dt = Math.min(0.05, Math.max(0, input.dt));
  const speed = 0.55 + input.level * 2.4;
  const cx = input.width / 2;
  const cy = input.height / 2;
  for (let i = 0; i < s.count; i += 1) {
    if (input.beat) {
      // Kick away from the centre, stronger for near (deep) particles.
      const dx = (s.x[i] as number) - cx;
      const dy = (s.y[i] as number) - cy;
      const length = Math.hypot(dx, dy) || 1;
      const strength = 26 + (s.depth[i] as number) * 70;
      s.vx[i] = (s.vx[i] as number) + (dx / length) * strength;
      s.vy[i] = (s.vy[i] as number) + (dy / length) * strength;
      s.glow[i] = 1;
    }
    // Drag pulls velocity back to a gentle drift, so a kick fades instead of flinging particles away.
    const drag = Math.exp(-dt * 2.4);
    const driftY = -(6 + (s.depth[i] as number) * 14) * speed;
    s.vx[i] = (s.vx[i] as number) * drag;
    s.vy[i] = driftY + ((s.vy[i] as number) - driftY) * drag;
    s.x[i] = (s.x[i] as number) + (s.vx[i] as number) * dt * speed;
    s.y[i] = (s.y[i] as number) + (s.vy[i] as number) * dt * speed;
    s.glow[i] = Math.max(0, (s.glow[i] as number) - dt * 2.2);
    const margin = 60;
    if ((s.y[i] as number) < -margin || (s.x[i] as number) < -margin || (s.x[i] as number) > input.width + margin || (s.y[i] as number) > input.height + margin * 3) {
      respawn(s, i, input.width, input.height, random, false);
    }
  }
}
