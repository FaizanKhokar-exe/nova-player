import type { NovaBridge, ThumbnailSizeDto } from '@nova/shared';

/**
 * The renderer's cover cache. Main produces and caches the JPEG thumbnails; this keeps the ones already received
 * (an LRU), shares one request between everything asking for the same cover, and asks main for at most a few at a time
 * - newest request first, because what was asked for last is what is on screen now while scrolling. A request that
 * nothing is waiting for any more (its row scrolled away before it started) is dropped instead of being sent.
 *
 * Result: a long list never floods the main process, and a cover is fetched once however many rows show it.
 */

export type ThumbnailState = { readonly status: 'found'; readonly url: string } | { readonly status: 'none' };

export interface ThumbnailCache {
  /** Cached answer, or `undefined` when not known yet. Never starts a request. */
  peek(trackId: string, size: ThumbnailSizeDto): ThumbnailState | undefined;
  /** Subscribes to the cover; `onResult` is called once (immediately if cached). Returns the unsubscribe. */
  want(trackId: string, size: ThumbnailSizeDto, onResult: (state: ThumbnailState) => void): () => void;
  /** Forget everything (the library changed, or a cover was attached by hand). Covers on screen start over. */
  clear(): void;
  /** Increases every time `clear()` runs; on-screen covers use it to know they must ask again. */
  revision(): number;
  /** Calls `listener` after each `clear()`. Returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
}

export interface ThumbnailCacheOptions {
  readonly concurrency?: number;
  readonly maxEntries?: number;
}

interface Job {
  readonly key: string;
  readonly trackId: string;
  readonly size: ThumbnailSizeDto;
  readonly listeners: Set<(state: ThumbnailState) => void>;
  started: boolean;
}

const NONE: ThumbnailState = { status: 'none' };

export function createThumbnailCache(bridge: NovaBridge, options: ThumbnailCacheOptions = {}): ThumbnailCache {
  const listeners = new Set<() => void>();
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const maxEntries = Math.max(16, options.maxEntries ?? 800);
  const cache = new Map<string, ThumbnailState>(); // insertion order = recency
  const jobs = new Map<string, Job>();
  const waiting: Job[] = [];
  let running = 0;
  let generation = 0;

  const keyOf = (trackId: string, size: ThumbnailSizeDto): string => `${size}:${trackId}`;

  function remember(key: string, state: ThumbnailState): void {
    cache.delete(key);
    cache.set(key, state);
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next();
      if (oldest.done === true) break;
      cache.delete(oldest.value);
    }
  }

  function pump(): void {
    while (running < concurrency) {
      const job = waiting.pop(); // newest first
      if (job === undefined) return;
      if (job.listeners.size === 0) {
        jobs.delete(job.key); // nobody is waiting any more
        continue;
      }
      job.started = true;
      running += 1;
      const mine = generation;
      void (async () => {
        let state: ThumbnailState = NONE;
        try {
          const result = await bridge.invoke('track:getThumbnail', { trackId: job.trackId, size: job.size });
          if (result.ok && result.value.status === 'found') state = { status: 'found', url: result.value.dataUrl };
        } catch {
          /* a failed fetch is "no cover" for now */
        }
        running -= 1;
        if (mine === generation) {
          remember(job.key, state);
          jobs.delete(job.key);
          for (const listener of [...job.listeners]) listener(state);
        }
        pump();
      })();
    }
  }

  return {
    peek(trackId, size) {
      const key = keyOf(trackId, size);
      const hit = cache.get(key);
      if (hit !== undefined) {
        cache.delete(key);
        cache.set(key, hit);
      }
      return hit;
    },
    want(trackId, size, onResult) {
      const key = keyOf(trackId, size);
      const hit = cache.get(key);
      if (hit !== undefined) {
        onResult(hit);
        return () => undefined;
      }
      let job = jobs.get(key);
      if (job === undefined) {
        job = { key, trackId, size, listeners: new Set(), started: false };
        jobs.set(key, job);
        waiting.push(job);
      } else if (!job.started) {
        // asked for again: it is on screen now, so it moves to the front of the line
        const index = waiting.indexOf(job);
        if (index !== -1) {
          waiting.copyWithin(index, index + 1);
          waiting[waiting.length - 1] = job;
        }
      }
      job.listeners.add(onResult);
      queueMicrotask(pump);
      const owned = job;
      return () => {
        owned.listeners.delete(onResult);
      };
    },
    revision: () => generation,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    clear() {
      generation += 1;
      for (const listener of [...listeners]) listener();
      cache.clear();
      jobs.clear();
      waiting.length = 0;
      running = 0;
    },
  };
}
