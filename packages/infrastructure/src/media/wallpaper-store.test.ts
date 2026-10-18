import { describe, expect, it } from 'vitest';
import { WALLPAPER_LIMITS } from '@nova/shared';
import { readImageHeader } from './image-header.js';
import { createWallpaperStore, type WallpaperPorts } from './wallpaper-store.js';

function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}
function jpeg(width: number, height: number): Uint8Array {
  const b = new Uint8Array(20);
  b.set([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8]);
  new DataView(b.buffer).setUint16(13, height);
  new DataView(b.buffer).setUint16(15, width);
  return b;
}
function webpX(width: number, height: number): Uint8Array {
  const b = new Uint8Array(40);
  b.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58]);
  const w = width - 1;
  const h = height - 1;
  b.set([w & 255, (w >> 8) & 255, (w >> 16) & 255], 24);
  b.set([h & 255, (h >> 8) & 255, (h >> 16) & 255], 27);
  return b;
}

describe('readImageHeader', () => {
  it('reads PNG, JPEG and WebP sizes', () => {
    expect(readImageHeader(png(1920, 1080))).toEqual({ type: 'png', width: 1920, height: 1080 });
    expect(readImageHeader(jpeg(1600, 900))).toEqual({ type: 'jpeg', width: 1600, height: 900 });
    expect(readImageHeader(webpX(2560, 1440))).toEqual({ type: 'webp', width: 2560, height: 1440 });
  });
  it('refuses text, truncated and empty input', () => {
    expect(readImageHeader(new TextEncoder().encode('hello world, not an image'))).toBeUndefined();
    expect(readImageHeader(png(10, 10).slice(0, 12))).toBeUndefined();
    expect(readImageHeader(new Uint8Array())).toBeUndefined();
  });
});

function harness(over: Partial<WallpaperPorts> = {}) {
  let stored: Uint8Array | undefined;
  const written: Uint8Array[] = [];
  const ports: WallpaperPorts = {
    readFile: async () => png(2000, 1200),
    encodeJpeg: async () => ({ bytes: jpeg(1920, 1152), width: 1920, height: 1152 }),
    storage: {
      read: async () => stored,
      write: async (bytes) => {
        stored = bytes;
        written.push(bytes);
      },
      remove: async () => {
        const had = stored !== undefined;
        stored = undefined;
        return had;
      },
    },
    ...over,
  };
  return { store: createWallpaperStore(ports), written, getStored: () => stored };
}

describe('wallpaper store', () => {
  it('starts with none', async () => {
    expect(await harness().store.get()).toEqual({ status: 'none' });
  });
  it('stores a valid picture and returns a data URL', async () => {
    const h = harness();
    const result = await h.store.setFromFile('/x.png');
    expect(result.outcome).toBe('set');
    if (result.outcome === 'set') expect(result.wallpaper.dataUrl.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect((await h.store.get()).status).toBe('set');
    expect(h.written).toHaveLength(1);
  });
  it('reloads a stored picture from disk in a new store', async () => {
    const h = harness();
    await h.store.setFromFile('/x.png');
    const again = createWallpaperStore({ readFile: async () => undefined, encodeJpeg: async () => undefined, storage: { read: async () => h.getStored(), write: async () => undefined, remove: async () => false } });
    expect((await again.get()).status).toBe('set');
  });
  const refusals: Array<[string, Partial<WallpaperPorts>, string]> = [
    ['too-large from the reader', { readFile: async () => 'too-large' as const }, 'too-large'],
    ['unreadable file', { readFile: async () => undefined }, 'unreadable'],
    ['not an image (judged by content)', { readFile: async () => new TextEncoder().encode('MZ not a picture at all....') }, 'unsupported-type'],
    ['WebP (not decodable by Electron)', { readFile: async () => webpX(2560, 1440) }, 'unsupported-type'],
    ['tiny picture', { readFile: async () => png(400, 300) }, 'too-small'],
    ['absurd dimensions', { readFile: async () => png(WALLPAPER_LIMITS.maxDimension + 1, 2000) }, 'too-big-dimensions'],
    ['undecodable', { encodeJpeg: async () => undefined }, 'unreadable'],
    ['write failure', { readFile: async () => png(2000, 1200), storage: { read: async () => undefined, write: async () => { throw new Error('disk full'); }, remove: async () => false } }, 'unreadable'],
  ];
  it.each(refusals)('refuses: %s', async (_name, over, outcome) => {
    const h = harness(over);
    expect((await h.store.setFromFile('/x')).outcome).toBe(outcome);
    expect(h.written).toHaveLength(0);
  });
  it('a refused pick keeps the previous wallpaper', async () => {
    let next: Uint8Array = png(2000, 1200);
    const read = async (): Promise<Uint8Array> => next;
    const h = harness({ readFile: read });
    await h.store.setFromFile('/a.png');
    next = png(100, 100);
    expect((await h.store.setFromFile('/b.png')).outcome).toBe('too-small');
    expect((await h.store.get()).status).toBe('set');
  });
  it('clear removes it', async () => {
    const h = harness();
    await h.store.setFromFile('/x.png');
    expect(await h.store.clear()).toBe(true);
    expect(await h.store.get()).toEqual({ status: 'none' });
  });
  it('ignores a damaged stored file', async () => {
    const store = createWallpaperStore({ readFile: async () => undefined, encodeJpeg: async () => undefined, storage: { read: async () => new Uint8Array([1, 2, 3]), write: async () => undefined, remove: async () => false } });
    expect(await store.get()).toEqual({ status: 'none' });
  });
});
