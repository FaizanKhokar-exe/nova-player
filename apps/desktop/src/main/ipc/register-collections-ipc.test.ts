import type { CollectionsApplication, PlaybackApplication, TrackThumbnails, WallpaperStore } from '@nova/infrastructure';
import { CollectionsApplicationError } from '@nova/infrastructure';
import { IPC_INVOKE_CHANNELS } from '@nova/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { makeTrack } from '../../../../../packages/infrastructure/src/repositories/test-tracks.js';
import { registerCollectionsIpc } from './register-collections-ipc.js';

type Result = { ok: boolean; value?: Record<string, unknown> & { entries?: { entryId: string }[]; playlists?: object[] }; error?: { code: string } };
type Handler = (event: unknown, request: unknown) => unknown;
const TRUSTED = { trusted: true };
const TRACK = '123e4567-e89b-42d3-a456-426614174000';
const PLAYLIST = '9b2f6c3e-1d4a-4c8b-8f10-2a7e5d6c4b3a';

const OWNED = ['favorites:', 'history:', 'playlists:', 'wallpaper:'];
const CHANNELS = IPC_INVOKE_CHANNELS.filter((c) => OWNED.some((p) => c.startsWith(p)) || c === 'playback:playList' || c === 'track:getThumbnail');

function setup() {
  const handlers = new Map<string, Handler>();
  const calls: string[] = [];
  const track = makeTrack({ id: TRACK as never, title: 'Song' });
  const view = { id: PLAYLIST, name: 'P', trackCount: 1, durationSeconds: undefined, createdAtMs: 1, updatedAtMs: 2, coverTrackIds: [TRACK] };
  const collections = {
    listFavorites: () => [track],
    listFavoriteIds: () => [TRACK],
    setFavorite: (id: string, f: boolean) => (calls.push(`fav:${id}:${f}`), f),
    listHistory: (limit?: number) => (calls.push(`history:${limit}`), [{ track, playedAtMs: 9 }]),
    clearHistory: () => 3,
    listPlaylists: () => [view],
    createPlaylist: (name: string) => {
      if (name === 'bad') throw new CollectionsApplicationError('name-invalid', 'name');
      return view;
    },
    renamePlaylist: () => view,
    deletePlaylist: () => true,
    getPlaylist: () => ({ playlist: view, entries: [{ entryId: 'e1', track }] }),
    addToPlaylist: () => ({ playlist: view, added: 1 }),
    removeFromPlaylist: () => ({ playlist: view, entries: [] }),
    movePlaylistEntry: () => ({ playlist: view, entries: [] }),
  } as unknown as CollectionsApplication;
  const playback = { playList: (r: unknown) => (calls.push(`play:${JSON.stringify(r)}`), { outcome: 'none', state: { status: 'paused' } }) } as unknown as PlaybackApplication;
  const thumbnails = { get: async (id: string, size: string) => (calls.push(`thumb:${id}:${size}`), { status: 'none' as const }), invalidate: () => undefined } as TrackThumbnails;
  const wallpaperState = { current: { status: 'none' } as const, picked: '/p.png' as string | undefined, setFrom: [] as string[] };
  const wallpaper: WallpaperStore = {
    get: async () => wallpaperState.current,
    setFromFile: async (p) => (wallpaperState.setFrom.push(p), { outcome: 'too-small' as const }),
    clear: async () => true,
  };
  registerCollectionsIpc({
    registrar: { handle: (channel, listener) => void handlers.set(channel, listener) },
    collections,
    playback,
    thumbnails,
    wallpaper,
    pickWallpaperFile: async () => wallpaperState.picked,
    isTrustedSender: (e) => (e as { trusted?: boolean }).trusted === true,
    log: () => undefined,
  });
  const call = async (channel: string, request?: unknown, event: unknown = TRUSTED) => (await handlers.get(channel)!(event, request)) as Result;
  return { handlers, call, calls, wallpaperState };
}

let h: ReturnType<typeof setup>;
beforeEach(() => {
  h = setup();
});

describe('registration', () => {
  it('registers exactly the Phase 11 channels, once each', () => {
    expect([...h.handlers.keys()].sort()).toEqual([...CHANNELS].sort());
    expect(CHANNELS).toHaveLength(18);
  });
  it('refuses an untrusted sender on every channel', async () => {
    for (const channel of CHANNELS) {
      const result = await h.call(channel, undefined, { trusted: false });
      expect(result.ok, channel).toBe(false);
    }
    expect(h.calls).toEqual([]);
    expect(h.wallpaperState.setFrom).toEqual([]);
  });
});

describe('handlers', () => {
  it('lists favourites as DTOs with no path', async () => {
    const result = await h.call('favorites:list');
    expect(result).toMatchObject({ ok: true, value: { total: 1 } });
    expect(JSON.stringify(result)).not.toMatch(/filePath|\/music\//i);
  });
  it('sets a favourite and records history limit', async () => {
    expect(await h.call('favorites:set', { trackId: TRACK, favorite: true })).toEqual({ ok: true, value: { trackId: TRACK, favorite: true } });
    await h.call('history:list', { limit: 5 });
    expect(h.calls).toEqual([`fav:${TRACK}:true`, 'history:5']);
  });
  it('maps playlists and their entries', async () => {
    const got = await h.call('playlists:get', { playlistId: PLAYLIST });
    expect(got.value?.entries?.[0]?.entryId).toBe('e1');
    expect((await h.call('playlists:list')).value?.playlists?.[0]).not.toHaveProperty('durationSeconds');
  });
  it('turns an application error into a plain IPC error', async () => {
    const result = await h.call('playlists:create', { name: 'bad' });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('name-invalid');
  });
  it('rejects invalid requests before running anything', async () => {
    expect((await h.call('favorites:set', { trackId: TRACK })).ok).toBe(false);
    expect((await h.call('playlists:get', { playlistId: '../x' })).ok).toBe(false);
    expect(h.calls).toEqual([]);
  });
  it('plays a list and fetches a thumbnail', async () => {
    expect((await h.call('playback:playList', { source: { kind: 'favorites' }, shuffle: true })).ok).toBe(true);
    expect(h.calls[0]).toBe('play:{"source":{"kind":"favorites"},"shuffle":true}');
    expect(await h.call('track:getThumbnail', { trackId: TRACK, size: 'md' })).toEqual({ ok: true, value: { status: 'none' } });
  });
});

describe('wallpaper', () => {
  it('cancelled dialog does nothing', async () => {
    h.wallpaperState.picked = undefined;
    expect(await h.call('wallpaper:choose')).toEqual({ ok: true, value: { outcome: 'cancelled' } });
    expect(h.wallpaperState.setFrom).toEqual([]);
  });
  it('a picked file goes to the store, and the renderer sees only the outcome', async () => {
    const result = await h.call('wallpaper:choose');
    expect(result).toEqual({ ok: true, value: { outcome: 'too-small' } });
    expect(h.wallpaperState.setFrom).toEqual(['/p.png']);
    expect(JSON.stringify(result)).not.toContain('/p.png');
  });
  it('rejects a request that tries to pass a path', async () => {
    expect((await h.call('wallpaper:choose', { path: '/etc/passwd' })).ok).toBe(false);
  });
  it('get and clear', async () => {
    expect(await h.call('wallpaper:get')).toEqual({ ok: true, value: { status: 'none' } });
    expect(await h.call('wallpaper:clear')).toEqual({ ok: true, value: { removed: true } });
  });
});
