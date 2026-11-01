import { createStore, type StoreApi } from 'zustand/vanilla';
import { EQ_BANDS, EQ_PRESETS, clampDb } from '../audio/eq-presets.js';

/**
 * The viewer's own preferences that are not the colour theme: equaliser, playback speed, spectrum, performance
 * level, wallpaper look and lyrics options. Persisted per viewer in localStorage (every read/write guarded; a blocked
 * store just means the choices last for the session). Every field has a sensible default, so a fresh install looks
 * and behaves well without touching Settings.
 */

export type VisualizerStyle = 'bars' | 'wave' | 'ring';
export type PerformanceMode = 'auto' | 'high' | 'balanced' | 'low';
export type LyricsBackdrop = 'particles' | 'aurora' | 'plain';

export const SPEEDS = [0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const;
export const WALLPAPER_DIM_RANGE = { min: 0, max: 90 } as const;
export const WALLPAPER_BLUR_RANGE = { min: 0, max: 40 } as const;

export interface Prefs {
  readonly sidebarCollapsed: boolean;
  readonly eqEnabled: boolean;
  readonly eqGains: readonly number[];
  readonly speed: number;
  readonly visualizer: VisualizerStyle;
  /** Show the live spectrum in the player bar. */
  readonly dockSpectrum: boolean;
  readonly performance: PerformanceMode;
  readonly wallpaperEnabled: boolean;
  /** Percent of black laid over the wallpaper (keeps text readable). */
  readonly wallpaperDim: number;
  /** Blur in px. */
  readonly wallpaperBlur: number;
  readonly lyricsBackdrop: LyricsBackdrop;
  /** Blur the lines that are not being sung (Apple-style depth). */
  readonly lyricsDepthBlur: boolean;
  /** The listener agreed to let Lyric Studio send a song's title/artist to lrclib.net when they press Search. */
  readonly lyricsSearchConsent: boolean;
}

export interface PrefsActions {
  setSidebarCollapsed(value: boolean): void;
  setEqEnabled(value: boolean): void;
  setEqGains(gains: readonly number[]): void;
  setEqBand(index: number, db: number): void;
  setSpeed(speed: number): void;
  setVisualizer(style: VisualizerStyle): void;
  setDockSpectrum(value: boolean): void;
  setPerformance(mode: PerformanceMode): void;
  setWallpaperEnabled(value: boolean): void;
  setWallpaperDim(value: number): void;
  setWallpaperBlur(value: number): void;
  setLyricsBackdrop(value: LyricsBackdrop): void;
  setLyricsDepthBlur(value: boolean): void;
  setLyricsSearchConsent(value: boolean): void;
  resetAll(): void;
}

export type PrefsState = Prefs & PrefsActions;
export type PrefsStoreApi = StoreApi<PrefsState>;

export const DEFAULT_PREFS: Prefs = {
  sidebarCollapsed: false,
  eqEnabled: false,
  eqGains: EQ_PRESETS[0]!.gains,
  speed: 1,
  visualizer: 'bars',
  dockSpectrum: true,
  performance: 'auto',
  wallpaperEnabled: true,
  wallpaperDim: 45,
  wallpaperBlur: 8,
  lyricsBackdrop: 'particles',
  lyricsDepthBlur: true,
  lyricsSearchConsent: false,
};

const KEY = 'nova.prefs.v1';
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): StorageLike | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => (typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback);

/** The nearest allowed speed (0.5..2). */
export function snapSpeed(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return SPEEDS.reduce((best, candidate) => (Math.abs(candidate - value) < Math.abs(best - value) ? candidate : best), 1 as number);
}

