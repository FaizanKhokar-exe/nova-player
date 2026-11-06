import { hslToRgb, rgbToHsl, type Accents, type Rgb } from './palette.js';

/**
 * Mood themes: the whole app's surfaces take the colour of the cover that is playing.
 *  - `off`: only the accent follows the cover (the app's original look)
 *  - `tinted`: backgrounds, panels, menus and the player bar carry a quiet tint of the cover's hue
 *  - `immersive`: stronger, deeper colour everywhere, plus a soft colour wash behind the app
 * Surfaces are built in HSL from the cover's hue with LIGHTNESS FIXED per mode and theme, so text contrast is
 * guaranteed whatever the cover looks like (checked for every hue in the tests).
 */
export type MoodMode = 'off' | 'tinted' | 'immersive';
export const MOOD_MODES: readonly MoodMode[] = ['off', 'tinted', 'immersive'];

type ThemeMode = 'dark' | 'light';

/** [saturation, lightness] for each surface. Dark surfaces stay <= 14% lightness, light ones >= 90%, which keeps the fixed text colours readable. */
const LEVELS: Record<Exclude<MoodMode, 'off'>, Record<ThemeMode, Record<'bg' | 'elevated' | 'deep' | 'panel' | 'menu' | 'dock' | 'sidebar', readonly [number, number]>>> = {
  tinted: {
    dark: { bg: [0.32, 0.05], elevated: [0.3, 0.07], deep: [0.34, 0.035], panel: [0.28, 0.085], menu: [0.28, 0.105], dock: [0.3, 0.065], sidebar: [0.3, 0.055] },
    light: { bg: [0.4, 0.965], elevated: [0.5, 0.99], deep: [0.38, 0.93], panel: [0.5, 0.99], menu: [0.5, 0.99], dock: [0.45, 0.985], sidebar: [0.45, 0.975] },
  },
  immersive: {
    dark: { bg: [0.5, 0.085], elevated: [0.46, 0.115], deep: [0.52, 0.06], panel: [0.44, 0.13], menu: [0.44, 0.15], dock: [0.48, 0.1], sidebar: [0.48, 0.09] },
    light: { bg: [0.62, 0.93], elevated: [0.7, 0.97], deep: [0.6, 0.9], panel: [0.7, 0.97], menu: [0.7, 0.97], dock: [0.66, 0.96], sidebar: [0.66, 0.945] },
  },
};

const css = (c: Rgb): string => `rgb(${c.r}, ${c.g}, ${c.b})`;
const list = (c: Rgb): string => `${c.r}, ${c.g}, ${c.b}`;

/** The CSS custom properties to set on the root for this mood (empty for `off`). */
export function moodProperties(accents: Accents, mood: MoodMode, theme: ThemeMode): Record<string, string> {
  if (mood === 'off') return {};
  const [hue] = rgbToHsl(accents.primary);
  const level = LEVELS[mood][theme];
  const at = (key: keyof typeof level): Rgb => hslToRgb(hue, level[key][0], level[key][1]);
  const bg = at('bg');
  const panel = at('panel');
  return {
    '--bg': css(bg),
    '--bg-rgb': list(bg),
    '--bg-elevated': css(at('elevated')),
    '--bg-deep': css(at('deep')),
    '--panel': css(panel),
    '--panel-rgb': list(panel),
    '--menu-bg': css(at('menu')),
    '--dock-bg': css(at('dock')),
    '--sidebar-bg': `rgba(${list(at('sidebar'))}, ${theme === 'dark' ? 0.86 : 0.9})`,
  };
}

export const MOOD_PROPERTY_NAMES: readonly string[] = ['--bg', '--bg-rgb', '--bg-elevated', '--bg-deep', '--panel', '--panel-rgb', '--menu-bg', '--dock-bg', '--sidebar-bg'];

/** WCAG relative luminance contrast between two colours (>= 4.5 is AA for body text, >= 7 is AAA). */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const lum = ({ r, g, b: blue }: Rgb): number => {
    const f = (v: number): number => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(blue);
  };
  const [hi, lo] = lum(a) >= lum(b) ? [lum(a), lum(b)] : [lum(b), lum(a)];
  return (hi + 0.05) / (lo + 0.05);
}

/** Surface colours (as RGB) for tests and previews. */
export function moodSurface(hue: number, mood: Exclude<MoodMode, 'off'>, theme: ThemeMode, key: 'bg' | 'elevated' | 'deep' | 'panel' | 'menu' | 'dock' | 'sidebar'): Rgb {
  const [s, l] = LEVELS[mood][theme][key];
  return hslToRgb(hue, s, l);
}
