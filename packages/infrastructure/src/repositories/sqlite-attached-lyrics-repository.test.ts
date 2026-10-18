import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IN_MEMORY_DATABASE, MIGRATIONS, openDatabase, type NovaDatabase } from '../database/index.js';
import { makeTempDir, removeDir } from '../database/test-helpers.js';
import { SqliteAttachedLyricsRepository } from './sqlite-attached-lyrics-repository.js';
import { SqliteTrackRepository } from './sqlite-track-repository.js';
import { EXACT_PATH_KEYS, makeRecord } from './test-tracks.js';

let db: NovaDatabase;
let tracks: SqliteTrackRepository;
let lyrics: SqliteAttachedLyricsRepository;
let clock = 5000;
beforeEach(() => {
  clock = 5000;
  db = openDatabase({ filePath: IN_MEMORY_DATABASE });
  tracks = new SqliteTrackRepository(db, EXACT_PATH_KEYS);
  lyrics = new SqliteAttachedLyricsRepository(db, { now: () => clock++ });
});
afterEach(() => db.close());

const addTrack = (): string => {
  const record = makeRecord();
  tracks.insert(record);
  return record.track.id;
};
const rows = (): number => (db.connection.prepare('SELECT COUNT(*) AS n FROM attached_lyrics').get() as { n: number }).n;

describe('migration 5 (attached lyrics)', () => {
  it('is applied after playback-session, and the schema is at its version', () => {
    expect(MIGRATIONS[3]?.name).toBe('playback-session');
    expect(MIGRATIONS[4]?.name).toBe('attached-lyrics');
    expect(MIGRATIONS[4]?.version).toBe(5);
    expect(db.getSchemaVersion()).toBe(MIGRATIONS.length);
  });

  it('upgrades a version-4 database in place, keeping its tracks', () => {
    const dir = makeTempDir();
    try {
      const file = path.join(dir, 'v4.db');
      const old = openDatabase({ filePath: file, migrations: MIGRATIONS.slice(0, 4) });
      const oldTracks = new SqliteTrackRepository(old, EXACT_PATH_KEYS);
      const record = makeRecord();
      oldTracks.insert(record);
      old.close();

      const upgraded = openDatabase({ filePath: file });
      try {
        expect(upgraded.getSchemaVersion()).toBe(MIGRATIONS.length); // upgraded through every later migration too
        expect(new SqliteTrackRepository(upgraded, EXACT_PATH_KEYS).getById(record.track.id)?.title).toBe(record.track.title);
        const repo = new SqliteAttachedLyricsRepository(upgraded);
        repo.set(record.track.id, '[00:01.00]hello');
        expect(repo.get(record.track.id)).toBe('[00:01.00]hello');
      } finally {
        upgraded.close();
      }
    } finally {
      removeDir(dir);
    }
  });
});

describe('SqliteAttachedLyricsRepository', () => {
  it('has nothing for a track until something is attached', () => {
    expect(lyrics.get(addTrack())).toBeUndefined();
  });

  it('stores the text exactly and returns it', () => {
    const id = addTrack();
    const text = '[ti:Song]\n[00:01.00]héllo ♪\n[00:02.00]wörld\n';
    lyrics.set(id, text);
    expect(lyrics.get(id)).toBe(text);
  });

  it('attaching again replaces the text (one row per track)', () => {
    const id = addTrack();
    lyrics.set(id, '[00:01.00]first');
    lyrics.set(id, '[00:01.00]second');
    expect(lyrics.get(id)).toBe('[00:01.00]second');
    expect(rows()).toBe(1);
  });

  it('delete reports whether something was removed, and only that track is affected', () => {
    const a = addTrack();
    const b = addTrack();
    lyrics.set(a, '[00:01.00]a');
    lyrics.set(b, '[00:01.00]b');
    expect(lyrics.delete(a)).toBe(true);
    expect(lyrics.delete(a)).toBe(false);
    expect(lyrics.get(a)).toBeUndefined();
    expect(lyrics.get(b)).toBe('[00:01.00]b');
  });

  it('refuses a track that is not in the library (foreign key) and empty text', () => {
    expect(() => lyrics.set(crypto.randomUUID(), '[00:01.00]x')).toThrow();
    expect(() => lyrics.set(addTrack(), '')).toThrow();
    expect(rows()).toBe(0);
  });

  it('a track leaving the library takes its attachment with it (cascade)', () => {
    const id = addTrack();
    lyrics.set(id, '[00:01.00]x');
    tracks.delete(id as never);
    expect(rows()).toBe(0);
  });

  it('updating a track (a rescan with new tags) keeps its attachment', () => {
    const record = makeRecord();
    tracks.insert(record);
    lyrics.set(record.track.id, '[00:01.00]x');
    tracks.update({ ...record, track: { ...record.track, title: 'Renamed in the tags' } });
    expect(lyrics.get(record.track.id)).toBe('[00:01.00]x');
  });

  it('records when it was attached', () => {
    const id = addTrack();
    lyrics.set(id, '[00:01.00]x');
    expect(db.connection.prepare('SELECT attached_at_ms AS t FROM attached_lyrics').get()).toEqual({ t: 5000 });
  });
});
