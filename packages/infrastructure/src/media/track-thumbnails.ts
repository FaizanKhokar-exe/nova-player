import { createHash } from 'node:crypto';
import type { TrackSidecars } from './track-sidecars.js';

/**
 * Cover thumbnails (Phase 11).
 *
 * SIZES. `sm` = 128 px: a centred SQUARE CROP ("cover"), so rows and tiles are uniform whatever the artwork's
 * aspect. `md` = 384 px: fitted INSIDE a 384 px square with the aspect preserved ("inside"), so a header or card can
 * show the whole picture. Neither ever upscales (a 100 px source stays 100 px). Output is JPEG (quality ~82), so the
 * renderer receives a small `data:image/jpeg` URL.
 *
 * SOURCE. `TrackSidecars.getArtwork`: the embedded picture, else a cover file in the track's folder (see
 * `FOLDER_COVER_NAMES`). Resizing is an injected `ImageResizer` (the desktop app implements it with Electron's
 * `nativeImage`; this package never imports Electron).
 *
 * CACHES, all in memory, none holding a path:
 *  - the finished thumbnails, keyed by `sha1(source bytes) + size` in an LRU bounded by entry count AND bytes: many
 *    tracks of one album carry the same picture, so they share ONE entry (and one resize);
 *  - per track, the hash of its source (or "no picture"), so a repeat request for a track without a cover costs
 *    nothing; cleared by `invalidate()` when the library changes (a rescan can add a cover);
 *  - in-flight requests: concurrent identical requests share one job, and one hash+size is resized once;
 *  - a concurrency cap on jobs (default 3), so scrolling a long list queues work instead of starving the main process.
 * Nothing here throws: any failure (unreachable file, undecodable image, resizer fault) answers `none`
 * (a fault that is not an expected refusal goes to `onError`).
 */

export type ThumbnailSize = 'sm' | 'md';

export interface ThumbnailSpec {
  /** Edge of the square, in pixels. */
  readonly size: number;
  /** `cover`: crop the centre square, then scale it to `size`. `inside`: scale to fit within `size` x `size`. */
  readonly fit: 'cover' | 'inside';
  /** JPEG quality, 1..100. */
  readonly quality: number;
}

export const THUMBNAIL_SPECS: Readonly<Record<ThumbnailSize, ThumbnailSpec>> = {
  sm: { size: 128, fit: 'cover', quality: 82 },
  md: { size: 384, fit: 'inside', quality: 82 },
};

/** Produces JPEG bytes for `spec` from an image, or `undefined` when the image cannot be decoded. */
export interface ImageResizer {
  thumbnail(bytes: Uint8Array, spec: ThumbnailSpec): Promise<Uint8Array | undefined>;
}

/** The pixel geometry a resizer applies. Pure and shared, so every implementation (and the tests) agree. */
export function planThumbnail(width: number, height: number, spec: Pick<ThumbnailSpec, 'size' | 'fit'>): { crop: { x: number; y: number; width: number; height: number }; target: { width: number; height: number } } {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  if (spec.fit === 'cover') {
    const side = Math.min(w, h);
    const edge = Math.min(spec.size, side); // never upscale
    return { crop: { x: Math.floor((w - side) / 2), y: Math.floor((h - side) / 2), width: side, height: side }, target: { width: edge, height: edge } };
  }
  const scale = Math.min(1, spec.size / Math.max(w, h));
  return { crop: { x: 0, y: 0, width: w, height: h }, target: { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) } };
}

export type ThumbnailResult = { readonly status: 'found'; readonly dataUrl: string } | { readonly status: 'none' };

export interface TrackThumbnails {
  get(trackId: string, size: ThumbnailSize): Promise<ThumbnailResult>;
  /** Forget what is known about which tracks have covers (the library changed). Finished thumbnails stay: they are keyed by content. */
  invalidate(): void;
}

export interface TrackThumbnailsDependencies {
  readonly sidecars: Pick<TrackSidecars, 'getArtwork'>;
  readonly resizer: ImageResizer;
  readonly maxEntries?: number;
  readonly maxBytes?: number;
  readonly concurrency?: number;
  readonly onError?: (error: unknown) => void;
}

const NONE: ThumbnailResult = { status: 'none' };
const MAX_TRACK_SOURCES = 100_000;

