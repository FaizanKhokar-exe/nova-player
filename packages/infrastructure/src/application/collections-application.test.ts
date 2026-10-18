import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IN_MEMORY_DATABASE, openDatabase, type NovaDatabase } from '../database/index.js';
import { SqliteFavoritesRepository } from '../repositories/sqlite-favorites-repository.js';
import { SqliteHistoryRepository } from '../repositories/sqlite-history-repository.js';
import { SqlitePlaylistRepository } from '../repositories/sqlite-playlist-repository.js';
import { SqliteTrackRepository } from '../repositories/sqlite-track-repository.js';
import { EXACT_PATH_KEYS, makeRecord } from '../repositories/test-tracks.js';
import { CollectionsApplicationError, createCollectionsApplication, normalizePlaylistName, type CollectionsApplication } from './collections-application.js';

let db: NovaDatabase;
let tracks: SqliteTrackRepository;
let app: CollectionsApplication;
const limits = { maxPlaylists: 2, maxEntries: 4 };

beforeEach(() => {
  db = openDatabase({ filePath: IN_MEMORY_DATABASE });
  tracks = new SqliteTrackRepository(db, EXACT_PATH_KEYS);
  app = createCollectionsApplication({
    trackRepository: tracks,
    favorites: new SqliteFavoritesRepository(db),
    history: new SqliteHistoryRepository(db),
    playlists: new SqlitePlaylistRepository(db, { limits }),
    limits,
  });
});
afterEach(() => db.close());

const add = (overrides = {}): string => {
  const r = makeRecord(overrides);
  tracks.insert(r);
  return r.track.id;
};
const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof CollectionsApplicationError ? error.code : `other:${String(error)}`;
  }
  return undefined;
};

describe('playlist names', () => {
  it('trims and collapses inner whitespace', () => {
    expect(normalizePlaylistName('  Road \t  trip\n 2024 ')).toBe('Road trip 2024');
  });
  it('accepts exactly 1 and 80 characters (code points) and refuses 0 and 81', () => {
    expect(normalizePlaylistName('a')).toBe('a');
    expect(normalizePlaylistName('a'.repeat(80))).toHaveLength(80);
    expect([...normalizePlaylistName('🎵'.repeat(80))]).toHaveLength(80);
    expect(code(() => normalizePlaylistName('a'.repeat(81)))).toBe('name-invalid');
    expect(code(() => normalizePlaylistName('   \n '))).toBe('name-invalid');
    expect(code(() => normalizePlaylistName(''))).toBe('name-invalid');
  });
  it('refuses control characters and non-strings', () => {
    expect(code(() => normalizePlaylistName('bad\u0000name'))).toBe('name-invalid');
    expect(code(() => normalizePlaylistName(42 as never))).toBe('name-invalid');
  });
});

describe('favourites', () => {
  it('toggles, lists tracks newest first and lists ids', () => {
    const [a, b] = [add(), add()] as [string, string];
    expect(app.setFavorite(a, true)).toBe(true);
    expect(app.setFavorite(b, true)).toBe(true);
    expect(app.listFavoriteIds()).toEqual([b, a]);
    expect(app.listFavorites().map((t) => t.id)).toEqual([b, a]);
    expect(app.setFavorite(a, false)).toBe(false);
    expect(app.listFavoriteIds()).toEqual([b]);
  });
  it('refuses to favourite an unknown or malformed track, but un-favouriting one is harmless', () => {
    expect(code(() => app.setFavorite(crypto.randomUUID(), true))).toBe('track-not-found');
    expect(code(() => app.setFavorite('nope', true))).toBe('track-not-found');
    expect(app.setFavorite(crypto.randomUUID(), false)).toBe(false);
  });
  it('a removed track leaves the favourites', () => {
    const a = add();
    app.setFavorite(a, true);
    tracks.delete(a as never);
    expect(app.listFavorites()).toEqual([]);
  });
});

describe('history', () => {
  it('lists each track once, most recent first, with the limit default/clamping', () => {
    const ids = Array.from({ length: 3 }, () => add());
    ids.forEach((id) => app.recordPlay(id));
    app.recordPlay(ids[0]!);
    expect(app.listHistory().map((i) => i.track.id)).toEqual([ids[0], ids[2], ids[1]]);
    expect(app.listHistory(2)).toHaveLength(2);
    expect(app.listHistory(0)).toHaveLength(1); // clamped to at least 1
    expect(app.listHistory(10_000)).toHaveLength(3);
  });
  it('ignores unknown tracks and clears with a count', () => {
    app.recordPlay(crypto.randomUUID());
    app.recordPlay('garbage');
    expect(app.listHistory()).toEqual([]);
    app.recordPlay(add());
    expect(app.clearHistory()).toBe(1);
    expect(app.clearHistory()).toBe(0);
  });
});

