import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createThemeStore, fixedAccents, LYRICS_SIZE_RANGE, SWATCHES } from './theme-store.js';
import { ThemeController, ThemeStoreProvider } from './ThemeProvider.js';

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('style');
});

const memory = (initial?: string) => {
  const data = new Map<string, string>(initial === undefined ? [] : [['nova.theme.v1', initial]]);
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
};

describe('theme store', () => {
  it('starts dark, following the album art', () => {
    const s = createThemeStore(memory()).getState();
    expect([s.mode, s.accent, s.reduceMotion]).toEqual(['dark', 'dynamic', false]);
  });
  it('persists every choice and restores it', () => {
    const storage = memory();
    const store = createThemeStore(storage);
    store.getState().setMode('light');
    store.getState().setAccent('rose');
    store.getState().setLyricsSize(32);
    store.getState().setReduceMotion(true);
    const again = createThemeStore(storage).getState();
    expect([again.mode, again.accent, again.lyricsSize, again.reduceMotion]).toEqual(['light', 'rose', 32, true]);
  });
  it('survives corrupt, hostile and unavailable storage', () => {
    for (const raw of ['{not json', '[]', '{"mode":"neon","accent":"<script>","customColor":"red","lyricsSize":"huge"}', 'null']) {
      const s = createThemeStore(memory(raw)).getState();
      expect([s.mode, s.accent, s.customColor, s.lyricsSize]).toEqual(['dark', 'dynamic', '#5b8cff', 34]);
    }
    const throwing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    const store = createThemeStore(throwing);
    expect(() => store.getState().setMode('light')).not.toThrow();
    expect(store.getState().mode).toBe('light');
  });
  it('clamps the lyric size and validates the custom colour', () => {
    const store = createThemeStore(memory());
    store.getState().setLyricsSize(999);
    expect(store.getState().lyricsSize).toBe(LYRICS_SIZE_RANGE.max);
    store.getState().setLyricsSize(1);
    expect(store.getState().lyricsSize).toBe(LYRICS_SIZE_RANGE.min);
    store.getState().setCustomColor('not a colour');
    expect(store.getState().accent).toBe('dynamic');
    store.getState().setCustomColor('#AA33CC');
    expect([store.getState().accent, store.getState().customColor]).toEqual(['custom', '#aa33cc']);
  });
  it('fixedAccents is undefined only for dynamic', () => {
    expect(fixedAccents({ accent: 'dynamic', customColor: '#000000' })).toBeUndefined();
    for (const swatch of SWATCHES) expect(fixedAccents({ accent: swatch.id, customColor: '#000000' })).toBeDefined();
    expect(fixedAccents({ accent: 'custom', customColor: '#336699' })).toBeDefined();
  });
});

describe('ThemeController', () => {
  it('applies the mode, the lyric size and a fixed accent to the document', () => {
    const store = createThemeStore(memory());
    store.getState().setReduceMotion(true); // no easing: values land immediately
    store.getState().setAccent('emerald');
    store.getState().setMode('light');
    store.getState().setLyricsSize(30);
    render(
      <ThemeStoreProvider store={store}>
        <ThemeController />
      </ThemeStoreProvider>,
    );
    const root = document.documentElement;
    expect(root.dataset['theme']).toBe('light');
    expect(root.dataset['reduceMotion']).toBe('true');
    expect(root.style.getPropertyValue('--lyric-size')).toBe('30px');
    expect(root.style.getPropertyValue('--accent-primary')).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
    act(() => store.getState().setMode('dark'));
    expect(root.dataset['theme']).toBe('dark');
  });

  it('in dynamic mode with no artwork it uses the default accents', () => {
    const store = createThemeStore(memory());
    store.getState().setReduceMotion(true);
    render(
      <ThemeStoreProvider store={store}>
        <ThemeController />
      </ThemeStoreProvider>,
    );
    expect(document.documentElement.style.getPropertyValue('--accent-primary')).toBe('rgb(91, 140, 255)');
  });
});
