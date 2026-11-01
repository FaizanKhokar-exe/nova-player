import type { VocalFeatures } from './vocal-features.js';

export const SNAP_WINDOW_MS = 250;
/** People tap a little after the sound begins; this much is taken off a live tap before snapping. */
export const TAP_LAG_MS = 120;

/**
 * "Magnetic" snapping: a tap lands near, not on, the moment a line starts. Pull it to the strongest sound onset within
 * +-250 ms (nearer onsets win ties), or leave it alone when nothing there is clearly a beginning.
 */
export function snapToOnset(f: VocalFeatures, ms: number, windowMs: number = SNAP_WINDOW_MS): number {
  const centre = Math.round(ms / f.frameMs);
  const reach = Math.round(windowMs / f.frameMs);
  let best = -1;
  let bestScore = 0.3 - 1e-9; // an onset weaker than 0.3 is not "clearly a beginning"
  for (let fr = Math.max(0, centre - reach); fr <= Math.min(f.onset.length - 1, centre + reach); fr += 1) {
    const score = (f.onset[fr] ?? 0) - (0.35 * Math.abs(fr - centre)) / Math.max(1, reach);
    if ((f.onset[fr] ?? 0) >= 0.3 && score > bestScore) {
      bestScore = score;
      best = fr;
    }
  }
  return best < 0 ? Math.max(0, Math.round(ms)) : best * f.frameMs;
}

/** The loudness curve reduced to `buckets` values (the loudest frame in each slice), for the timeline strip. */
export function overview(f: VocalFeatures, buckets: number): number[] {
  const out: number[] = [];
  const frames = f.level.length;
  for (let b = 0; b < buckets; b += 1) {
    const from = Math.floor((b * frames) / buckets);
    const to = Math.max(from + 1, Math.floor(((b + 1) * frames) / buckets));
    let peak = 0;
    for (let i = from; i < to; i += 1) peak = Math.max(peak, f.level[i] ?? 0);
    out.push(Math.round(peak * 100) / 100);
  }
  return out;
}
