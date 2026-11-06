/**
 * Offline analysis of a song's audio for Lyric Studio: where does the "voice band" get loud, where do new sounds
 * begin, and where are the sung phrases. No model, no network: a band-pass filter (250-3500 Hz, where most of the
 * voice's energy and intelligibility sits), 20 ms frames, a loudness curve normalised by the song's own noise floor
 * and ceiling, an onset curve, and a hysteresis gate that turns the curve into phrases.
 *
 * HONEST LIMIT: this finds "something loud in the voice band", not "a voice". Guitars and snares live there too, so
 * the result is an estimate that the live editor is meant to correct.
 */

export const FRAME_MS = 20;

export interface VocalFeatures {
  readonly frameMs: number;
  readonly durationMs: number;
  /** 0..1 loudness of the voice band per frame, relative to this song's floor and ceiling. */
  readonly level: Float32Array;
  /** 0..1 how strongly a new sound begins at this frame. */
  readonly onset: Float32Array;
  /** 1 while a sung phrase is judged to be active. */
  readonly active: Uint8Array;
  /** Cumulative active milliseconds: `activeCum[i]` is the active time before frame i (length frames + 1). */
  readonly activeCum: Float32Array;
  readonly phrases: readonly { readonly startMs: number; readonly endMs: number }[];
}

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
  z1: number;
  z2: number;
}

function highpass(sampleRate: number, hz: number): Biquad {
  const w = (2 * Math.PI * hz) / sampleRate;
  const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
  const cos = Math.cos(w);
  const a0 = 1 + alpha;
  return { b0: (1 + cos) / 2 / a0, b1: -(1 + cos) / a0, b2: (1 + cos) / 2 / a0, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0, z1: 0, z2: 0 };
}

function lowpass(sampleRate: number, hz: number): Biquad {
  const w = (2 * Math.PI * hz) / sampleRate;
  const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
  const cos = Math.cos(w);
  const a0 = 1 + alpha;
  return { b0: (1 - cos) / 2 / a0, b1: (1 - cos) / a0, b2: (1 - cos) / 2 / a0, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0, z1: 0, z2: 0 };
}

function run(f: Biquad, x: number): number {
  const y = f.b0 * x + f.z1;
  f.z1 = f.b1 * x - f.a1 * y + f.z2;
  f.z2 = f.b2 * x - f.a2 * y;
  return y;
}

/** The value below which `fraction` of `values` (all within lo..hi) fall, from a 256-bin histogram. No sorting. */
export function histogramQuantile(values: Float32Array, lo: number, hi: number, fraction: number): number {
  if (values.length === 0 || hi <= lo) return lo;
  const bins = new Uint32Array(256);
  const scale = 255 / (hi - lo);
  for (const v of values) bins[Math.max(0, Math.min(255, Math.floor((v - lo) * scale)))] = (bins[Math.max(0, Math.min(255, Math.floor((v - lo) * scale)))] ?? 0) + 1;
  const target = fraction * values.length;
  let seen = 0;
  for (let i = 0; i < 256; i += 1) {
    seen += bins[i] ?? 0;
    if (seen >= target) return lo + (i / 255) * (hi - lo);
  }
  return hi;
}

const yieldToUi = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export interface AnalyseOptions {
  /** Left-minus-right half of a stereo song (same length and rate as the samples). Voices sit in the centre, so wide guitars, pads and reverb (which fill this signal) count for less. */
  readonly side?: Float32Array;
  readonly onProgress?: (fraction: number) => void;
  readonly isCancelled?: () => boolean;
}

