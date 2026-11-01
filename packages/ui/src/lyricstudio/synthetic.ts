/** Test-only: builds a synthetic "song" - sung bursts at known times over a bass hum - so the engine can be checked against a known truth. */
export interface Burst {
  readonly startMs: number;
  readonly durMs: number;
  readonly hz?: number;
}

export function synthSong(totalMs: number, bursts: readonly Burst[], sampleRate = 16_000, options: { hum?: boolean; noise?: number } = {}): Float32Array {
  const out = new Float32Array(Math.round((totalMs / 1000) * sampleRate));
  let seed = 12345;
  const rand = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff - 0.5;
  };
  for (let i = 0; i < out.length; i += 1) {
    const t = i / sampleRate;
    let v = 0;
    if (options.hum === true) v += 0.4 * Math.sin(2 * Math.PI * 70 * t); // bass the voice-band filter must ignore
    v += (options.noise ?? 0.003) * rand();
    out[i] = v;
  }
  for (const burst of bursts) {
    const from = Math.round((burst.startMs / 1000) * sampleRate);
    const length = Math.round((burst.durMs / 1000) * sampleRate);
    const hz = burst.hz ?? 700;
    for (let k = 0; k < length && from + k < out.length; k += 1) {
      const t = k / sampleRate;
      const attack = Math.min(1, k / (0.012 * sampleRate));
      const release = Math.min(1, (length - k) / (0.03 * sampleRate));
      const vibrato = 1 + 0.01 * Math.sin(2 * Math.PI * 5.5 * t);
      const tone = Math.sin(2 * Math.PI * hz * vibrato * t) + 0.5 * Math.sin(2 * Math.PI * hz * 2 * t) + 0.25 * Math.sin(2 * Math.PI * hz * 3 * t);
      out[from + k] = (out[from + k] ?? 0) + 0.25 * attack * release * tone;
    }
  }
  return out;
}
