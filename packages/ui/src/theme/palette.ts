/**
 * Album-art palette extraction. Pure maths over RGBA pixels (so it is unit-testable without a canvas) plus
 * one thin browser wrapper that decodes a data URL. The result is three vivid accent colours that stay
 * readable on both the dark and the light theme.
 */

export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export interface Accents {
  readonly primary: Rgb;
  readonly secondary: Rgb;
  readonly highlight: Rgb;
}

export const DEFAULT_ACCENTS: Accents = {
  primary: { r: 91, g: 140, b: 255 },
  secondary: { r: 139, g: 92, b: 246 },
  highlight: { r: 34, g: 211, b: 238 },
};

export function rgbToHsl({ r, g, b }: Rgb): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return [h * 60, s, l];
}

export function hslToRgb(h: number, s: number, l: number): Rgb {
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  const [r1, g1, b1] = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
  return { r: Math.round((r1 + m) * 255), g: Math.round((g1 + m) * 255), b: Math.round((b1 + m) * 255) };
}

/** Pulls a colour into the "vivid but not blinding" band so any cover yields a usable accent. */
export function clampVivid(color: Rgb): Rgb {
  const [h, s, l] = rgbToHsl(color);
  return hslToRgb(h, Math.min(0.9, Math.max(0.55, s)), Math.min(0.64, Math.max(0.5, l)));
}

export function rgbToHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
}

export function hexToRgb(hex: string): Rgb | undefined {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (match === null) return undefined;
  const n = Number.parseInt(match[1] as string, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** Three harmonious accents built from one colour (used for the fixed swatches and the custom colour). */
export function accentsFromColor(color: Rgb): Accents {
  const primary = clampVivid(color);
  const [h, s, l] = rgbToHsl(primary);
  return { primary, secondary: hslToRgb(h + 42, s, l), highlight: hslToRgb(h - 48, Math.min(0.95, s + 0.05), Math.min(0.68, l + 0.06)) };
}

const BUCKETS = 12;

/**
 * `pixels` is RGBA (as from `getImageData`). Colours are bucketed by hue, weighted by how saturated and
 * mid-lightness they are, so a mostly grey/white cover with a small vivid detail still picks the detail.
 * Returns the defaults when the image has no usable colour (pure greyscale, fully transparent, empty).
 */
export function extractAccents(pixels: ArrayLike<number>): Accents {
  const weight = new Array<number>(BUCKETS).fill(0);
  const sum = Array.from({ length: BUCKETS }, () => [0, 0, 0]);
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    if ((pixels[i + 3] as number) < 64) continue; // mostly transparent: not part of the picture
    const color = { r: pixels[i] as number, g: pixels[i + 1] as number, b: pixels[i + 2] as number };
    const [h, s, l] = rgbToHsl(color);
    const w = s * (1 - Math.abs(2 * l - 1)) ** 1.2;
    if (w < 0.05) continue;
    const bucket = Math.min(BUCKETS - 1, Math.floor(h / (360 / BUCKETS)));
    weight[bucket] = (weight[bucket] as number) + w;
    const acc = sum[bucket] as number[];
    acc[0] = (acc[0] as number) + color.r * w;
    acc[1] = (acc[1] as number) + color.g * w;
    acc[2] = (acc[2] as number) + color.b * w;
  }
  const total = weight.reduce((a, b) => a + b, 0);
  if (total < 1) return DEFAULT_ACCENTS;
  // Buckets from heaviest to lightest by repeated selection (12 buckets; no general-purpose sort needed).
  const ranked: { w: number; index: number }[] = [];
  const taken = new Set<number>();
  for (let n = 0; n < BUCKETS; n += 1) {
    let best = -1;
    for (let i = 0; i < BUCKETS; i += 1) if (!taken.has(i) && (weight[i] as number) > 0 && (best === -1 || (weight[i] as number) > (weight[best] as number))) best = i;
    if (best === -1) break;
    taken.add(best);
    ranked.push({ w: weight[best] as number, index: best });
  }
  const average = (index: number): Rgb => {
    const acc = sum[index] as number[];
    const w = weight[index] as number;
    return { r: (acc[0] as number) / w, g: (acc[1] as number) / w, b: (acc[2] as number) / w };
  };
  const first = ranked[0];
  if (first === undefined) return DEFAULT_ACCENTS;
  const primary = clampVivid(average(first.index));
  const [ph, ps, pl] = rgbToHsl(primary);
  const hueDistance = (a: number, b: number): number => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
  const distinct = ranked
    .slice(1)
    .map((e) => clampVivid(average(e.index)))
    .filter((c) => hueDistance(rgbToHsl(c)[0], ph) >= 30);
  const secondary = distinct[0] ?? hslToRgb(ph + 42, ps, pl);
  const highlight = distinct.find((c) => hueDistance(rgbToHsl(c)[0], rgbToHsl(secondary)[0]) >= 30) ?? hslToRgb(ph - 48, ps, Math.min(0.68, pl + 0.06));
  return { primary, secondary, highlight };
}

/** Decodes a data URL on a small canvas. Resolves to the defaults for anything that cannot be read. */
export function accentsFromDataUrl(dataUrl: string): Promise<Accents> {
  return new Promise((resolve) => {
    if (typeof Image === 'undefined' || typeof document === 'undefined') {
      resolve(DEFAULT_ACCENTS);
      return;
    }
    const image = new Image();
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 48;
        canvas.height = 48;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (context === null) return resolve(DEFAULT_ACCENTS);
        context.drawImage(image, 0, 0, 48, 48);
        resolve(extractAccents(context.getImageData(0, 0, 48, 48).data));
      } catch {
        resolve(DEFAULT_ACCENTS);
      }
    };
    image.onerror = () => resolve(DEFAULT_ACCENTS);
    image.src = dataUrl;
  });
}
