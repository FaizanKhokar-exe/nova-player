import type { VocalFeatures } from './vocal-features.js';

/**
 * Timing that arrives from elsewhere (a lyrics catalogue's timestamps for ANOTHER recording of the song) is usually
 * right in shape but wrong in position: a different intro length shifts everything, a slightly different speed or a
 * trimmed ending stretches it. This finds the one shift + stretch that makes the most line starts land on real sound
 * onsets / phrase starts of THIS recording, and applies it - or leaves the timing alone if nothing fits clearly better.
 */

export interface Calibration {
  readonly times: number[];
  /** 1 = no stretch. */
  readonly scale: number;
  readonly offsetMs: number;
  /** True when a shift/stretch was applied. */
  readonly changed: boolean;
}

function startness(f: VocalFeatures): Float32Array {
  const frames = f.onset.length;
  const raw = new Float32Array(frames);
  for (const phrase of f.phrases) raw[Math.min(frames - 1, Math.round(phrase.startMs / f.frameMs))] = 1;
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    let best = f.onset[i] ?? 0;
    for (let k = Math.max(0, i - 3); k <= Math.min(frames - 1, i + 3); k += 1) best = Math.max(best, raw[k] ?? 0);
    out[i] = best;
  }
  return out;
}

export function calibrateTimes(times: readonly number[], f: VocalFeatures, sourceDurationMs?: number): Calibration {
  const identity: Calibration = { times: [...times], scale: 1, offsetMs: 0, changed: false };
  if (times.length < 3 || f.onset.length === 0 || f.phrases.length === 0) return identity;
  const sn = startness(f);
  const frames = sn.length;
  const scoreOf = (a: number, b: number): number => {
    let sum = 0;
    for (const t of times) {
      const fr = Math.round((a * t + b) / f.frameMs);
      if (fr < 0 || fr >= frames) continue;
      sum += sn[fr] ?? 0;
    }
    return sum;
  };
  const scales = new Set<number>();
  for (let a = 0.96; a <= 1.0401; a += 0.005) scales.add(Math.round(a * 1000) / 1000);
  if (sourceDurationMs !== undefined && sourceDurationMs > 0 && f.durationMs > 0) {
    const ratio = f.durationMs / sourceDurationMs;
    if (ratio > 0.9 && ratio < 1.1) for (let d = -0.01; d <= 0.0101; d += 0.0025) scales.add(Math.round((ratio + d) * 10000) / 10000);
  }
  const base = scoreOf(1, 0);
  let best = { a: 1, b: 0, score: base };
  for (const a of scales) {
    for (let b = -6000; b <= 6000; b += 40) {
      const score = scoreOf(a, b) - 0.00002 * Math.abs(b) - 0.5 * Math.abs(a - 1); // prefer the smaller correction on a tie
      if (score > best.score) best = { a, b, score };
    }
  }
  // Only trust a correction that clearly beats leaving things alone.
  if ((best.a === 1 && best.b === 0) || best.score < base * 1.15 + 0.5) return identity;
  return { times: times.map((t) => Math.max(0, Math.round(best.a * t + best.b))), scale: best.a, offsetMs: best.b, changed: true };
}

/** Pulls each line start to the clearest sound beginning within +-`reachMs` (only when it is clearly one), keeping the order. */
export function snapLines(times: readonly number[], f: VocalFeatures, reachMs = 300): number[] {
  if (f.onset.length === 0) return [...times];
  const sn = startness(f);
  const reach = Math.round(reachMs / f.frameMs);
  const out: number[] = [];
  times.forEach((t, i) => {
    const centre = Math.round(t / f.frameMs);
    let bestFrame = -1;
    let bestScore = 0.5;
    for (let fr = Math.max(0, centre - reach); fr <= Math.min(sn.length - 1, centre + reach); fr += 1) {
      const score = (sn[fr] ?? 0) - (0.3 * Math.abs(fr - centre)) / Math.max(1, reach);
      if ((sn[fr] ?? 0) >= 0.6 && score > bestScore) {
        bestScore = score;
        bestFrame = fr;
      }
    }
    const snapped = bestFrame < 0 ? t : bestFrame * f.frameMs;
    out.push(Math.max(i === 0 ? 0 : (out[i - 1] ?? 0), Math.round(snapped)));
  });
  return out;
}
