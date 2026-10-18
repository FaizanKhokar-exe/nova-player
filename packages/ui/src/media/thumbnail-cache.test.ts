import type { NovaBridge } from '@nova/shared';
import { describe, expect, it } from 'vitest';
import { createThumbnailCache, type ThumbnailState } from './thumbnail-cache.js';

function setup(concurrency = 2) {
  const pending: Array<{ trackId: string; resolve: (value: unknown) => void }> = [];
  const requested: string[] = [];
  const bridge = {
    invoke: (_channel: string, request: { trackId: string }) =>
      new Promise((resolve) => {
        requested.push(request.trackId);
        pending.push({ trackId: request.trackId, resolve });
      }),
    subscribe: () => () => undefined,
  } as unknown as NovaBridge;
  const cache = createThumbnailCache(bridge, { concurrency, maxEntries: 16 });
  const found = (trackId: string) => pending.find((p) => p.trackId === trackId)!.resolve({ ok: true, value: { status: 'found', dataUrl: `data:${trackId}` } });
  return { cache, requested, found, pending };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('thumbnail cache', () => {
  it('shares one request between listeners and then answers from memory', async () => {
    const t = setup();
    const a: ThumbnailState[] = [];
    const b: ThumbnailState[] = [];
    t.cache.want('x', 'sm', (s) => a.push(s));
    t.cache.want('x', 'sm', (s) => b.push(s));
    await tick();
    expect(t.requested).toEqual(['x']);
    t.found('x');
    await tick();
    expect(a).toEqual([{ status: 'found', url: 'data:x' }]);
    expect(b).toHaveLength(1);
    const c: ThumbnailState[] = [];
    t.cache.want('x', 'sm', (s) => c.push(s));
    expect(c).toHaveLength(1); // immediate
    expect(t.requested).toEqual(['x']);
    expect(t.cache.peek('x', 'sm')?.status).toBe('found');
  });
  it('limits concurrency and serves the newest request first', async () => {
    const t = setup(1);
    for (const id of ['a', 'b', 'c']) t.cache.want(id, 'sm', () => undefined);
    await tick();
    expect(t.requested).toEqual(['c']); // newest first, one at a time
    t.found('c');
    await tick();
    expect(t.requested).toEqual(['c', 'b']);
  });
  it('drops a request nobody waits for any more', async () => {
    const t = setup(1);
    t.cache.want('first', 'sm', () => undefined);
    const stop = t.cache.want('gone', 'sm', () => undefined);
    stop();
    await tick(); // 'gone' is newest but unwanted
    expect(t.requested).toEqual(['first']);
    t.found('first');
    await tick();
    expect(t.requested).toEqual(['first']); // 'gone' was never sent
  });
  it('treats a failed fetch as no cover and survives clear()', async () => {
    const bridge = { invoke: async () => { throw new Error('boom'); }, subscribe: () => () => undefined } as unknown as NovaBridge;
    const cache = createThumbnailCache(bridge);
    const seen: ThumbnailState[] = [];
    cache.want('x', 'md', (s) => seen.push(s));
    await tick();
    expect(seen).toEqual([{ status: 'none' }]);
    cache.clear();
    expect(cache.peek('x', 'md')).toBeUndefined();
  });
  it('evicts the least recently used entries beyond its bound', async () => {
    const t = setup(20);
    for (let i = 0; i < 20; i += 1) {
      t.cache.want(`t${i}`, 'sm', () => undefined);
    }
    await tick();
    for (let i = 0; i < 20; i += 1) t.found(`t${i}`);
    await tick();
    expect(t.cache.peek('t0', 'sm')).toBeUndefined();
    expect(t.cache.peek('t19', 'sm')?.status).toBe('found');
  });
});
