import type { VocalFeatures } from './vocal-features.js';

/**
 * Places each line of lyrics on the song's timeline (Lyric Studio's automatic first pass).
 *
 * Idea: lines are sung in order, longer lines take longer, and each starts where something new begins - usually
 * right after a pause in the voice band. So: candidate start moments (onset peaks, phrase starts, a weak grid) and
 * a monotonic dynamic programme (Viterbi) choosing one per line that makes each line's share of the voiced time match
 * its syllable weight, rewards starting on an onset or after a pause, and penalises starting in silence.
 *
 * LOCKS: lines the listener has fixed (`anchors`) are kept exactly; the lines between two locks are solved again
 * inside that gap, so fixing one line pulls its neighbours with it instead of leaving the rest to drift.
 *
 * THIS IS AN ESTIMATE. It is checked here only on synthetic signals; each line carries a confidence so the editor can
 * point the listener at the ones to verify.
 */

export interface AlignOptions {
  /** line index -> fixed start (ms). */
  readonly anchors?: ReadonlyMap<number, number>;
  /** a blank line separated this line from the previous one (a pause is likely here). */
  readonly breakBefore?: readonly boolean[];
}

export interface AlignResult {
  readonly startsMs: readonly number[];
  /** 0..1 per line; 1 for locked lines. */
  readonly confidence: readonly number[];
}

export const LOW_CONFIDENCE = 0.45;
const MIN_LINE_MS = 700;
const MAX_LINE_MS = 30_000;