function sanitize(raw: unknown): Prefs {
  const p = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const gains = Array.isArray(p.eqGains) && p.eqGains.length === EQ_BANDS.length && p.eqGains.every((g) => typeof g === 'number') ? (p.eqGains as number[]).map(clampDb) : DEFAULT_PREFS.eqGains;
  const num = (value: unknown, fallback: number, min: number, max: number): number => (typeof value === 'number' && Number.isFinite(value) ? clamp(Math.round(value), min, max) : fallback);
  return {
    sidebarCollapsed: p.sidebarCollapsed === true,
    eqEnabled: p.eqEnabled === true,
    eqGains: gains,
    speed: typeof p.speed === 'number' ? snapSpeed(p.speed) : DEFAULT_PREFS.speed,
    visualizer: oneOf(p.visualizer, ['bars', 'wave', 'ring'], DEFAULT_PREFS.visualizer),
    dockSpectrum: typeof p.dockSpectrum === 'boolean' ? p.dockSpectrum : DEFAULT_PREFS.dockSpectrum,
    performance: oneOf(p.performance, ['auto', 'high', 'balanced', 'low'], DEFAULT_PREFS.performance),
    wallpaperEnabled: typeof p.wallpaperEnabled === 'boolean' ? p.wallpaperEnabled : DEFAULT_PREFS.wallpaperEnabled,
    wallpaperDim: num(p.wallpaperDim, DEFAULT_PREFS.wallpaperDim, WALLPAPER_DIM_RANGE.min, WALLPAPER_DIM_RANGE.max),
    wallpaperBlur: num(p.wallpaperBlur, DEFAULT_PREFS.wallpaperBlur, WALLPAPER_BLUR_RANGE.min, WALLPAPER_BLUR_RANGE.max),
    lyricsBackdrop: oneOf(p.lyricsBackdrop, ['particles', 'aurora', 'plain'], DEFAULT_PREFS.lyricsBackdrop),
    lyricsDepthBlur: typeof p.lyricsDepthBlur === 'boolean' ? p.lyricsDepthBlur : DEFAULT_PREFS.lyricsDepthBlur,
    lyricsSearchConsent: p.lyricsSearchConsent === true,
  };
}

function load(storage: StorageLike | undefined): Prefs {
  try {
    const raw = storage?.getItem(KEY);
    return raw === null || raw === undefined ? DEFAULT_PREFS : sanitize(JSON.parse(raw));
  } catch {
    return DEFAULT_PREFS;
  }
}

export function createPrefsStore(storage: StorageLike | undefined = defaultStorage()): PrefsStoreApi {
  const store = createStore<PrefsState>((set, get) => ({
    ...load(storage),
    setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
    setEqEnabled: (eqEnabled) => set({ eqEnabled }),
    setEqGains: (gains) => set({ eqGains: gains.length === EQ_BANDS.length ? gains.map(clampDb) : get().eqGains }),
    setEqBand: (index, db) => {
      if (index < 0 || index >= EQ_BANDS.length) return;
      const next = [...get().eqGains];
      next[index] = clampDb(db);
      set({ eqGains: next });
    },
    setSpeed: (speed) => set({ speed: snapSpeed(speed) }),
    setVisualizer: (visualizer) => set({ visualizer }),
    setDockSpectrum: (dockSpectrum) => set({ dockSpectrum }),
    setPerformance: (performance) => set({ performance }),
    setWallpaperEnabled: (wallpaperEnabled) => set({ wallpaperEnabled }),
    setWallpaperDim: (value) => set({ wallpaperDim: clamp(Math.round(value), WALLPAPER_DIM_RANGE.min, WALLPAPER_DIM_RANGE.max) }),
    setWallpaperBlur: (value) => set({ wallpaperBlur: clamp(Math.round(value), WALLPAPER_BLUR_RANGE.min, WALLPAPER_BLUR_RANGE.max) }),
    setLyricsBackdrop: (lyricsBackdrop) => set({ lyricsBackdrop }),
    setLyricsDepthBlur: (lyricsDepthBlur) => set({ lyricsDepthBlur }),
    setLyricsSearchConsent: (lyricsSearchConsent) => set({ lyricsSearchConsent }),
    resetAll: () => set({ ...DEFAULT_PREFS }),
  }));
  store.subscribe((s) => {
    try {
      const value: Prefs = {
        sidebarCollapsed: s.sidebarCollapsed,
        eqEnabled: s.eqEnabled,
        eqGains: s.eqGains,
        speed: s.speed,
        visualizer: s.visualizer,
        dockSpectrum: s.dockSpectrum,
        performance: s.performance,
        wallpaperEnabled: s.wallpaperEnabled,
        wallpaperDim: s.wallpaperDim,
        wallpaperBlur: s.wallpaperBlur,
        lyricsBackdrop: s.lyricsBackdrop,
        lyricsDepthBlur: s.lyricsDepthBlur,
        lyricsSearchConsent: s.lyricsSearchConsent,
      };
      storage?.setItem(KEY, JSON.stringify(value));
    } catch {
      /* blocked storage: the choice lasts for this session */
    }
  });
  return store;
}
