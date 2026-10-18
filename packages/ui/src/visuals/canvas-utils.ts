import { useEffect, useRef, type RefObject } from 'react';

export interface Size {
  width: number;
  height: number;
  dpr: number;
}

/** Sets the canvas' pixel size from its CSS size and returns the measurement. */
function fitCanvas(element: HTMLCanvasElement): Size {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const width = Math.max(1, Math.round(element.clientWidth));
  const height = Math.max(1, Math.round(element.clientHeight));
  element.width = Math.round(width * dpr);
  element.height = Math.round(height * dpr);
  return { width, height, dpr };
}

/** Keeps a canvas' pixel size in step with its CSS size (and the display's pixel ratio, capped at 2 for speed). */
export function useCanvasSize(canvas: RefObject<HTMLCanvasElement | null>): RefObject<Size> {
  const size = useRef<Size>({ width: 0, height: 0, dpr: 1 });
  useEffect(() => {
    const element = canvas.current;
    if (element === null) return;
    const apply = (): void => void (size.current = fitCanvas(element));
    apply();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(apply);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [canvas]);
  return size;
}

/** The three accent colours as `r, g, b` strings, read from the document (they follow the playing cover). */
export function readAccents(): readonly [string, string, string] {
  if (typeof document === 'undefined') return ['91, 140, 255', '139, 92, 246', '34, 211, 238'];
  const style = getComputedStyle(document.documentElement);
  const get = (name: string, fallback: string): string => style.getPropertyValue(name).trim() || fallback;
  return [get('--accent-primary-rgb', '91, 140, 255'), get('--accent-secondary-rgb', '139, 92, 246'), get('--accent-highlight-rgb', '34, 211, 238')];
}
