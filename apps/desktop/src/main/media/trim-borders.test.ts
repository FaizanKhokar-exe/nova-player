import { describe, expect, it } from 'vitest';
import { findContentRect, type Bitmap } from './trim-borders.js';

function make(width: number, height: number, paint: (x: number, y: number) => [number, number, number]): Bitmap {
  const data = new Uint8Array(width * height * 4);
  let seed = 7;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = paint(x, y);
      seed = (seed * 1103515245 + 12345) >>> 0;
      const noise = (seed >>> 16) % 7;
      const i = (y * width + x) * 4;
      data[i] = Math.min(255, r + noise);
      data[i + 1] = Math.min(255, g + noise);
      data[i + 2] = Math.min(255, b + noise);
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}
/** A busy "photo": changes every few pixels, so no row or column is flat. */
const photo = (x: number, y: number): [number, number, number] => [(x * 37 + y * 11) % 200 + 30, (x * 13 + y * 29) % 200 + 30, (x * 7 + y * 53) % 200 + 30];

describe('findContentRect', () => {
  it('trims black bars top and bottom and orange panels left and right, each its own colour', () => {
    const b = make(200, 200, (x, y) => (y < 20 || y >= 175 ? [5, 5, 5] : x < 40 || x >= 160 ? [200, 90, 40] : photo(x, y)));
    const r = findContentRect(b);
    expect(r.x).toBeGreaterThanOrEqual(38);
    expect(r.x).toBeLessThanOrEqual(42);
    expect(r.y).toBeGreaterThanOrEqual(18);
    expect(r.y).toBeLessThanOrEqual(22);
    expect(r.x + r.width).toBeGreaterThanOrEqual(158);
    expect(r.y + r.height).toBeLessThanOrEqual(177);
  });
  it('leaves a normal picture alone', () => {
    expect(findContentRect(make(120, 120, photo))).toEqual({ x: 0, y: 0, width: 120, height: 120 });
  });
  it('does not mistake a smooth gradient for bars (every column of a horizontal gradient is flat)', () => {
    expect(findContentRect(make(200, 200, (x) => [x, 100, 255 - x]))).toEqual({ x: 0, y: 0, width: 200, height: 200 });
    expect(findContentRect(make(200, 200, (_x, y) => [20 + y, 200 - y, 90]))).toEqual({ x: 0, y: 0, width: 200, height: 200 });
  });
  it('never eats a flat dark cover', () => {
    expect(findContentRect(make(100, 100, () => [10, 10, 10]))).toEqual({ x: 0, y: 0, width: 100, height: 100 });
  });
});
