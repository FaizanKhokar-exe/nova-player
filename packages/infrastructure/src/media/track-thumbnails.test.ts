import { describe, expect, it } from 'vitest';
import type { ArtworkResult } from './track-sidecars.js';
import { THUMBNAIL_SPECS, createTrackThumbnails, planThumbnail, type ImageResizer, type ThumbnailSpec } from './track-thumbnails.js';

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);

function harness(options: { artwork?: (id: string) => ArtworkResult | Promise<ArtworkResult>; resize?: (b: Uint8Array, s: ThumbnailSpec) => Promise<Uint8Array | undefined>; maxEntries?: number; maxBytes?: number; concurrency?: number } = {}) {
  const calls = { artwork: [] as string[], resize: [] as { bytes: Uint8Array; spec: ThumbnailSpec }[] };
  const errors: unknown[] = [];
  let inFlight = 0;
  let peak = 0;
  const resizer: ImageResizer = {
    async thumbnail(b, spec) {
      calls.resize.push({ bytes: b, spec });
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        return options.resize !== undefined ? await options.resize(b, spec) : Uint8Array.from([0xff, 0xd8, spec.size & 0xff]);
      } finally {
        inFlight -= 1;
      }
    },
  };
  const thumbs = createTrackThumbnails({
    sidecars: {
      getArtwork: async (id) => {
        calls.artwork.push(id);
        if (options.artwork === undefined) return { status: 'found', mimeType: 'image/png', bytes: bytes(1, 2, 3) };
        return options.artwork(id);
      },
    },
    resizer,
    ...(options.maxEntries !== undefined && { maxEntries: options.maxEntries }),
    ...(options.maxBytes !== undefined && { maxBytes: options.maxBytes }),
    ...(options.concurrency !== undefined && { concurrency: options.concurrency }),
    onError: (e) => errors.push(e),
  });
  return { thumbs, calls, errors, peak: () => peak };
}
const found = (bytesIn: Uint8Array) => ({ status: 'found' as const, mimeType: 'image/png', bytes: bytesIn });

describe('planThumbnail', () => {
  it('cover: crops the centred square and scales to the edge, never upscaling', () => {
    expect(planThumbnail(400, 200, { size: 128, fit: 'cover' })).toEqual({ crop: { x: 100, y: 0, width: 200, height: 200 }, target: { width: 128, height: 128 } });
    expect(planThumbnail(200, 400, { size: 128, fit: 'cover' }).crop).toEqual({ x: 0, y: 100, width: 200, height: 200 });
    expect(planThumbnail(100, 100, { size: 128, fit: 'cover' }).target).toEqual({ width: 100, height: 100 });
  });
  it('inside: preserves the aspect inside the square, never upscaling', () => {
    expect(planThumbnail(1000, 500, { size: 384, fit: 'inside' }).target).toEqual({ width: 384, height: 192 });
    expect(planThumbnail(500, 1000, { size: 384, fit: 'inside' }).target).toEqual({ width: 192, height: 384 });
    expect(planThumbnail(100, 50, { size: 384, fit: 'inside' }).target).toEqual({ width: 100, height: 50 });
  });
});

