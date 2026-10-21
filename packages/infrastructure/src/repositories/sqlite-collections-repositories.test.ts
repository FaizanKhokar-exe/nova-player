import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IN_MEMORY_DATABASE, MIGRATIONS, openDatabase, type NovaDatabase } from '../database/index.js';
import { makeTempDir, removeDir } from '../database/test-helpers.js';
import { SqliteFavoritesRepository } from './sqlite-favorites-repository.js';
import { MAX_HISTORY_ROWS, SqliteHistoryRepository } from './sqlite-history-repository.js';
import { SqlitePlaylistRepository, pickCoverTrackIds } from './sqlite-playlist-repository.js';
import { SqliteTrackRepository } from './sqlite-track-repository.js';
import { EXACT_PATH_KEYS, makeRecord } from './test-tracks.js';

let db: NovaDatabase;
let tracks: SqliteTrackRepository;
let clock = 1000;
let idCounter = 0;
let favorites: SqliteFavoritesRepository;
let history: SqliteHistoryRepository;
let playlists: SqlitePlaylistRepository;
const limits = { maxPlaylists: 3, maxEntries: 5 };

beforeEach(() => {
  clock = 1000;
  idCounter = 0;
  db = openDatabase({ filePath: IN_MEMORY_DATABASE });
  tracks = new SqliteTrackRepository(db, EXACT_PATH_KEYS);
  const now = (): number => clock++;
  favorites = new SqliteFavoritesRepository(db, { now });
  history = new SqliteHistoryRepository(db, { now });
  playlists = new SqlitePlaylistRepository(db, { now, newId: () => `id-${++idCounter}`, limits });
});
afterEach(() => db.close());

