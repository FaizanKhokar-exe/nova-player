import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { useNowPlayingStoreApi } from '../nowplaying/NowPlayingStoreProvider.js';
import { MOOD_PROPERTY_NAMES, moodProperties, type MoodMode } from './mood.js';
import { accentsFromDataUrl, DEFAULT_ACCENTS, type Accents, type Rgb } from './palette.js';
import { fixedAccents, type ThemeState, type ThemeStoreApi } from './theme-store.js';

const ThemeContext = createContext<ThemeStoreApi | undefined>(undefined);

export function ThemeStoreProvider({ store, children }: { store: ThemeStoreApi; children: ReactNode }) {
  return <ThemeContext.Provider value={store}>{children}</ThemeContext.Provider>;
}

/** The theme store, or `undefined` when the tree has none (tests, or an app that does not theme). */
export function useThemeStoreApi(): ThemeStoreApi | undefined {
  return useContext(ThemeContext);
}

// A never-changing store so the hook below can be called unconditionally.
const EMPTY_STORE = createStore<ThemeState>(() => ({}) as ThemeState);

/** Reads the theme store; returns `fallback` when there is no provider. */
export function useTheme<T>(selector: (state: ThemeState) => T, fallback: T): T {
  const store = useContext(ThemeContext);
  return useStore(store ?? EMPTY_STORE, (s) => (store === undefined ? fallback : selector(s)));
}

const set = (name: string, c: Rgb) => {
  const root = document.documentElement;
  root.style.setProperty(`--accent-${name}`, `rgb(${c.r}, ${c.g}, ${c.b})`);
  root.style.setProperty(`--accent-${name}-rgb`, `${c.r}, ${c.g}, ${c.b}`);
};
let activeMood: { mood: MoodMode; theme: 'dark' | 'light' } = { mood: 'tinted', theme: 'dark' };
const apply = (a: Accents) => {
  set('primary', a.primary);
  set('secondary', a.secondary);
  set('highlight', a.highlight);
  const deep = mix(a.primary, { r: 8, g: 10, b: 20 }, 0.78);
  const root = document.documentElement;
  root.style.setProperty('--accent-deep-rgb', `${deep.r}, ${deep.g}, ${deep.b}`);
  // Mood: surfaces take the cover's hue (or are released back to the stylesheet when off).
  const props = moodProperties(a, activeMood.mood, activeMood.theme);
  for (const name of MOOD_PROPERTY_NAMES) {
    const value = props[name];
    if (value === undefined) root.style.removeProperty(name);
    else root.style.setProperty(name, value);
  }
  root.dataset['mood'] = activeMood.mood;
};
const mix = (a: Rgb, b: Rgb, t: number): Rgb => ({ r: Math.round(a.r + (b.r - a.r) * t), g: Math.round(a.g + (b.g - a.g) * t), b: Math.round(a.b + (b.b - a.b) * t) });
const mixAccents = (a: Accents, b: Accents, t: number): Accents => ({ primary: mix(a.primary, b.primary, t), secondary: mix(a.secondary, b.secondary, t), highlight: mix(a.highlight, b.highlight, t) });

/**
 * Applies the theme to the document: `data-theme`, `data-reduce-motion`, and the accent custom properties.
 * In `dynamic` mode the accents come from the current track's cover (extracted in the renderer from the
 * artwork data URL main already hands out) and ease to the new colours over ~0.9 s.
 */
export function ThemeController() {
  const store = useThemeStoreApi();
  const nowPlaying = useNowPlayingStoreApi();
  const current = useRef<Accents>(DEFAULT_ACCENTS);
  const frame = useRef<number | undefined>(undefined);
  const cache = useRef(new Map<string, Accents>());

  useEffect(() => {
    if (store === undefined || typeof document === 'undefined') return;
    let disposed = false;

    const glide = (target: Accents, instant: boolean) => {
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
      const from = current.current;
      if (instant || typeof requestAnimationFrame === 'undefined') {
        current.current = target;
        apply(target);
        return;
      }
      const start = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / 900);
        const eased = 1 - (1 - t) ** 3;
        current.current = mixAccents(from, target, eased);
        apply(current.current);
        if (t < 1 && !disposed) frame.current = requestAnimationFrame(step);
      };
      frame.current = requestAnimationFrame(step);
    };

    let sequence = 0;
    const refresh = () => {
      const theme = store.getState();
      const root = document.documentElement;
      root.dataset['theme'] = theme.mode;
      activeMood = { mood: theme.mood, theme: theme.mode };
      root.dataset['reduceMotion'] = theme.reduceMotion ? 'true' : 'false';
      root.style.setProperty('--lyric-size', `${theme.lyricsSize}px`);
      const fixed = fixedAccents(theme);
      const ticket = ++sequence;
      if (fixed !== undefined) return glide(fixed, theme.reduceMotion);
      const art = nowPlaying?.getState().artwork;
      const url = art?.status === 'found' ? art.dataUrl : undefined;
      if (url === undefined) return glide(DEFAULT_ACCENTS, theme.reduceMotion);
      const cached = cache.current.get(url);
      if (cached !== undefined) return glide(cached, theme.reduceMotion);
      void accentsFromDataUrl(url).then((accents) => {
        if (disposed || ticket !== sequence) return; // a newer choice or cover superseded this one
        if (cache.current.size > 32) cache.current.clear();
        cache.current.set(url, accents);
        glide(accents, store.getState().reduceMotion);
      });
    };

    refresh();
    const stopTheme = store.subscribe(refresh);
    const stopArt = nowPlaying?.subscribe((s, prev) => {
      if (s.artwork.dataUrl !== prev.artwork.dataUrl || s.artwork.status !== prev.artwork.status) refresh();
    });
    return () => {
      disposed = true;
      stopTheme();
      stopArt?.();
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    };
  }, [store, nowPlaying]);

  return null;
}