/** @returns `undefined` when cancelled. */
export async function analyseSignal(samples: Float32Array, sampleRate: number, options: AnalyseOptions = {}): Promise<VocalFeatures | undefined> {
  const hop = Math.max(1, Math.round((sampleRate * FRAME_MS) / 1000));
  const frames = Math.floor(samples.length / hop);
  const durationMs = Math.round((samples.length / sampleRate) * 1000);
  const db = new Float32Array(frames);
  // Two cascaded high-pass and two low-pass sections: 24 dB/octave skirts, enough to keep bass and hats out of the curve.
  const hp1 = highpass(sampleRate, 250);
  const hp2 = highpass(sampleRate, 250);
  const lp1 = lowpass(sampleRate, Math.min(3500, sampleRate * 0.45));
  const lp2 = lowpass(sampleRate, Math.min(3500, sampleRate * 0.45));
  const side = options.side !== undefined && options.side.length >= samples.length ? options.side : undefined;
  const shp1 = highpass(sampleRate, 250);
  const shp2 = highpass(sampleRate, 250);
  const slp1 = lowpass(sampleRate, Math.min(3500, sampleRate * 0.45));
  const slp2 = lowpass(sampleRate, Math.min(3500, sampleRate * 0.45));
  const chunkFrames = Math.max(1, Math.round(1000 / FRAME_MS)) * 4;
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    let sideSum = 0;
    const base = frame * hop;
    for (let i = 0; i < hop; i += 1) {
      const y = run(lp2, run(lp1, run(hp2, run(hp1, samples[base + i] ?? 0))));
      sum += y * y;
      if (side !== undefined) {
        const z = run(slp2, run(slp1, run(shp2, run(shp1, side[base + i] ?? 0))));
        sideSum += z * z;
      }
    }
    // Centre-panned sound (the voice) keeps its energy; what only exists in the side signal is mostly not the voice.
    const power = side === undefined ? sum / hop : Math.max(sum / hop - sideSum / hop, (sum / hop) * 0.06);
    db[frame] = 10 * Math.log10(power + 1e-10);
    if (frame % chunkFrames === chunkFrames - 1) {
      options.onProgress?.(frame / Math.max(1, frames));
      await yieldToUi();
      if (options.isCancelled?.() === true) return undefined;
    }
  }

  const floor = histogramQuantile(db, -100, 0, 0.1);
  const ceiling = Math.max(floor + 6, histogramQuantile(db, -100, 0, 0.95));
  // A file that is (almost) silent in the voice band has no phrases: do not stretch its hiss up to full scale.
  const silent = ceiling < -50;
  const raw = new Float32Array(frames);
  // Dense, loudly mastered songs sit near the ceiling the whole time, so the global scale hides the dips between lines
  // and breaths. A second scale from the surrounding ~10 s (its own quiet and loud) brings those dips back; the two are averaged.
  const block = 100;
  const blocks = Math.max(1, Math.ceil(frames / block));
  const localFloor = new Float32Array(blocks);
  const localCeil = new Float32Array(blocks);
  for (let b = 0; b < blocks; b += 1) {
    const from = Math.max(0, (b - 2) * block);
    const to = Math.min(frames, (b + 3) * block);
    const part = db.subarray(from, to);
    localFloor[b] = histogramQuantile(part, -100, 0, 0.12);
    localCeil[b] = histogramQuantile(part, -100, 0, 0.92);
  }
  for (let i = 0; i < frames; i += 1) {
    if (silent) break;
    const g = Math.max(0, Math.min(1, ((db[i] ?? floor) - floor) / (ceiling - floor)));
    const b = Math.min(blocks - 1, Math.floor(i / block));
    const lf = localFloor[b] ?? floor;
    const lc = localCeil[b] ?? ceiling;
    const local = lc - lf >= 6 ? Math.max(0, Math.min(1, ((db[i] ?? lf) - lf) / (lc - lf))) : g;
    raw[i] = 0.5 * g + 0.5 * local;
  }
  const level = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) level[i] = ((raw[i - 1] ?? raw[i] ?? 0) + (raw[i] ?? 0) * 2 + (raw[i + 1] ?? raw[i] ?? 0)) / 4;

  // Onset: how much louder than the previous ~80 ms, scaled by the song's own strong onsets.
  const flux = new Float32Array(frames);
  for (let i = 4; i < frames; i += 1) {
    const before = ((level[i - 1] ?? 0) + (level[i - 2] ?? 0) + (level[i - 3] ?? 0) + (level[i - 4] ?? 0)) / 4;
    flux[i] = Math.max(0, (level[i] ?? 0) - before);
  }
  const strong = Math.max(0.05, histogramQuantile(flux, 0, 1, 0.97));
  const onset = new Float32Array(frames);
  // The flux peaks while the sound is still rising (a couple of frames in): report it where the rise BEGAN.
  for (let i = 0; i < frames; i += 1) onset[i] = Math.min(1, (flux[i + 1] ?? 0) / strong);

  // Hysteresis gate: on above 0.38 for 3 frames, off below 0.22 for 8 frames.
  const active = new Uint8Array(frames);
  let on = false;
  let above = 0;
  let below = 0;
  for (let i = 0; i < frames; i += 1) {
    const v = level[i] ?? 0;
    above = v > 0.38 ? above + 1 : 0;
    below = v < 0.22 ? below + 1 : 0;
    if (!on && above >= 3) {
      on = true;
      for (let k = Math.max(0, i - 2); k <= i; k += 1) active[k] = 1;
    } else if (on && below >= 8) {
      on = false;
      for (let k = Math.max(0, i - 7); k <= i; k += 1) active[k] = 0; // the quiet tail is not part of the phrase
    }
    if (on) active[i] = 1;
  }
  const phrases: { startMs: number; endMs: number }[] = [];
  let start = -1;
  for (let i = 0; i <= frames; i += 1) {
    const isOn = i < frames && active[i] === 1;
    if (isOn && start < 0) start = i;
    if (!isOn && start >= 0) {
      if ((i - start) * FRAME_MS >= 120) phrases.push({ startMs: start * FRAME_MS, endMs: i * FRAME_MS });
      else for (let k = start; k < i; k += 1) active[k] = 0;
      start = -1;
    }
  }
  const activeCum = new Float32Array(frames + 1);
  for (let i = 0; i < frames; i += 1) activeCum[i + 1] = (activeCum[i] ?? 0) + (active[i] === 1 ? FRAME_MS : 0);
  options.onProgress?.(1);
  return { frameMs: FRAME_MS, durationMs, level, onset, active, activeCum, phrases };
}
