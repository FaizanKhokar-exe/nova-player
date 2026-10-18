import type { NovaBridge } from '@nova/shared';
import { describe, expect, it } from 'vitest';
import { createWallpaperStore } from './wallpaper-store.js';

const bridgeOf = (handlers: Record<string, () => unknown>) => ({ invoke: async (c: string) => { const h = handlers[c]; if (!h) throw new Error('x'); return h(); }, subscribe: () => () => undefined }) as unknown as NovaBridge;
const set1 = { status: 'set', dataUrl: 'data:image/jpeg;base64,AA', width: 1920, height: 1080 } as const;

describe('wallpaper store', () => {
  it('loads, chooses, clears', async () => {
    const store = createWallpaperStore(bridgeOf({ 'wallpaper:get': () => ({ ok: true, value: { status: 'none' } }), 'wallpaper:choose': () => ({ ok: true, value: { outcome: 'set', wallpaper: set1 } }), 'wallpaper:clear': () => ({ ok: true, value: { removed: true } }) }));
    await store.getState().load();
    expect(store.getState().wallpaper).toEqual({ status: 'none' });
    await store.getState().choose();
    expect(store.getState().wallpaper).toEqual(set1);
    expect(store.getState().message?.tone).toBe('ok');
    await store.getState().clear();
    expect(store.getState().wallpaper).toEqual({ status: 'none' });
  });
  it.each([
    ['too-small', /800 x 450/],
    ['too-large', /12 MB/],
    ['unsupported-type', /PNG or JPEG/],
    ['too-big-dimensions', /10,000/],
    ['unreadable', /could not be read/],
  ])('explains a refused picture: %s', async (outcome, text) => {
    const store = createWallpaperStore(bridgeOf({ 'wallpaper:choose': () => ({ ok: true, value: { outcome } }) }));
    await store.getState().choose();
    expect(store.getState().message?.text).toMatch(text);
    expect(store.getState().message?.tone).toBe('error');
    expect(store.getState().busy).toBe(false);
  });
  it('a cancelled dialog changes nothing and says nothing', async () => {
    const store = createWallpaperStore(bridgeOf({ 'wallpaper:choose': () => ({ ok: true, value: { outcome: 'cancelled' } }) }));
    await store.getState().choose();
    expect(store.getState().message).toBeUndefined();
    expect(store.getState().wallpaper).toBeUndefined();
  });
  it('an unreachable app is reported', async () => {
    const store = createWallpaperStore(bridgeOf({}));
    await store.getState().choose();
    expect(store.getState().message?.tone).toBe('error');
    expect(store.getState().busy).toBe(false);
  });
});