describe('playlists', () => {
  it('creates with a normalised name and tracks, and returns the view', () => {
    const a = add({ durationSeconds: 60 });
    const view = app.createPlaylist('  My   list ', [a, crypto.randomUUID()]);
    expect(view).toMatchObject({ name: 'My list', trackCount: 1, durationSeconds: 60, coverTrackIds: [a] });
  });
  it('enforces the playlist limit with limit-reached and the name rule with name-invalid', () => {
    app.createPlaylist('a');
    app.createPlaylist('b');
    expect(code(() => app.createPlaylist('c'))).toBe('limit-reached');
    expect(code(() => app.createPlaylist(''))).toBe('name-invalid');
    expect(app.listPlaylists()).toHaveLength(2);
  });
  it('rename validates and reports unknown playlists', () => {
    const { id } = app.createPlaylist('a');
    expect(app.renamePlaylist(id, ' z ').name).toBe('z');
    expect(code(() => app.renamePlaylist(id, ''))).toBe('name-invalid');
    expect(code(() => app.renamePlaylist('nope', 'x'))).toBe('playlist-not-found');
  });
  it('get returns entries in order with distinct entry ids; unknown is playlist-not-found', () => {
    const a = add();
    const { id } = app.createPlaylist('d', [a, a]);
    const got = app.getPlaylist(id);
    expect(got.entries.map((e) => e.track.id)).toEqual([a, a]);
    expect(new Set(got.entries.map((e) => e.entryId)).size).toBe(2);
    expect(code(() => app.getPlaylist('nope'))).toBe('playlist-not-found');
  });
  it('addToPlaylist counts what was added, cuts at the limit, and errors when nothing fits', () => {
    const [a, b, c] = [add(), add(), add()] as [string, string, string];
    const { id } = app.createPlaylist('L', [a, b, c]);
    expect(app.addToPlaylist(id, [a, crypto.randomUUID(), b])).toMatchObject({ added: 1 });
    expect(code(() => app.addToPlaylist(id, [a]))).toBe('limit-reached');
    expect(code(() => app.addToPlaylist('nope', [a]))).toBe('playlist-not-found');
    expect(app.getPlaylist(id).playlist.trackCount).toBe(4);
  });
  it('remove and move return the updated playlist', () => {
    const [a, b, c] = [add(), add(), add()] as [string, string, string];
    const { id } = app.createPlaylist('RM', [a, b, c]);
    const entries = app.getPlaylist(id).entries;
    expect(app.movePlaylistEntry(id, entries[2]!.entryId, 0).entries.map((e) => e.track.id)).toEqual([c, a, b]);
    expect(app.removeFromPlaylist(id, [entries[0]!.entryId]).entries.map((e) => e.track.id)).toEqual([c, b]);
    expect(code(() => app.removeFromPlaylist('nope', []))).toBe('playlist-not-found');
    expect(code(() => app.movePlaylistEntry('nope', 'x', 0))).toBe('playlist-not-found');
  });
  it('delete reports whether it existed', () => {
    const { id } = app.createPlaylist('x');
    expect(app.deletePlaylist(id)).toBe(true);
    expect(app.deletePlaylist(id)).toBe(false);
  });
  it('a track removed from the library leaves every playlist and the counts follow', () => {
    const [a, b] = [add(), add()] as [string, string];
    const { id } = app.createPlaylist('gone', [a, b, a]);
    tracks.delete(a as never);
    const got = app.getPlaylist(id);
    expect(got.entries.map((e) => e.track.id)).toEqual([b]);
    expect(got.playlist.trackCount).toBe(1);
  });
});

describe('listSourceTrackIds', () => {
  it('follows each list order (favourites newest first, history most recent first, playlist order with duplicates)', () => {
    const [a, b] = [add(), add()] as [string, string];
    app.setFavorite(a, true);
    app.setFavorite(b, true);
    app.recordPlay(a);
    app.recordPlay(b);
    const { id } = app.createPlaylist('p', [a, b, a]);
    expect(app.listSourceTrackIds({ kind: 'favorites' })).toEqual([b, a]);
    expect(app.listSourceTrackIds({ kind: 'history' })).toEqual([b, a]);
    expect(app.listSourceTrackIds({ kind: 'playlist', playlistId: id })).toEqual([a, b, a]);
  });
  it('an unknown playlist is playlist-not-found', () => {
    expect(code(() => app.listSourceTrackIds({ kind: 'playlist', playlistId: 'nope' }))).toBe('playlist-not-found');
  });
});
