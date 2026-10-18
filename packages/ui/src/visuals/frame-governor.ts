import type { PerformanceMode } from '../prefs/prefs-store.js';

/**
 * Decides how often the visuals (spectrum, particles) draw, and how rich they are.
 *
 *  - `high`: 60 fps, full particle count.      - `balanced`: 40 fps, 60 % particles.
 *  - `low`: 24 fps, 30 % particles, no glow.   - `auto`: starts at 60 fps and steps DOWN by itself when drawing is slow
 *    (average frame cost above 9 ms over a short window), and back up after a long calm spell.
 *
 * Pure and clock-driven, so the behaviour is unit-tested without a browser.
 */

export interface FrameBudget {
  readonly fps: number;
  /** 0..1 multiplier for the number of particles / bars detail. */
  readonly detail: number;
  /** Whether expensive effects (shadow blur, additive glow) are allowed. */
  readonly glow: boolean;
}

const BUDGETS: Record<Exclude<PerformanceMode, 'auto'>, FrameBudget> = {
  high: { fps: 60, detail: 1, glow: true },
  balanced: { fps: 40, detail: 0.6, glow: true },
  low: { fps: 24, detail: 0.3, glow: false },
};

export interface FrameGovernor {
  setMode(mode: PerformanceMode): void;
  /** True when it is time to draw a frame at `nowMs`. */
  due(nowMs: number): boolean;
  /** Report how long drawing a frame took (ms); `auto` uses it to adapt. */
  recordCost(ms: number): void;
  readonly budget: FrameBudget;
}

export function createFrameGovernor(initial: PerformanceMode = 'auto'): FrameGovernor {
  let mode = initial;
  let autoLevel: Exclude<PerformanceMode, 'auto'> = 'high';
  let last = -Infinity;
  const costs: number[] = [];
  let calm = 0;

  const current = (): FrameBudget => BUDGETS[mode === 'auto' ? autoLevel : mode];

  return {
    setMode(next) {
      mode = next;
      costs.length = 0;
      calm = 0;
      if (next === 'auto') autoLevel = 'high';
    },
    due(nowMs) {
      const interval = 1000 / current().fps;
      if (nowMs - last < interval - 1.5) return false; // 1.5 ms tolerance so a 60 Hz display really gets 60 fps
      last = nowMs;
      return true;
    },
    recordCost(ms) {
      if (mode !== 'auto') return;
      costs.push(ms);
      if (costs.length < 40) return;
      const average = costs.reduce((a, b) => a + b, 0) / costs.length;
      costs.length = 0;
      if (average > 9 && autoLevel !== 'low') {
        autoLevel = autoLevel === 'high' ? 'balanced' : 'low';
        calm = 0;
      } else if (average < 3) {
        calm += 1;
        if (calm >= 6 && autoLevel !== 'high') {
          autoLevel = autoLevel === 'low' ? 'balanced' : 'high';
          calm = 0;
        }
      } else calm = 0;
    },
    get budget() {
      return current();
    },
  };
}