export function alignLines(weights: readonly number[], f: VocalFeatures, options: AlignOptions = {}): AlignResult {
  const n = weights.length;
  const starts: number[] = new Array<number>(n).fill(0);
  const conf: number[] = new Array<number>(n).fill(0);
  if (n === 0) return { startsMs: [], confidence: [] };
  const anchors = options.anchors ?? new Map<number, number>();
  const duration = f.durationMs;
  const firstPhrase = f.phrases[0];
  const lastPhrase = f.phrases[f.phrases.length - 1];
  const songStart = firstPhrase === undefined ? 0 : Math.max(0, firstPhrase.startMs - 150);
  const songEnd = lastPhrase === undefined ? duration : Math.min(duration, lastPhrase.endMs + 400);

  for (const [index, ms] of anchors) {
    if (index >= 0 && index < n) {
      starts[index] = Math.max(0, Math.min(duration, Math.round(ms)));
      conf[index] = 1;
    }
  }
  let i = 0;
  while (i < n) {
    if (anchors.has(i)) {
      i += 1;
      continue;
    }
    let j = i;
    while (j + 1 < n && !anchors.has(j + 1)) j += 1;
    const lower = i > 0 ? (starts[i - 1] ?? 0) + MIN_LINE_MS : songStart;
    const upper = j < n - 1 ? (starts[j + 1] ?? duration) : songEnd;
    solveRun(i, j, lower, Math.max(upper, lower + 1));
    i = j + 1;
  }
  // With no sung phrase found there is nothing to be confident about.
  if (f.phrases.length === 0) for (let k = 0; k < n; k += 1) if (!anchors.has(k)) conf[k] = Math.min(conf[k] ?? 0, 0.3);
  // Locked lines must not run backwards relative to each other; the editor enforces this too.
  for (let k = 1; k < n; k += 1) if ((starts[k] ?? 0) < (starts[k - 1] ?? 0)) starts[k] = starts[k - 1] ?? 0;
  return { startsMs: starts, confidence: conf };

  function frameOf(ms: number): number {
    return Math.max(0, Math.min(f.level.length - 1, Math.round(ms / f.frameMs)));
  }
  function cum(ms: number): number {
    return f.activeCum[Math.max(0, Math.min(f.activeCum.length - 1, Math.round(ms / f.frameMs)))] ?? 0;
  }
  function activeSoon(frame: number): boolean {
    for (let k = frame; k <= Math.min(f.active.length - 1, frame + 15); k += 1) if (f.active[k] === 1) return true;
    return false;
  }
  function silentBefore(frame: number): boolean {
    for (let k = Math.max(0, frame - 15); k < frame; k += 1) if (f.active[k] === 1) return false;
    return frame > 0;
  }

  function proportional(a: number, b: number, lower: number, upper: number): void {
    let total = 0;
    for (let k = a; k <= b; k += 1) total += weights[k] ?? 1;
    let at = lower;
    for (let k = a; k <= b; k += 1) {
      starts[k] = Math.round(at);
      conf[k] = 0.15;
      at += ((upper - lower) * (weights[k] ?? 1)) / total;
    }
  }

  function solveRun(a: number, b: number, lower: number, upper: number): void {
    const count = b - a + 1;
    const loFrame = frameOf(lower);
    const hiFrame = frameOf(upper);
    // Candidate start frames, in time order by construction (one scan, no sorting).
    const cands: number[] = [];
    const strength: number[] = [];
    const phraseStarts = new Set(f.phrases.map((p) => Math.round(p.startMs / f.frameMs)));
    for (let fr = loFrame; fr <= hiFrame; fr += 1) {
      const o = f.onset[fr] ?? 0;
      const isPeak = o >= 0.3 && o >= (f.onset[fr - 1] ?? 0) && o > (f.onset[fr + 1] ?? 0);
      const isPhrase = phraseStarts.has(fr);
      const isGrid = (fr - loFrame) % 12 === 0;
      if (isPeak || isPhrase || isGrid) {
        cands.push(fr);
        strength.push(isPhrase ? 1 : isPeak ? o : 0);
      }
    }
    if (cands.length < count || upper - lower < count * 300) {
      proportional(a, b, lower, upper);
      return;
    }
    let totalWeight = 0;
    for (let k = a; k <= b; k += 1) totalWeight += weights[k] ?? 1;
    const voiced = cum(upper) - cum(lower);
    const rate = (voiced >= 500 ? voiced : upper - lower) / totalWeight;
    const useVoiced = voiced >= 500;
    const measure = (s: number, e: number): number => (useVoiced ? cum(e) - cum(s) : e - s);

    const lineErr = (line: number, s: number, e: number): number => {
      const expected = rate * (weights[line] ?? 1);
      return Math.min(3, Math.abs(measure(s, e) - expected) / Math.max(expected, 500));
    };
    const lineCost = (line: number, s: number, e: number): number => {
      const dur = e - s;
      let cost = lineErr(line, s, e);
      if (dur < MIN_LINE_MS) cost += (1.5 * (MIN_LINE_MS - dur)) / MIN_LINE_MS;
      if (dur > 18_000) cost += (dur - 18_000) / 6000;
      return cost;
    };
    const startCost = (line: number, ci: number): number => {
      const fr = cands[ci] ?? 0;
      let cost = -0.6 * (strength[ci] ?? 0);
      if (!activeSoon(fr)) cost += 0.6;
      if (silentBefore(fr)) cost -= options.breakBefore?.[line] === true ? 0.45 : 0.25;
      return cost;
    };

    const m = cands.length;
    const time = (ci: number): number => (cands[ci] ?? 0) * f.frameMs;
    const back: Int32Array[] = [];
    let prev = new Float64Array(m);
    for (let ci = 0; ci < m; ci += 1) prev[ci] = startCost(a, ci);
    for (let line = a; line < b; line += 1) {
      const next = new Float64Array(m).fill(Number.POSITIVE_INFINITY);
      const pointer = new Int32Array(m).fill(-1);
      for (let p = 0; p < m; p += 1) {
        const base = prev[p] ?? Number.POSITIVE_INFINITY;
        if (!Number.isFinite(base)) continue;
        const ts = time(p);
        for (let q = p + 1; q < m; q += 1) {
          const te = time(q);
          const dur = te - ts;
          if (dur > MAX_LINE_MS) break;
          if (dur < MIN_LINE_MS) continue;
          const total = base + lineCost(line, ts, te) + startCost(line + 1, q);
          if (total < (next[q] ?? Number.POSITIVE_INFINITY)) {
            next[q] = total;
            pointer[q] = p;
          }
        }
      }
      back.push(pointer);
      prev = next;
    }
    let best = -1;
    let bestCost = Number.POSITIVE_INFINITY;
    for (let p = 0; p < m; p += 1) {
      const base = prev[p] ?? Number.POSITIVE_INFINITY;
      if (!Number.isFinite(base) || upper - time(p) < 300) continue;
      const total = base + lineCost(b, time(p), upper);
      if (total < bestCost) {
        bestCost = total;
        best = p;
      }
    }
    if (best < 0) {
      proportional(a, b, lower, upper);
      return;
    }
    const chosen: number[] = new Array<number>(count).fill(0);
    let at = best;
    for (let line = b; line >= a; line -= 1) {
      chosen[line - a] = at;
      if (line > a) at = (back[line - a - 1] as Int32Array)[at] ?? 0;
    }
    for (let line = a; line <= b; line += 1) {
      const ci = chosen[line - a] ?? 0;
      const s = time(ci);
      const e = line < b ? time(chosen[line - a + 1] ?? ci) : upper;
      starts[line] = Math.round(s);
      const fr = cands[ci] ?? 0;
      let peak = 0;
      for (let k = Math.max(0, fr - 4); k <= Math.min(f.onset.length - 1, fr + 4); k += 1) peak = Math.max(peak, f.onset[k] ?? 0);
      const rateConf = 1 - Math.min(1, lineErr(line, s, e) / 1.2);
      conf[line] = Math.round((0.5 * rateConf + 0.3 * peak + 0.2 * (activeSoon(fr) ? 1 : 0)) * 100) / 100;
    }
  }
}
