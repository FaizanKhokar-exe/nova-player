import { createBeatAnalyzer, SILENT_LEVELS, type AudioLevels } from '../audio/beat-detector.js';
import type { AudioEngine } from '../audio/audio-engine.js';
import { createFrameGovernor, type FrameBudget } from './frame-governor.js';
import type { PerformanceMode } from '../prefs/prefs-store.js';

/**
 * ONE animation loop for every visual. Spectrum canvases, the particle field and the beat pulse subscribe here;
 * the loop reads the analyser ONCE per frame and shares the result, so adding a visual does not add another read or
 * another requestAnimationFrame. It runs only while something is subscribed AND music is playing AND the window is
 * visible; otherwise nothing is scheduled at all (idle cost: zero).
 */

export interface VisualFrame {
  readonly levels: AudioLevels;
  /** Raw frequency bins (0..255), low to high. Shared - do not keep or mutate. */
  readonly bins: Uint8Array;
  readonly binHz: number;
  readonly nowMs: number;
  readonly budget: FrameBudget;
  /** True when no real audio data is available (Web Audio off): visuals should show their calm idle motion. */
  readonly synthetic: boolean;
}

export interface VisualBus {
  subscribe(listener: (frame: VisualFrame) => void): () => void;
  setMode(mode: PerformanceMode): void;
  /** Tell the bus whether music is playing right now. */
  setPlaying(playing: boolean): void;
  readonly budget: FrameBudget;
}

export interface VisualBusOptions {
  readonly engine: Pick<AudioEngine, 'readFrequencies' | 'binHz' | 'binCount' | 'connected'>;
  readonly raf?: (callback: (nowMs: number) => void) => number;
  readonly caf?: (handle: number) => void;
  readonly now?: () => number;
  readonly visible?: () => boolean;
}

export function createVisualBus(options: VisualBusOptions): VisualBus {
  const raf = options.raf ?? ((callback) => requestAnimationFrame(callback));
  const caf = options.caf ?? ((handle) => cancelAnimationFrame(handle));
  const now = options.now ?? (() => performance.now());
  const visible = options.visible ?? (() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  const governor = createFrameGovernor('auto');
  const analyzer = createBeatAnalyzer();
  const listeners = new Set<(frame: VisualFrame) => void>();
  let handle: number | undefined;
  let playing = false;
  let bins = new Uint8Array(512);

  const shouldRun = (): boolean => listeners.size > 0 && playing && visible();

  function frame(timestamp: number): void {
    handle = undefined;
    if (!shouldRun()) return;
    handle = raf(frame);
    if (!governor.due(timestamp)) return;
    const started = now();
    if (bins.length !== options.engine.binCount) bins = new Uint8Array(options.engine.binCount);
    const real = options.engine.readFrequencies(bins);
    const levels = real ? analyzer.analyze(bins, options.engine.binHz, timestamp) : { ...SILENT_LEVELS, level: 0.2 };
    const snapshot: VisualFrame = { levels, bins, binHz: options.engine.binHz, nowMs: timestamp, budget: governor.budget, synthetic: !real };
    for (const listener of [...listeners]) listener(snapshot);
    governor.recordCost(now() - started);
  }

  function ensure(): void {
    if (handle === undefined && shouldRun()) handle = raf(frame);
  }
  function stop(): void {
    if (handle !== undefined) caf(handle);
    handle = undefined;
  }

  if (typeof document !== 'undefined') document.addEventListener?.('visibilitychange', () => (visible() ? ensure() : stop()));

  return {
    subscribe(listener) {
      listeners.add(listener);
      ensure();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          stop();
          analyzer.reset();
        }
      };
    },
    setMode(mode) {
      governor.setMode(mode);
    },
    setPlaying(next) {
      if (next === playing) return;
      playing = next;
      if (playing) ensure();
      else {
        stop();
        analyzer.reset();
      }
    },
    get budget() {
      return governor.budget;
    },
  };
}
