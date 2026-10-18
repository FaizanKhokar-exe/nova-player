import type { NovaBridge, PlaylistDto, TrackDto } from '@nova/shared';
import { describe, expect, it } from 'vitest';
import { createCollectionsStore } from './collections-store.js';

const track = (id: string): TrackDto => ({ id, title: id, artist: 'A', artwork: 'none' }) as TrackDto;
const list = (id: string, name = id): PlaylistDto => ({ id, name, trackCount: 0, createdAtMs: 1, updatedAtMs: 1, coverTrackIds: [] });

function fakeBridge(handlers: Record<string, (request: unknown) => unknown>) {
  const calls: Array<{ channel: string; request: unknown }> = [];
  const bridge = {
    invoke: async (channel: string, request: unknown) => {
      calls.push({ channel, request });
      const handler = handlers[channel];
      if (handler === undefined) throw new Error(`unhandled ${channel}`);
      return handler(request);
    },
    subscribe: () => () => undefined,
  } as unknown as NovaBridge;
  return { bridge, calls };
}
const ok = (value: unknown) => ({ ok: true, value });
const fail = (message: string) => ({ ok: false, error: { code: 'internal', message } });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('collections store', () => {
  it('connect loads favourite ids and playlists once', async () => {
    const { bridge, calls } = fakeBridge({ 'favorites:ids': () => ok({ trackIds: ['a'] }), 'playlists:list': () => ok({ playlists: [list('p')] }) });
    const store = createCollectionsStore(bridge);
    store.getState().connect();
    store.getState().connect();
    await settle();
    expect(store.getState().favoriteIds.has('a')).toBe(true);
    expect(store.getState().playlists.items).toHaveLength(1);
    expect(calls.filter((c) => c.channel === 'favorites:ids')).toHaveLength(1);
  });
  it('hearts are optimistic and revert on failure', async () => {
    let succeed = true;
    const { bridge } = fakeBridge({ 'favorites:set': (r) => (succeed ? ok({ trackId: (r as { trackId: string }).trackId, favorite: (r as { favorite: boolean }).favorite }) : fail('Nope.')) });
    const store = createCollectionsStore(bridge);
    const pending = store.getState().toggleFavorite('a');
    expect(store.getState().favoriteIds.has('a')).toBe(true); // instant
    await pending;
    expect(store.getState().notice?.text).toBe('Added to Favorites');
    succeed = false;
    await store.getState().toggleFavorite('a');
    expect(store.getState().favoriteIds.has('a')).toBe(true); // put back
    expect(store.getState().notice).toMatchObject({ tone: 'error', text: 'Nope.' });
  });
  it('an unreachable bridge becomes a notice, not a crash', async () => {
    const { bridge } = fakeBridge({});
    const store = createCollectionsStore(bridge);
    await store.getState().toggleFavorite('a');
    expect(store.getState().favoriteIds.has('a')).toBe(false);
    expect(store.getState().notice?.tone).toBe('error');
  });
  it('creates, renames, adds to and deletes playlists', async () => {
    const { bridge, calls } = fakeBridge({
      'playlists:create': () => ok({ playlist: list('p', 'Road trip') }),
      'playlists:list': () => ok({ playlists: [list('p', 'Road trip')] }),
      'playlists:rename': () => ok({ playlist: list('p', 'Better') }),
      'playlists:addTracks': () => ok({ playlist: list('p', 'Better'), added: 2 }),
      'playlists:delete': () => ok({ removed: true }),
    });
    const store = createCollectionsStore(bridge);
    expect((await store.getState().createPlaylist('Road trip', ['a']))?.id).toBe('p');
    expect(calls[0]?.request).toEqual({ name: 'Road trip', trackIds: ['a'] });
    expect(await store.getState().renamePlaylist('p', 'Better')).toBe(true);
    expect(await store.getState().addToPlaylist('p', ['a', 'b'])).toBe(true);
    expect(store.getState().notice?.text).toBe('Added 2 songs to "Better"');
    expect(await store.getState().deletePlaylist('p')).toBe(true);
  });
  it('a playlist load that is superseded does not overwrite the newer one', async () => {
    const resolvers: Array<() => void> = [];
    const { bridge } = fakeBridge({
      'playlists:get': (r) =>
        new Promise((resolve) => resolvers.push(() => resolve(ok({ playlist: list((r as { playlistId: string }).playlistId), entries: [] })))),
    });
    const store = createCollectionsStore(bridge);
    const first = store.getState().loadPlaylist('one');
    const second = store.getState().loadPlaylist('two');
    resolvers[1]!();
    await second;
    resolvers[0]!();
    await first;
    expect(store.getState().playlist.playlistId).toBe('two');
    expect(store.getState().playlist.playlist?.id).toBe('two');
  });
  it('favourites list syncs the id set; history clears', async () => {
    const { bridge } = fakeBridge({ 'favorites:list': () => ok({ tracks: [track('x'), track('y')], total: 2 }), 'history:list': () => ok({ items: [{ track: track('x'), playedAtMs: 1 }] }), 'history:clear': () => ok({ cleared: 1 }) });
    const store = createCollectionsStore(bridge);
    await store.getState().loadFavorites();
    expect([...store.getState().favoriteIds].sort()).toEqual(['x', 'y']);
    await store.getState().loadHistory();
    expect(store.getState().history.items).toHaveLength(1);
    await store.getState().clearHistory();
    expect(store.getState().history.items).toHaveLength(0);
  });
});
