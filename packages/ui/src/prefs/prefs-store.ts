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
/** How the next line arrives: Apple glides the whole list; Karaoke lifts the line and wipes colour across it. (The v0.13 "Magnet" style was removed; a saved "magnet" becomes Apple.) */
export type LyricsAnimation = 'apple' | 'karaoke';
/** What happens to lines already sung: dimmed (default), fading away over the next two lines, or gone at once. */
export type SungLines = 'dim' | 'fade' | 'hide';
export type LyricsAlign = 'left' | 'center';
export type LyricsCase = 'normal' | 'upper' | 'lower' | 'small-caps' | 'capitalize';
export type LyricsFont = 'default' | 'serif' | 'rounded' | 'mono';
export type BeatIntensity = 'off' | 'subtle' | 'normal' | 'strong';
export const TRACK_FADE_SECONDS = [0, 2, 4, 6] as const;
/** Action id -> key name (as in KeyboardEvent.key) the listener assigned to it; absent = the built-in key. */
export type ShortcutOverrides = Readonly<Record<string, string>>;

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
  readonly lyricsAnimation: LyricsAnimation;
  readonly sungLines: SungLines;
  readonly lyricsAlign: LyricsAlign;
  readonly lyricsCase: LyricsCase;
  readonly lyricsFont: LyricsFont;
  /** How strongly the beat moves the visuals (cover pulse, backdrop glow, particles). */
  readonly beatIntensity: BeatIntensity;
  /** Seconds of fade-out at the end of each song and fade-in at the start of the next (0 = off). */
  readonly trackFadeSec: number;
  /** The sleep timer lowers the volume over its last 20 seconds instead of stopping abruptly. */
  readonly sleepFade: boolean;
  readonly shortcutOverrides: ShortcutOverrides;
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
  setLyricsAnimation(value: LyricsAnimation): void;
  setSungLines(value: SungLines): void;
  setLyricsAlign(value: LyricsAlign): void;
  setLyricsCase(value: LyricsCase): void;
  setLyricsFont(value: LyricsFont): void;
  setBeatIntensity(value: BeatIntensity): void;
  setTrackFadeSec(value: number): void;
  setSleepFade(value: boolean): void;
  /** `key` undefined removes the override. */
  setShortcut(action: string, key: string | undefined): void;
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
  lyricsAnimation: 'apple',
  sungLines: 'dim',
  lyricsAlign: 'left',
  lyricsCase: 'normal',
  lyricsFont: 'default',
  beatIntensity: 'normal',
  trackFadeSec: 0,
  sleepFade: true,
  shortcutOverrides: {},
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

function sanitizeOverrides(raw: unknown): ShortcutOverrides {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [action, key] of Object.entries(raw as Record<string, unknown>)) {
    if (/^[a-zA-Z]{2,24}$/.test(action) && typeof key === 'string' && key.length >= 1 && key.length <= 12) out[action] = key;
  }
  return out;
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
    lyricsAnimation: oneOf(p.lyricsAnimation, ['apple', 'karaoke'], DEFAULT_PREFS.lyricsAnimation),
    sungLines: oneOf(p.sungLines, ['dim', 'fade', 'hide'], DEFAULT_PREFS.sungLines),
    lyricsAlign: oneOf(p.lyricsAlign, ['left', 'center'], DEFAULT_PREFS.lyricsAlign),
    lyricsCase: oneOf(p.lyricsCase, ['normal', 'upper', 'lower', 'small-caps', 'capitalize'], DEFAULT_PREFS.lyricsCase),
    lyricsFont: oneOf(p.lyricsFont, ['default', 'serif', 'rounded', 'mono'], DEFAULT_PREFS.lyricsFont),
    beatIntensity: oneOf(p.beatIntensity, ['off', 'subtle', 'normal', 'strong'], DEFAULT_PREFS.beatIntensity),
    trackFadeSec: typeof p.trackFadeSec === 'number' && (TRACK_FADE_SECONDS as readonly number[]).includes(p.trackFadeSec) ? p.trackFadeSec : 0,
    sleepFade: typeof p.sleepFade === 'boolean' ? p.sleepFade : DEFAULT_PREFS.sleepFade,
    shortcutOverrides: sanitizeOverrides(p.shortcutOverrides),
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
    setLyricsAnimation: (lyricsAnimation) => set({ lyricsAnimation }),
    setSungLines: (sungLines) => set({ sungLines }),
    setLyricsAlign: (lyricsAlign) => set({ lyricsAlign }),
    setLyricsCase: (lyricsCase) => set({ lyricsCase }),
    setLyricsFont: (lyricsFont) => set({ lyricsFont }),
    setBeatIntensity: (beatIntensity) => set({ beatIntensity }),
    setTrackFadeSec: (value) => set({ trackFadeSec: (TRACK_FADE_SECONDS as readonly number[]).includes(value) ? value : 0 }),
    setSleepFade: (sleepFade) => set({ sleepFade }),
    setShortcut: (action, key) => {
      const next = { ...get().shortcutOverrides };
      if (key === undefined) delete next[action];
      else next[action] = key;
      set({ shortcutOverrides: sanitizeOverrides(next) });
    },
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
        lyricsAnimation: s.lyricsAnimation,
        sungLines: s.sungLines,
        lyricsAlign: s.lyricsAlign,
        lyricsCase: s.lyricsCase,
        lyricsFont: s.lyricsFont,
        beatIntensity: s.beatIntensity,
        trackFadeSec: s.trackFadeSec,
        sleepFade: s.sleepFade,
        shortcutOverrides: s.shortcutOverrides,
      };
      storage?.setItem(KEY, JSON.stringify(value));
    } catch {
      /* blocked storage: the choice lasts for this session */
    }
  });
  return store;
}
