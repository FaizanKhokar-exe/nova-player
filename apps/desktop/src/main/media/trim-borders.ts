/**
 * Finds the solid-colour bars some covers carry around their picture (letterbox black, side panels) so the cover can
 * fill its square without them. Pure: works on a plain BGRA/RGBA bitmap, so it is tested without Electron.
 *
 * A row or column counts as a bar when almost all of its pixels are within a small distance of that line's own average
 * colour (so JPEG noise does not matter) - bars of different colours on different sides are fine. At most 35% is trimmed
 * from any side and at least 40% of each dimension is kept, so a plain dark or flat cover is never eaten away.
 */
export interface Bitmap {
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
}
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const TOLERANCE = 26;
const UNIFORM_SHARE = 0.96;
const MAX_SIDE = 0.35;
const MIN_KEEP = 0.4;
const MIN_GAIN = 0.03;

export function findContentRect(bitmap: Bitmap): Rect {
  const { data, width, height } = bitmap;
  const full: Rect = { x: 0, y: 0, width, height };
  if (width < 32 || height < 32 || data.length < width * height * 4) return full;
  let left = 0;
  let right = width;
  let top = 0;
  let bottom = height;
  const px = (x: number, y: number, c: number): number => data[(y * width + x) * 4 + c] ?? 0;

  /** Is the line (a row at `at`, or a column) between `from` and `to` one flat colour? */
  const flat = (vertical: boolean, at: number, from: number, to: number): boolean => {
    const step = Math.max(1, Math.floor((to - from) / 96));
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let i = from; i < to; i += step) {
      const x = vertical ? at : i;
      const y = vertical ? i : at;
      r += px(x, y, 0);
      g += px(x, y, 1);
      b += px(x, y, 2);
      n += 1;
    }
    if (n === 0) return false;
    r /= n;
    g /= n;
    b /= n;
    let near = 0;
    for (let i = from; i < to; i += step) {
      const x = vertical ? at : i;
      const y = vertical ? i : at;
      if (Math.abs(px(x, y, 0) - r) <= TOLERANCE && Math.abs(px(x, y, 1) - g) <= TOLERANCE && Math.abs(px(x, y, 2) - b) <= TOLERANCE) near += 1;
    }
    return near / n >= UNIFORM_SHARE;
  };

  /** Trims one side; gives it back (and says false) when the run of flat lines never ended - a smooth gradient is a picture, not a bar. */
  const sides = { left, right, top, bottom };
  const trim = (side: 'left' | 'right' | 'top' | 'bottom'): void => {
    const before = sides[side];
    const limit = side === 'left' || side === 'right' ? width * MAX_SIDE : height * MAX_SIDE;
    let ended = false;
    for (;;) {
      const done = side === 'top' ? sides.top >= sides.bottom - 1 : side === 'bottom' ? sides.bottom - 1 <= sides.top : side === 'left' ? sides.left >= sides.right - 1 : sides.right - 1 <= sides.left;
      const used = side === 'top' ? sides.top : side === 'bottom' ? height - sides.bottom : side === 'left' ? sides.left : width - sides.right;
      if (done || used >= limit) break;
      const isFlat = side === 'top' ? flat(false, sides.top, sides.left, sides.right) : side === 'bottom' ? flat(false, sides.bottom - 1, sides.left, sides.right) : side === 'left' ? flat(true, sides.left, sides.top, sides.bottom) : flat(true, sides.right - 1, sides.top, sides.bottom);
      if (!isFlat) {
        ended = true;
        break;
      }
      if (side === 'top') sides.top += 1;
      else if (side === 'bottom') sides.bottom -= 1;
      else if (side === 'left') sides.left += 1;
      else sides.right -= 1;
    }
    if (!ended) sides[side] = before;
  };
  for (let pass = 0; pass < 3; pass += 1) {
    const before = [sides.left, sides.right, sides.top, sides.bottom].join();
    trim('top');
    trim('bottom');
    trim('left');
    trim('right');
    if ([sides.left, sides.right, sides.top, sides.bottom].join() === before) break;
  }
  left = sides.left;
  right = sides.right;
  top = sides.top;
  bottom = sides.bottom;
  const w = right - left;
  const h = bottom - top;
  if (w < width * MIN_KEEP || h < height * MIN_KEEP) return full;
  if (1 - (w * h) / (width * height) < MIN_GAIN) return full;
  return { x: left, y: top, width: w, height: h };
}