export function createTrackThumbnails(dependencies: TrackThumbnailsDependencies): TrackThumbnails {
  const { sidecars, resizer } = dependencies;
  const maxEntries = dependencies.maxEntries ?? 600;
  const maxBytes = dependencies.maxBytes ?? 24 * 1024 * 1024;
  const concurrency = Math.max(1, dependencies.concurrency ?? 3);
  const reportError = (error: unknown): void => {
    try {
      dependencies.onError?.(error);
    } catch {
      // nothing sensible is left to do
    }
  };

  /** LRU: a Map iterates in insertion order, so the first key is the least recently used. */
  const cache = new Map<string, string>();
  let cachedBytes = 0;
  const sources = new Map<string, string | 'none'>(); // trackId -> source hash, or 'none'
  const jobs = new Map<string, Promise<ThumbnailResult>>(); // `${trackId}:${size}`
  const builds = new Map<string, Promise<string | undefined>>(); // `${hash}:${size}` -> data URL
  let generation = 0;

  let running = 0;
  const waiting: (() => void)[] = [];
  async function slot<T>(work: () => Promise<T>): Promise<T> {
    if (running >= concurrency) await new Promise<void>((resolve) => waiting.push(resolve));
    else running += 1;
    try {
      return await work();
    } finally {
      const next = waiting.shift();
      if (next !== undefined) next(); // the slot passes straight on
      else running -= 1;
    }
  }

  function remember(key: string, dataUrl: string): void {
    const existing = cache.get(key);
    if (existing !== undefined) {
      cachedBytes -= existing.length;
      cache.delete(key);
    }
    cache.set(key, dataUrl);
    cachedBytes += dataUrl.length;
    while (cache.size > maxEntries || cachedBytes > maxBytes) {
      const oldest = cache.keys().next();
      if (oldest.done === true || (cache.size === 1 && oldest.value === key)) break; // never evict what was just added
      cachedBytes -= (cache.get(oldest.value) as string).length;
      cache.delete(oldest.value);
    }
  }

  function recall(key: string): string | undefined {
    const hit = cache.get(key);
    if (hit === undefined) return undefined;
    cache.delete(key); // refresh recency
    cache.set(key, hit);
    return hit;
  }

  async function compute(trackId: string, size: ThumbnailSize): Promise<ThumbnailResult> {
    const startedIn = generation;
    const known = sources.get(trackId);
    if (known === 'none') return NONE;
    if (known !== undefined) {
      const hit = recall(`${known}:${size}`);
      if (hit !== undefined) return { status: 'found', dataUrl: hit };
    }
    return slot(async () => {
      let artwork;
      try {
        artwork = await sidecars.getArtwork(trackId);
      } catch {
        return NONE; // an unknown id: the library changed under the list
      }
      const remember_ = (value: string | 'none'): void => {
        if (generation !== startedIn) return; // the library changed while this ran: do not record a stale verdict
        if (sources.size >= MAX_TRACK_SOURCES) sources.clear();
        sources.set(trackId, value);
      };
      if (artwork.status !== 'found') {
        if (artwork.status === 'none') remember_('none'); // "unavailable" (drive unplugged) is NOT remembered: it may come back
        return NONE;
      }
      const hash = createHash('sha1').update(artwork.bytes).digest('hex');
      remember_(hash);
      const key = `${hash}:${size}`;
      const done = recall(key);
      if (done !== undefined) return { status: 'found', dataUrl: done };
      let build = builds.get(key);
      if (build === undefined) {
        build = (async () => {
          try {
            const jpeg = await resizer.thumbnail(artwork.bytes, THUMBNAIL_SPECS[size]);
            if (jpeg === undefined || jpeg.byteLength === 0) return undefined;
            const dataUrl = `data:image/jpeg;base64,${Buffer.from(jpeg).toString('base64')}`;
            remember(key, dataUrl);
            return dataUrl;
          } catch (error) {
            reportError(error);
            return undefined;
          } finally {
            builds.delete(key);
          }
        })();
        builds.set(key, build);
      }
      const dataUrl = await build;
      if (dataUrl === undefined) {
        remember_('none'); // an undecodable picture is as good as none until the library changes
        return NONE;
      }
      return { status: 'found', dataUrl };
    });
  }

  return {
    get(trackId, size) {
      const key = `${trackId}:${size}`;
      let job = jobs.get(key);
      if (job === undefined) {
        job = compute(trackId, size)
          .catch((error: unknown): ThumbnailResult => {
            reportError(error);
            return NONE;
          })
          .finally(() => jobs.delete(key));
        jobs.set(key, job);
      }
      return job;
    },
    invalidate() {
      generation += 1;
      sources.clear();
    },
  };
}
