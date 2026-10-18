import { EQ_BANDS, clampDb, preampFor } from './eq-presets.js';

/**
 * The Web Audio graph behind the one `<audio>` element (Phase 11):
 *
 *   element -> 10 band EQ (biquads) -> pre-amp (auto headroom) -> analyser -> speakers
 *
 * The analyser feeds the spectrum and the beat detector. The engine is built LAZILY (an AudioContext may only start
 * after a user gesture) and DEFENSIVELY: if anything about the graph is unavailable, `connect()` reports `false` and
 * playback carries on untouched through the element's own output, with the EQ and spectrum simply off.
 *
 * Needs a CORS-enabled media element (`crossOrigin = 'anonymous'`, set before the source): otherwise the browser
 * outputs silence from a MediaElementSource. The `nova-media` scheme sends the headers that make that work.
 */

export interface AudioEngine {
  /** Builds the graph (once). `false` when Web Audio is unavailable. Safe to call repeatedly. */
  connect(): boolean;
  /** Resumes a suspended context (call from a user gesture / when playback starts). */
  resume(): void;
  setEqEnabled(enabled: boolean): void;
  setGains(gains: readonly number[]): void;
  /** Copies the current frequency data into `into` (length = `binCount`). `false` when there is no graph. */
  readFrequencies(into: Uint8Array): boolean;
  readonly binCount: number;
  /** Width of one frequency bin in Hz. */
  readonly binHz: number;
  readonly connected: boolean;
  dispose(): void;
}

/** The slice of the Web Audio API the engine uses - so tests can supply a fake. */
export interface AudioContextLike {
  readonly sampleRate: number;
  readonly state: string;
  readonly destination: unknown;
  resume(): Promise<void>;
  close(): Promise<void>;
  createMediaElementSource(element: unknown): AudioNodeLike;
  createBiquadFilter(): BiquadLike;
  createGain(): GainLike;
  createAnalyser(): AnalyserLike;
}
export interface AudioNodeLike {
  connect(next: unknown): unknown;
  disconnect(): void;
}
export interface BiquadLike extends AudioNodeLike {
  type: string;
  readonly frequency: { value: number };
  readonly gain: { value: number };
  readonly Q: { value: number };
}
export interface GainLike extends AudioNodeLike {
  readonly gain: { value: number };
}
export interface AnalyserLike extends AudioNodeLike {
  fftSize: number;
  smoothingTimeConstant: number;
  minDecibels: number;
  maxDecibels: number;
  readonly frequencyBinCount: number;
  getByteFrequencyData(into: Uint8Array): void;
}

export interface AudioEngineOptions {
  readonly element: unknown;
  readonly createContext?: () => AudioContextLike;
  readonly onError?: (error: unknown) => void;
  readonly fftSize?: number;
}

const FLAT = EQ_BANDS.map(() => 0);

export function createAudioEngine(options: AudioEngineOptions): AudioEngine {
  const fftSize = options.fftSize ?? 1024;
  let context: AudioContextLike | undefined;
  let filters: BiquadLike[] = [];
  let preamp: GainLike | undefined;
  let analyser: AnalyserLike | undefined;
  let source: AudioNodeLike | undefined;
  let failed = false;
  let eqEnabled = false;
  let gains: readonly number[] = FLAT;

  const defaultContext = (): AudioContextLike => {
    const Ctor = (globalThis as { AudioContext?: new (config?: unknown) => AudioContextLike }).AudioContext;
    if (Ctor === undefined) throw new Error('Web Audio is not available');
    return new Ctor({ latencyHint: 'playback' });
  };

  function apply(): void {
    const active = eqEnabled ? gains : FLAT;
    filters.forEach((filter, index) => {
      filter.gain.value = clampDb(active[index] ?? 0);
    });
    if (preamp !== undefined) preamp.gain.value = preampFor(active.map(clampDb));
  }

  const engine: AudioEngine = {
    connect() {
      if (context !== undefined) return true;
      if (failed) return false;
      try {
        const created = (options.createContext ?? defaultContext)();
        const node = created.createMediaElementSource(options.element);
        const bands = EQ_BANDS.map((frequency, index) => {
          const filter = created.createBiquadFilter();
          filter.type = index === 0 ? 'lowshelf' : index === EQ_BANDS.length - 1 ? 'highshelf' : 'peaking';
          filter.frequency.value = frequency;
          filter.Q.value = 1.1;
          filter.gain.value = 0;
          return filter;
        });
        const gain = created.createGain();
        const analysis = created.createAnalyser();
        analysis.fftSize = fftSize;
        analysis.smoothingTimeConstant = 0.72;
        analysis.minDecibels = -88;
        analysis.maxDecibels = -12;
        let previous: AudioNodeLike = node;
        for (const band of bands) {
          previous.connect(band);
          previous = band;
        }
        previous.connect(gain);
        gain.connect(analysis);
        analysis.connect(created.destination);
        context = created;
        source = node;
        filters = bands;
        preamp = gain;
        analyser = analysis;
        apply();
        return true;
      } catch (error) {
        failed = true; // do not retry a broken graph on every frame; playback keeps its normal output
        try {
          options.onError?.(error);
        } catch {
          /* nothing sensible is left to do */
        }
        return false;
      }
    },
    resume() {
      if (context === undefined || context.state !== 'suspended') return;
      void context.resume().catch(() => undefined);
    },
    setEqEnabled(enabled) {
      eqEnabled = enabled;
      apply();
    },
    setGains(next) {
      gains = next;
      apply();
    },
    readFrequencies(into) {
      if (analyser === undefined) return false;
      analyser.getByteFrequencyData(into);
      return true;
    },
    get binCount() {
      return analyser?.frequencyBinCount ?? fftSize / 2;
    },
    get binHz() {
      return context === undefined ? 22_050 / (fftSize / 2) : context.sampleRate / fftSize;
    },
    get connected() {
      return context !== undefined;
    },
    dispose() {
      try {
        source?.disconnect();
        for (const filter of filters) filter.disconnect();
        preamp?.disconnect();
        analyser?.disconnect();
        void context?.close().catch(() => undefined);
      } catch {
        /* closing is best effort */
      }
      context = undefined;
      analyser = undefined;
      preamp = undefined;
      source = undefined;
      filters = [];
    },
  };
  return engine;
}
