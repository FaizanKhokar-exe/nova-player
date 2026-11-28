/**
 * The particles behind Lyrics Mode, driven ONLY by the music's beats. Nothing drifts on its own: a detected beat
 * releases a small burst of particles (more and stronger for a harder hit), each lives about a second and a half,
 * flies outward from the middle with drag, and fades. No beat means no new particles, silence means an empty field.
 * A fixed pool is reused as a ring (no allocation per frame). Pure maths over typed arrays, so it is unit-tested;
 * the canvas component only draws what this computes.
 */

export interface ParticleSystem {
  readonly count: number;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  /** Base radius in px. */
  readonly size: Float32Array;
  /** 0..1 remaining life; 0 = free slot. */
  readonly life: Float32Array;
  /** Life span in seconds. */
  readonly span: Float32Array;
  /** 0..1 how hard the beat that released it was (brightness). */
  readonly strength: Float32Array;
  /** 0..1 depth: far particles are small, slow and dim. */
  readonly depth: Float32Array;
  /** Which of the three accent sprites to use (0, 1, 2). */
  readonly tint: Uint8Array;
  /** Next slot to reuse (ring). */
  cursor: number;
}

/** A small seeded generator for visual jitter only (no queue or shuffle logic lives here). */
let seed = 0x9e3779b9;
export function visualRandom(): number {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function createParticles(count: number): ParticleSystem {
  return {
    count,
    x: new Float32Array(count),
    y: new Float32Array(count),
    vx: new Float32Array(count),
    vy: new Float32Array(count),
    size: new Float32Array(count),
    life: new Float32Array(count),
    span: new Float32Array(count).fill(1.5),
    strength: new Float32Array(count),
    depth: new Float32Array(count),
    tint: new Uint8Array(count),
    cursor: 0,
  };
}

/** Fastest a particle may move (px/s). */
export const MAX_PARTICLE_SPEED = 120;
/** Particles released by the softest and the hardest beat (before the performance budget scales them). */
export const BURST_MIN = 4;
export const BURST_MAX = 16;

export interface ParticleInput {
  /** Seconds since the previous step (clamped inside). */
  readonly dt: number;
  readonly beat: boolean;
  /** 0..1 how hard this beat was (the beat analyser's pulse); only read when `beat` is true. */
  readonly strength: number;
  /** Scales the burst size with the performance mode (0.3..1). */
  readonly detail?: number;
  readonly width: number;
  readonly height: number;
}

function release(s: ParticleSystem, strength: number, width: number, height: number, random: () => number): void {
  const i = s.cursor;
  s.cursor = (i + 1) % s.count;
  const depth = random();
  const cx = width / 2;
  const cy = height / 2;
  const x = random() * width;
  const y = height * (0.12 + random() * 0.76);
  const dx = x - cx;
  const dy = y - cy;
  const length = Math.hypot(dx, dy) || 1;
  const speed = (16 + strength * 46) * (0.45 + depth * 0.75);
  s.x[i] = x;
  s.y[i] = y;
  s.vx[i] = (dx / length) * speed;
  s.vy[i] = (dy / length) * speed - (4 + depth * 10); // a little lift
  s.size[i] = (1.6 + depth * 4.4 + random() * 1.2) * (0.75 + strength * 0.5);
  s.span[i] = 1.1 + random() * 0.8;
  s.life[i] = 1;
  s.strength[i] = strength;
  s.depth[i] = depth;
  s.tint[i] = Math.floor(random() * 3);
}

export function stepParticles(s: ParticleSystem, input: ParticleInput, random: () => number = visualRandom): void {
  if (s.count === 0) return;
  const dt = Math.min(0.05, Math.max(0, input.dt));
  if (input.beat) {
    const strength = Math.min(1, Math.max(0, input.strength));
    const wanted = (BURST_MIN + (BURST_MAX - BURST_MIN) * strength) * Math.min(1, Math.max(0.3, input.detail ?? 1));
    for (let n = 0; n < Math.round(wanted); n += 1) release(s, strength, input.width, input.height, random);
  }
  const drag = Math.exp(-dt * 1.7);
  for (let i = 0; i < s.count; i += 1) {
    const life = s.life[i] as number;
    if (life <= 0) continue;
    let vx = (s.vx[i] as number) * drag;
    let vy = (s.vy[i] as number) * drag;
    const v = Math.hypot(vx, vy);
    if (v > MAX_PARTICLE_SPEED) {
      vx = (vx / v) * MAX_PARTICLE_SPEED;
      vy = (vy / v) * MAX_PARTICLE_SPEED;
    }
    s.vx[i] = vx;
    s.vy[i] = vy;
    s.x[i] = (s.x[i] as number) + vx * dt;
    s.y[i] = (s.y[i] as number) + vy * dt;
    s.life[i] = Math.max(0, life - dt / (s.span[i] as number));
  }
}

/** 0..1 opacity over a particle's life: a quick swell in, a slow ease out. */
export function particleAlpha(life: number): number {
  const age = 1 - life;
  const attack = Math.min(1, age / 0.1);
  return attack * life * life * (3 - 2 * life); // smoothstep release
}

/** How many particles are alive (for tests and to skip drawing an empty field). */
export function aliveCount(s: ParticleSystem): number {
  let n = 0;
  for (let i = 0; i < s.count; i += 1) if ((s.life[i] as number) > 0) n += 1;
  return n;
}