describe('createTrackThumbnails', () => {
  it('answers a data URL, with the spec of the requested size', async () => {
    const h = harness();
    const sm = await h.thumbs.get('t1', 'sm');
    expect(sm.status).toBe('found');
    expect(sm.status === 'found' && sm.dataUrl.startsWith('data:image/jpeg;base64,')).toBe(true);
    await h.thumbs.get('t1', 'md');
    expect(h.calls.resize.map((c) => c.spec)).toEqual([THUMBNAIL_SPECS.sm, THUMBNAIL_SPECS.md]);
    expect(THUMBNAIL_SPECS.sm).toMatchObject({ size: 128, fit: 'cover' });
    expect(THUMBNAIL_SPECS.md).toMatchObject({ size: 384, fit: 'inside' });
  });

  it('tracks with identical artwork share one resize and one cache entry', async () => {
    const h = harness();
    const [a, b, c] = await Promise.all([h.thumbs.get('t1', 'sm'), h.thumbs.get('t2', 'sm'), h.thumbs.get('t3', 'sm')]);
    expect(h.calls.resize).toHaveLength(1);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    await h.thumbs.get('t4', 'sm');
    expect(h.calls.resize).toHaveLength(1);
  });

  it('different artwork gets different thumbnails', async () => {
    const h = harness({ artwork: (id) => found(bytes(id === 'a' ? 1 : 2)), resize: async (b) => b });
    const [a, b] = [await h.thumbs.get('a', 'sm'), await h.thumbs.get('b', 'sm')];
    expect(a).not.toEqual(b);
    expect(h.calls.resize).toHaveLength(2);
  });

  it('de-duplicates identical in-flight requests and serves the repeat from cache without reading the file again', async () => {
    const h = harness();
    await Promise.all([h.thumbs.get('t1', 'sm'), h.thumbs.get('t1', 'sm')]);
    expect(h.calls.artwork).toEqual(['t1']);
    await h.thumbs.get('t1', 'sm');
    expect(h.calls.artwork).toEqual(['t1']);
    expect(h.calls.resize).toHaveLength(1);
  });

  it('remembers "no picture" per track until invalidated', async () => {
    let hasCover = false;
    const h = harness({ artwork: () => (hasCover ? found(bytes(9)) : { status: 'none' }) });
    expect(await h.thumbs.get('t1', 'sm')).toEqual({ status: 'none' });
    hasCover = true;
    expect(await h.thumbs.get('t1', 'sm')).toEqual({ status: 'none' }); // negative cache
    expect(h.calls.artwork).toHaveLength(1);
    h.thumbs.invalidate();
    expect((await h.thumbs.get('t1', 'sm')).status).toBe('found');
  });

  it('does not remember "unavailable" (an unplugged drive may come back) and answers none for unknown tracks', async () => {
    let state: 'unavailable' | 'found' | 'throw' = 'unavailable';
    const h = harness({
      artwork: () => {
        if (state === 'throw') throw new Error('unknown');
        return state === 'unavailable' ? { status: 'unavailable' } : found(bytes(5));
      },
    });
    expect(await h.thumbs.get('t1', 'sm')).toEqual({ status: 'none' });
    state = 'found';
    expect((await h.thumbs.get('t1', 'sm')).status).toBe('found');
    state = 'throw';
    expect(await h.thumbs.get('other', 'sm')).toEqual({ status: 'none' });
  });

  it('an undecodable picture answers none and a throwing resizer never throws to the caller', async () => {
    const h = harness({
      resize: async (b) => {
        if (b[0] === 1) return undefined;
        throw new Error('decoder crashed');
      },
      artwork: (id) => found(bytes(id === 'bad' ? 1 : 2)),
    });
    expect(await h.thumbs.get('bad', 'sm')).toEqual({ status: 'none' });
    expect(await h.thumbs.get('crash', 'sm')).toEqual({ status: 'none' });
    expect(h.errors).toHaveLength(1);
  });

  it('a verdict computed before invalidate() is not recorded afterwards', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let cover = false;
    const h = harness({
      artwork: async () => {
        const answer = cover ? found(bytes(1)) : ({ status: 'none' } as const); // decided before the library "changes"
        await gate;
        return answer;
      },
    });
    const pending = h.thumbs.get('t1', 'sm');
    h.thumbs.invalidate();
    cover = true;
    release();
    expect(await pending).toEqual({ status: 'none' }); // the old job's answer...
    expect((await h.thumbs.get('t1', 'sm')).status).toBe('found'); // ...but not remembered
  });

  it('caps the number of simultaneous decodes', async () => {
    const h = harness({
      concurrency: 3,
      artwork: (id) => found(bytes(id.charCodeAt(0))),
      resize: async (b) => {
        await new Promise((r) => setTimeout(r, 5));
        return b;
      },
    });
    const ids = Array.from({ length: 12 }, (_, i) => String.fromCharCode(65 + i));
    const all = await Promise.all(ids.map((id) => h.thumbs.get(id, 'sm')));
    expect(all.every((r) => r.status === 'found')).toBe(true);
    expect(h.peak()).toBe(3);
    expect(h.calls.resize).toHaveLength(12);
  });

  it('evicts the least recently used entries past the entry limit, and past the byte budget', async () => {
    const h = harness({ maxEntries: 2, artwork: (id) => found(bytes(id.charCodeAt(0))), resize: async (b) => b });
    await h.thumbs.get('A', 'sm');
    await h.thumbs.get('B', 'sm');
    await h.thumbs.get('A', 'sm'); // refresh A: B is now oldest
    await h.thumbs.get('C', 'sm'); // evicts B
    h.calls.resize.length = 0;
    await h.thumbs.get('A', 'sm');
    expect(h.calls.resize).toHaveLength(0);
    await h.thumbs.get('B', 'sm');
    expect(h.calls.resize).toHaveLength(1);

    const small = harness({ maxBytes: 60, artwork: (id) => found(bytes(id.charCodeAt(0))), resize: async () => new Uint8Array(30) });
    await small.thumbs.get('A', 'sm');
    await small.thumbs.get('B', 'sm'); // together over the budget: A goes
    small.calls.resize.length = 0;
    await small.thumbs.get('B', 'sm');
    expect(small.calls.resize).toHaveLength(0);
    await small.thumbs.get('A', 'sm');
    expect(small.calls.resize).toHaveLength(1);
  });
});