const addTrack = (overrides = {}): string => {
  const record = makeRecord(overrides);
  tracks.insert(record);
  return record.track.id;
};
const count = (table: string): number => (db.connection.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const order = (playlistId: string): string[] => playlists.entries(playlistId).map((e) => e.trackId);
const positions = (playlistId: string): number[] =>
  (db.connection.prepare('SELECT position FROM playlist_entries WHERE playlist_id = ? ORDER BY position').all(playlistId) as { position: number }[]).map((r) => r.position);

describe('migration 6 (collections)', () => {
  it('is registered as version 6 after attached-lyrics, and upgrades a version-5 database keeping its tracks', () => {
    expect(MIGRATIONS[5]?.name).toBe('collections');
    expect(MIGRATIONS[5]?.version).toBe(6);
    const dir = makeTempDir();
    try {
      const file = path.join(dir, 'v5.db');
      const old = openDatabase({ filePath: file, migrations: MIGRATIONS.slice(0, 5) });
      const record = makeRecord();
      new SqliteTrackRepository(old, EXACT_PATH_KEYS).insert(record);
      old.close();
      const upgraded = openDatabase({ filePath: file });
      try {
        expect(upgraded.getSchemaVersion()).toBe(MIGRATIONS.length); // v0.11.3: later migrations apply too (was a literal 6)
        new SqliteFavoritesRepository(upgraded).add(record.track.id);
        expect(new SqliteFavoritesRepository(upgraded).listIds()).toEqual([record.track.id]);
      } finally {
        upgraded.close();
      }
    } finally {
      removeDir(dir);
    }
  });
});

describe('SqliteFavoritesRepository', () => {
  it('lists newest first, and re-favouriting keeps the original place', () => {
    const [a, b, c] = [addTrack(), addTrack(), addTrack()] as [string, string, string];
    favorites.add(a);
    favorites.add(b);
    favorites.add(c);
    favorites.add(a);
    expect(favorites.listIds()).toEqual([c, b, a]);
    expect(count('favorites')).toBe(3);
  });

  it('delete reports whether there was one; has() follows', () => {
    const a = addTrack();
    favorites.add(a);
    expect(favorites.has(a)).toBe(true);
    expect(favorites.delete(a)).toBe(true);
    expect(favorites.delete(a)).toBe(false);
    expect(favorites.has(a)).toBe(false);
  });

  it('refuses an unknown track (foreign key) and cascades when a track is removed', () => {
    expect(() => favorites.add(crypto.randomUUID())).toThrow();
    const a = addTrack();
    favorites.add(a);
    tracks.delete(a as never);
    expect(count('favorites')).toBe(0);
  });

  it('survives a track update (rescan with new tags)', () => {
    const record = makeRecord();
    tracks.insert(record);
    favorites.add(record.track.id);
    tracks.update({ ...record, track: { ...record.track, title: 'Retagged' } });
    expect(favorites.has(record.track.id)).toBe(true);
  });
});

describe('SqliteHistoryRepository', () => {
  it('keeps one row per track: replay updates the time and increments the count', () => {
    const [a, b] = [addTrack(), addTrack()] as [string, string];
    history.record(a);
    history.record(b);
    history.record(a);
    const rows = history.list(10);
    expect(rows.map((r) => r.trackId)).toEqual([a, b]);
    expect(rows[0]).toMatchObject({ playCount: 2, lastPlayedAtMs: 1002 });
    expect(rows[1]).toMatchObject({ playCount: 1 });
    expect(count('play_history')).toBe(2);
  });

  it('plays inside one millisecond still have a strict order', () => {
    const frozen = new SqliteHistoryRepository(db, { now: () => 5000 });
    const [a, b, c] = [addTrack(), addTrack(), addTrack()] as [string, string, string];
    frozen.record(a);
    frozen.record(b);
    frozen.record(c);
    frozen.record(a);
    expect(frozen.list(10).map((r) => r.trackId)).toEqual([a, c, b]);
  });

  it('honours the limit', () => {
    for (let i = 0; i < 4; i += 1) history.record(addTrack());
    expect(history.list(2)).toHaveLength(2);
  });

  it('prunes the oldest beyond the maximum', () => {
    const ids: string[] = [];
    for (let i = 0; i < MAX_HISTORY_ROWS + 5; i += 1) {
      ids.push(addTrack());
      history.record(ids[i]!);
    }
    expect(count('play_history')).toBe(MAX_HISTORY_ROWS);
    const kept = new Set(history.list(MAX_HISTORY_ROWS + 10).map((r) => r.trackId));
    expect(kept.has(ids[0]!)).toBe(false);
    expect(kept.has(ids[4]!)).toBe(false);
    expect(kept.has(ids[5]!)).toBe(true);
    expect(kept.has(ids.at(-1)!)).toBe(true);
  });

  it('an unknown track is refused and leaves nothing behind; clear reports the count; cascade works', () => {
    expect(() => history.record(crypto.randomUUID())).toThrow();
    expect(count('play_history')).toBe(0);
    const a = addTrack();
    const b = addTrack();
    history.record(a);
    history.record(b);
    tracks.delete(a as never);
    expect(count('play_history')).toBe(1);
    expect(history.clear()).toBe(1);
    expect(history.list(5)).toEqual([]);
  });
});

describe('SqlitePlaylistRepository', () => {
  it('creates with tracks (unknown skipped, duplicates kept) in order', () => {
    const [a, b] = [addTrack(), addTrack()] as [string, string];
    const { id, outcome } = playlists.create('Mix', [a, crypto.randomUUID(), b, a]);
    expect(outcome).toEqual({ status: 'created', added: 3 });
    expect(order(id)).toEqual([a, b, a]);
    expect(positions(id)).toEqual([0, 1, 2]);
    const entryIds = playlists.entries(id).map((e) => e.entryId);
    expect(new Set(entryIds).size).toBe(3);
    expect(playlists.get(id)).toMatchObject({ name: 'Mix', trackCount: 3 });
  });

  it('enforces the playlist limit and writes nothing past it', () => {
    for (let i = 0; i < 3; i += 1) playlists.create(`P${i}`);
    expect(playlists.create('Too many', [addTrack()]).outcome).toEqual({ status: 'limit-reached' });
    expect(count('playlists')).toBe(3);
    expect(count('playlist_entries')).toBe(0);
  });

  it('lists by name case-insensitively and sums durations (absent when none known)', () => {
    const a = addTrack({ durationSeconds: 10.5 });
    const b = addTrack({ durationSeconds: 20 });
    const c = addTrack({});
    playlists.create('beta', [a, b]);
    playlists.create('Alpha', [c]);
    const list = playlists.list();
    expect(list.map((p) => p.name)).toEqual(['Alpha', 'beta']);
    expect(list[1]?.durationSeconds).toBeCloseTo(30.5);
    expect(list[0]?.durationSeconds).toBeUndefined();
  });

  it('addTracks appends, skips unknown ids, reports not-found and cuts at the entry limit', () => {
    const ids = [addTrack(), addTrack(), addTrack()];
    const { id } = playlists.create('L', [ids[0]!, ids[1]!, ids[2]!]);
    expect(playlists.addTracks('nope', ids)).toEqual({ status: 'not-found' });
    expect(playlists.addTracks(id, [crypto.randomUUID()])).toEqual({ status: 'added', added: 0 });
    expect(playlists.addTracks(id, [ids[0]!, ids[1]!, ids[2]!])).toEqual({ status: 'added', added: 2 }); // 3 + 2 = limit 5
    expect(playlists.addTracks(id, [ids[0]!])).toEqual({ status: 'limit-reached' });
    expect(positions(id)).toEqual([0, 1, 2, 3, 4]);
  });

  it('rename and delete (entries cascade); unknown playlists report false', () => {
    const { id } = playlists.create('Old', [addTrack()]);
    expect(playlists.rename(id, 'New')).toBe(true);
    expect(playlists.get(id)?.name).toBe('New');
    expect(playlists.rename('nope', 'x')).toBe(false);
    expect(playlists.delete(id)).toBe(true);
    expect(playlists.delete(id)).toBe(false);
    expect(count('playlist_entries')).toBe(0);
  });

  it('removeEntries closes the gaps, ignores stale/foreign ids, and handles duplicate rows of one track', () => {
    const [a, b, c] = [addTrack(), addTrack(), addTrack()] as [string, string, string];
    const { id } = playlists.create('R', [a, b, c, a]);
    const other = playlists.create('Other', [a]).id;
    const entries = playlists.entries(id);
    const foreign = playlists.entries(other)[0]!.entryId;
    expect(playlists.removeEntries(id, [entries[1]!.entryId, entries[1]!.entryId, 'stale', foreign])).toBe(true);
    expect(order(id)).toEqual([a, c, a]);
    expect(positions(id)).toEqual([0, 1, 2]);
    expect(order(other)).toEqual([a]); // the other playlist's row was not touched
    expect(playlists.removeEntries(id, [entries[0]!.entryId, entries[3]!.entryId])).toBe(true);
    expect(order(id)).toEqual([c]);
    expect(positions(id)).toEqual([0]);
    expect(playlists.removeEntries('nope', [])).toBe(false);
  });

  it('moveEntry reorders forwards and backwards, clamps, keeps positions gap-free and other playlists intact', () => {
    const t = [addTrack(), addTrack(), addTrack(), addTrack()] as [string, string, string, string];
    const { id } = playlists.create('M', t);
    const other = playlists.create('O', t).id;
    const e = playlists.entries(id).map((x) => x.entryId);
    playlists.moveEntry(id, e[0]!, 2);
    expect(order(id)).toEqual([t[1], t[2], t[0], t[3]]);
    playlists.moveEntry(id, e[3]!, 0);
    expect(order(id)).toEqual([t[3], t[1], t[2], t[0]]);
    playlists.moveEntry(id, e[2]!, 99); // clamped to the end
    expect(order(id)).toEqual([t[3], t[1], t[0], t[2]]);
    playlists.moveEntry(id, e[2]!, 3); // already there
    expect(order(id)).toEqual([t[3], t[1], t[0], t[2]]);
    expect(positions(id)).toEqual([0, 1, 2, 3]);
    expect(order(other)).toEqual(t);
    expect(playlists.moveEntry('nope', e[0]!, 0)).toBe(false);
    expect(playlists.moveEntry(id, 'stale', 0)).toBe(true);
    expect(order(id)).toEqual([t[3], t[1], t[0], t[2]]);
  });

  it('a failing step rolls the whole change back', () => {
    const [a, b] = [addTrack(), addTrack()] as [string, string];
    const { id } = playlists.create('Tx', [a, b]);
    // Make the second entry insert fail: a duplicate entry id.
    let calls = 0;
    const failing = new SqlitePlaylistRepository(db, { now: () => clock++, newId: () => (calls++ === 0 ? 'fresh-1' : 'fresh-1'), limits: { maxPlaylists: 9, maxEntries: 50 } });
    expect(() => failing.addTracks(id, [a, b])).toThrow();
    expect(order(id)).toEqual([a, b]);
    expect(positions(id)).toEqual([0, 1]);
  });

  it('cascades when a track is removed from the library and survives a track update', () => {
    const record = makeRecord();
    tracks.insert(record);
    const keep = addTrack();
    const { id } = playlists.create('C', [record.track.id, keep, record.track.id]);
    tracks.update({ ...record, track: { ...record.track, title: 'Retagged' } });
    expect(order(id)).toHaveLength(3);
    tracks.delete(record.track.id as never);
    expect(order(id)).toEqual([keep]);
  });

  it('touches updatedAt on changes', () => {
    const { id } = playlists.create('T');
    const created = playlists.get(id)!;
    playlists.addTracks(id, [addTrack()]);
    expect(playlists.get(id)!.updatedAtMs).toBeGreaterThan(created.updatedAtMs);
    expect(playlists.get(id)!.createdAtMs).toBe(created.createdAtMs);
  });

  it('reports up to four cover tracks, preferring distinct albums', () => {
    const sameAlbum = [addTrack({ album: 'One', artwork: { kind: 'embedded' } }), addTrack({ album: 'One', artwork: { kind: 'embedded' } }), addTrack({ album: 'One', artwork: { kind: 'embedded' } })];
    const other = addTrack({ album: 'Two' });
    const { id } = playlists.create('Covers', [...sameAlbum, other]);
    const covers = playlists.get(id)!.coverTrackIds;
    expect(covers).toHaveLength(4);
    expect(covers.slice(0, 2)).toEqual([sameAlbum[0], other]);
  });
});

describe('pickCoverTrackIds (pure)', () => {
  const c = (trackId: string, album: string | undefined, hasArtwork = true) => ({ trackId, album, albumArtist: undefined, hasArtwork });
  it('picks distinct albums first, then fills with distinct tracks', () => {
    expect(pickCoverTrackIds([c('1', 'A'), c('2', 'A'), c('3', 'B'), c('4', 'A'), c('5', 'A')])).toEqual(['1', '3', '2', '4']);
  });
  it('prefers tracks with artwork and treats album-less tracks as separate', () => {
    expect(pickCoverTrackIds([c('1', 'A', false), c('2', 'B'), c('3', undefined, false), c('4', undefined, false)])).toEqual(['2', '1', '3', '4']);
  });
  it('never repeats a track and handles empty input', () => {
    expect(pickCoverTrackIds([c('1', 'A'), c('1', 'A')])).toEqual(['1']);
    expect(pickCoverTrackIds([])).toEqual([]);
  });
});
