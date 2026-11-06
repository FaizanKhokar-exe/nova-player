import { createStore, type StoreApi } from 'zustand/vanilla';
import { MOOD_MODES, type MoodMode } from './mood.js';
import { accentsFromColor, hexToRgb, rgbToHex, type Accents } from './palette.js';

export type ThemeMode = 'dark' | 'light';

export interface Swatch {
  readonly id: string;
  readonly label: string;
  readonly color: string;
}

export const SWATCHES: readonly Swatch[] = [
  { id: 'azure', label: 'Azure', color: '#5b8cff' },
  { id: 'violet', label: 'Violet', color: '#8b5cf6' },
  { id: 'rose', label: 'Rose', color: '#f43f78' },
  { id: 'amber', label: 'Amber', color: '#f59e0b' },
  { id: 'emerald', label: 'Emerald', color: '#10b981' },
];

/** `dynamic` follows the cover of the playing track; a swatch id pins a fixed colour; `custom` uses `customColor`. */
export type AccentChoice = 'dynamic' | 'custom' | (typeof SWATCHES)[number]['id'];

export interface ThemeState {
  readonly mode: ThemeMode;
  readonly accent: AccentChoice;
  readonly customColor: string;
  readonly reduceMotion: boolean;
  /** Lyric text size in px. */
  readonly lyricsSize: number;
  /** How far the cover's colour reaches into the app's surfaces. */
  readonly mood: MoodMode;
  setMood(mood: MoodMode): void;
  setMode(mode: ThemeMode): void;
  setAccent(accent: AccentChoice): void;
  setCustomColor(hex: string): void;
  setReduceMotion(value: boolean): void;
  setLyricsSize(size: number): void;
}
export type ThemeStoreApi = StoreApi<ThemeState>;

const KEY = 'nova.theme.v1';
export const LYRICS_SIZE_RANGE = { min: 22, max: 52 } as const;
type Persisted = Pick<ThemeState, 'mode' | 'accent' | 'customColor' | 'reduceMotion' | 'lyricsSize' | 'mood'>;
const DEFAULTS: Persisted = { mode: 'dark', accent: 'dynamic', customColor: '#5b8cff', reduceMotion: false, lyricsSize: 34, mood: 'tinted' };

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): StorageLike | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined; // storage can throw when blocked
  }
}

function load(storage: StorageLike | undefined): Persisted {
  try {
    const raw = storage?.getItem(KEY);
    if (raw === null || raw === undefined) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    const known = new Set<string>(['dynamic', 'custom', ...SWATCHES.map((s) => s.id)]);
    return {
      mode: parsed.mode === 'light' ? 'light' : 'dark',
      accent: typeof parsed.accent === 'string' && known.has(parsed.accent) ? parsed.accent : DEFAULTS.accent,
      customColor: typeof parsed.customColor === 'string' && hexToRgb(parsed.customColor) !== undefined ? parsed.customColor : DEFAULTS.customColor,
      reduceMotion: parsed.reduceMotion === true,
      mood: typeof parsed.mood === 'string' && (MOOD_MODES as readonly string[]).includes(parsed.mood) ? parsed.mood : DEFAULTS.mood,
      lyricsSize: typeof parsed.lyricsSize === 'number' ? Math.min(LYRICS_SIZE_RANGE.max, Math.max(LYRICS_SIZE_RANGE.min, Math.round(parsed.lyricsSize))) : DEFAULTS.lyricsSize,
    };
  } catch {
    return DEFAULTS;
  }
}

/** The theme choices, persisted per viewer in localStorage (every read and write is guarded). */
export function createThemeStore(storage: StorageLike | undefined = defaultStorage()): ThemeStoreApi {
  const store = createStore<ThemeState>((set) => ({
    ...load(storage),
    setMode: (mode) => set({ mode }),
    setMood: (mood) => set({ mood }),
    setAccent: (accent) => set({ accent }),
    setCustomColor: (hex) => {
      if (hexToRgb(hex) !== undefined) set({ customColor: hex.startsWith('#') ? hex.toLowerCase() : `#${hex.toLowerCase()}`, accent: 'custom' });
    },
    setReduceMotion: (reduceMotion) => set({ reduceMotion }),
    setLyricsSize: (size) => set({ lyricsSize: Math.min(LYRICS_SIZE_RANGE.max, Math.max(LYRICS_SIZE_RANGE.min, Math.round(size))) }),
  }));
  store.subscribe((s) => {
    try {
      const value: Persisted = { mode: s.mode, accent: s.accent, customColor: s.customColor, reduceMotion: s.reduceMotion, lyricsSize: s.lyricsSize, mood: s.mood };
      storage?.setItem(KEY, JSON.stringify(value));
    } catch {
      /* private window / blocked storage: the choice just lasts for this session */
    }
  });
  return store;
}

/** The fixed accents for a non-dynamic choice, or `undefined` for `dynamic`. */
export function fixedAccents(state: Pick<ThemeState, 'accent' | 'customColor'>): Accents | undefined {
  if (state.accent === 'dynamic') return undefined;
  const hex = state.accent === 'custom' ? state.customColor : SWATCHES.find((s) => s.id === state.accent)?.color;
  const rgb = hex === undefined ? undefined : hexToRgb(hex);
  return rgb === undefined ? undefined : accentsFromColor(rgb);
}

export { rgbToHex };
