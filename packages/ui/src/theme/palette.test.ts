import { describe, expect, it } from 'vitest';
import { accentsFromColor, clampVivid, DEFAULT_ACCENTS, extractAccents, hexToRgb, hslToRgb, rgbToHex, rgbToHsl } from './palette.js';

const fill = (r: number, g: number, b: number, n: number, a = 255): number[] => Array.from({ length: n }, () => [r, g, b, a]).flat();

describe('colour maths', () => {
  it('hex round-trips and rejects junk', () => {
    expect(rgbToHex({ r: 255, g: 0, b: 128 })).toBe('#ff0080');
    expect(hexToRgb('#ff0080')).toEqual({ r: 255, g: 0, b: 128 });
    expect(hexToRgb('ff0080')).toEqual({ r: 255, g: 0, b: 128 });
    expect(hexToRgb('#fff')).toBeUndefined();
    expect(hexToRgb('nope')).toBeUndefined();
  });
  it('hsl <-> rgb agree on primaries', () => {
    expect(rgbToHsl({ r: 255, g: 0, b: 0 })[0]).toBe(0);
    expect(rgbToHsl({ r: 0, g: 255, b: 0 })[0]).toBe(120);
    expect(hslToRgb(240, 1, 0.5)).toEqual({ r: 0, g: 0, b: 255 });
  });
  it('clampVivid pulls dull and extreme colours into a readable band', () => {
    for (const c of [{ r: 128, g: 128, b: 128 }, { r: 250, g: 250, b: 250 }, { r: 3, g: 3, b: 20 }, { r: 90, g: 80, b: 70 }]) {
      const [, s, l] = rgbToHsl(clampVivid(c));
      expect(s).toBeGreaterThanOrEqual(0.5);
      expect(l).toBeGreaterThanOrEqual(0.48);
      expect(l).toBeLessThanOrEqual(0.66);
    }
  });
  it('accentsFromColor keeps the primary hue and spreads the others', () => {
    const a = accentsFromColor({ r: 200, g: 40, b: 40 });
    const hue = (c: typeof a.primary) => rgbToHsl(c)[0];
    expect(Math.abs(hue(a.primary) - 0)).toBeLessThan(8);
    expect(hue(a.secondary)).not.toBeCloseTo(hue(a.primary), 0);
    expect(hue(a.highlight)).not.toBeCloseTo(hue(a.secondary), 0);
  });
});

describe('extractAccents', () => {
  it('picks the dominant vivid hue of a cover', () => {
    const a = extractAccents([...fill(220, 30, 40, 80), ...fill(30, 60, 200, 20)]);
    const red = rgbToHsl(a.primary)[0];
    expect(red < 15 || red > 345).toBe(true); // red wins
    const blueish = rgbToHsl(a.secondary)[0];
    expect(blueish).toBeGreaterThan(200); // the minority blue becomes the secondary
    expect(blueish).toBeLessThan(250);
  });
  it('a vivid detail on a grey cover still wins', () => {
    const a = extractAccents([...fill(128, 128, 128, 300), ...fill(20, 200, 90, 10)]);
    const hue = rgbToHsl(a.primary)[0];
    expect(hue).toBeGreaterThan(120);
    expect(hue).toBeLessThan(160);
  });
  it('falls back to the defaults for greyscale, transparent and empty images', () => {
    expect(extractAccents(fill(120, 120, 120, 100))).toBe(DEFAULT_ACCENTS);
    expect(extractAccents(fill(220, 30, 40, 100, 0))).toBe(DEFAULT_ACCENTS);
    expect(extractAccents([])).toBe(DEFAULT_ACCENTS);
  });
  it('always returns three usable, distinct-enough colours', () => {
    const a = extractAccents(fill(220, 30, 40, 100));
    for (const c of [a.primary, a.secondary, a.highlight]) {
      for (const v of [c.r, c.g, c.b]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(255);
      }
    }
    expect(a.primary).not.toEqual(a.secondary);
  });
});
