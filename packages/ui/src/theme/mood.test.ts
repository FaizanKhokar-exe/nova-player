import { describe, expect, it } from 'vitest';
import { contrastRatio, moodProperties, moodSurface, MOOD_PROPERTY_NAMES } from './mood.js';
import { DEFAULT_ACCENTS, hexToRgb, accentsFromColor } from './palette.js';

const TEXT = { dark: { text: { r: 245, g: 246, b: 251 }, muted: { r: 170, g: 177, b: 194 } }, light: { text: { r: 14, g: 20, b: 36 }, muted: { r: 74, g: 84, b: 102 } } };
const KEYS = ['bg', 'elevated', 'deep', 'panel', 'menu', 'dock', 'sidebar'] as const;

describe('mood themes keep text readable for EVERY cover hue', () => {
  for (const mood of ['tinted', 'immersive'] as const) {
    for (const theme of ['dark', 'light'] as const) {
      it(`${mood} / ${theme}: text >= 7:1 and muted text >= 4.5:1 on every surface, all 360 hues`, () => {
        for (let hue = 0; hue < 360; hue += 1) {
          for (const key of KEYS) {
            const surface = moodSurface(hue, mood, theme, key);
            expect(contrastRatio(TEXT[theme].text, surface), `${mood}/${theme}/${key}/${hue}`).toBeGreaterThanOrEqual(7);
            expect(contrastRatio(TEXT[theme].muted, surface), `${mood}/${theme}/${key}/${hue} muted`).toBeGreaterThanOrEqual(4.5);
          }
        }
      });
    }
  }
});

describe('moodProperties', () => {
  it('is empty when off, and sets exactly the documented properties otherwise', () => {
    expect(moodProperties(DEFAULT_ACCENTS, 'off', 'dark')).toEqual({});
    const props = moodProperties(accentsFromColor(hexToRgb('#e11d48')!), 'tinted', 'dark');
    expect(Object.keys(props)).toEqual([...MOOD_PROPERTY_NAMES]);
    expect(props['--bg']).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
    expect(props['--bg-rgb']).toMatch(/^\d+, \d+, \d+$/);
  });
  it('takes the cover\'s hue: a red cover gives a reddish background, a blue one a bluish one', () => {
    const red = moodProperties(accentsFromColor(hexToRgb('#e11d48')!), 'immersive', 'dark')['--bg-rgb']!.split(', ').map(Number);
    const blue = moodProperties(accentsFromColor(hexToRgb('#2563eb')!), 'immersive', 'dark')['--bg-rgb']!.split(', ').map(Number);
    expect(red[0]).toBeGreaterThan(red[2]!);
    expect(blue[2]).toBeGreaterThan(blue[0]!);
  });
  it('immersive is more colourful than tinted', () => {
    const t = moodProperties(DEFAULT_ACCENTS, 'tinted', 'dark')['--bg-rgb']!.split(', ').map(Number);
    const i = moodProperties(DEFAULT_ACCENTS, 'immersive', 'dark')['--bg-rgb']!.split(', ').map(Number);
    expect(Math.max(...i) - Math.min(...i)).toBeGreaterThan(Math.max(...t) - Math.min(...t));
  });
});
