/**
 * Turns raw frequency data (an AnalyserNode's 0..255 bins) into the few numbers the visuals need: smoothed bass / mid /
 * treble levels, an overall level, and a BEAT flag. Pure and clock-injected, so it is unit-tested without Web Audio.
 *
 * Beat rule: the bass energy of this frame is compared with its own running average. A frame whose bass is clearly
 * above that average (ratio >= `sensitivity`) and above a floor, and at least `minGapMs` after the previous beat,
 * is a beat. This is the classic "energy vs local average" onset detector: cheap (O(bins)), and it adapts to quiet
 * and loud tracks alike because the reference is the track's own recent energy.
 */

export interface AudioLevels {
  /** 0..1, smoothed. */
  readonly bass: number;
  readonly mid: number;
  readonly treble: number;
  readonly level: number;
  /** True for exactly the frame a beat was detected. */
  readonly beat: boolean;
  /** 0..1 pulse that jumps to 1 on a beat and decays - convenient for scaling and glow. */
  readonly pulse: number;
}

export const SILENT_LEVELS: AudioLevels = { bass: 0, mid: 0, treble: 0, level: 0, beat: false, pulse: 0 };

export interface BeatAnalyzerOptions {
  /** Bass must be this many times its running average. Default 1.32. */
  readonly sensitivity?: number;
  /** Shortest time between two beats (ms). Default 210 (about 285 bpm). */
  readonly minGapMs?: number;
  /** Bass below this (0..1) never counts as a beat. Default 0.18. */
  readonly floor?: number;
  /** Seconds-ish memory of the running average, in frames. Default 43 (about 0.7 s at 60 fps). */
  readonly averageFrames?: number;
}

export interface BeatAnalyzer {
  /** `bins`: frequency data, low to high. `binHz`: width of one bin. `nowMs`: a monotonic clock. */
  analyze(bins: Uint8Array, binHz: number, nowMs: number): AudioLevels;
  reset(): void;
}

function bandAverage(bins: Uint8Array, binHz: number, fromHz: number, toHz: number): number {
  const from = Math.max(0, Math.floor(fromHz / binHz));
  const to = Math.min(bins.length, Math.max(from + 1, Math.ceil(toHz / binHz)));
  let sum = 0;
  for (let i = from; i < to; i += 1) sum += bins[i] as number;
  return sum / (to - from) / 255;
}

export function createBeatAnalyzer(options: BeatAnalyzerOptions = {}): BeatAnalyzer {
  const sensitivity = options.sensitivity ?? 1.32;
  const minGapMs = options.minGapMs ?? 210;
  const floor = options.floor ?? 0.18;
  const window = Math.max(2, options.averageFrames ?? 43);

  let bass = 0;
  let mid = 0;
  let treble = 0;
  let average = 0;
  let pulse = 0;
  let lastBeatMs = -Infinity;
  let lastMs: number | undefined;
  let frames = 0;

  return {
    analyze(bins, binHz, nowMs) {
      const rawBass = bandAverage(bins, binHz, 30, 150);
      const rawMid = bandAverage(bins, binHz, 150, 2_000);
      const rawTreble = bandAverage(bins, binHz, 2_000, 12_000);
      // Fast attack, slower release: bars jump up with the music and fall back gracefully.
      const ease = (previous: number, next: number): number => (next > previous ? previous + (next - previous) * 0.65 : previous + (next - previous) * 0.18);
      bass = ease(bass, rawBass);
      mid = ease(mid, rawMid);
      treble = ease(treble, rawTreble);

      const dt = lastMs === undefined ? 16 : Math.max(0, Math.min(100, nowMs - lastMs));
      lastMs = nowMs;
      pulse = Math.max(0, pulse - dt / 320);

      let beat = false;
      // The first frames only teach the average what this track sounds like; nothing can be "above" an average yet.
      if (frames === 0) average = rawBass;
      frames += 1;
      if (frames > 12 && average > 0 && rawBass >= floor && rawBass >= average * sensitivity && nowMs - lastBeatMs >= minGapMs) {
        beat = true;
        lastBeatMs = nowMs;
        pulse = 1;
      }
      // Rises quickly (a new loud passage becomes the reference within a few frames), falls slowly.
      average += (rawBass - average) / (rawBass > average ? 10 : window);

      const level = Math.min(1, (bass * 1.2 + mid + treble * 0.8) / 3);
      return { bass, mid, treble, level, beat, pulse };
    },
    reset() {
      bass = mid = treble = average = pulse = 0;
      lastBeatMs = -Infinity;
      lastMs = undefined;
      frames = 0;
    },
  };
}

/** Collapses `bins` into `count` display bars on a logarithmic frequency scale (so bass is not squeezed into one bar). Writes into `out`. */
export function logBars(bins: Uint8Array, binHz: number, out: Float32Array, minHz = 40, maxHz = 14_000): void {
  const count = out.length;
  const ratio = maxHz / minHz;
  for (let i = 0; i < count; i += 1) {
    const from = minHz * ratio ** (i / count);
    const to = minHz * ratio ** ((i + 1) / count);
    out[i] = bandAverage(bins, binHz, from, to);
  }
}
