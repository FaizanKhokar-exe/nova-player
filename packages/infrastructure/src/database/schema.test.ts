import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IN_MEMORY_DATABASE, openDatabase, type NovaDatabase } from './open-database.js';

let db: NovaDatabase;
beforeEach(() => {
  db = openDatabase({ filePath: IN_MEMORY_DATABASE });
});
afterEach(() => {
  db.close();
});

type Row = Record<string, string | number | null>;

/** A complete, valid row; tests override single fields to probe constraints. */
function validRow(overrides: Row = {}): Row {
  return {
    id: '123e4567-e89b-42d3-a456-426614174000',
    source_path: 'C:\\Music\\Artist - Song.mp3',
    source_path_key: 'c:\\music\\artist - song.mp3',
    title: 'Song',
    title_source: 'tag',
    artist: 'Artist',
    artist_source: 'tag',
    album: null,
    album_artist: null,
    genre: null,
    track_number: null,
    disc_number: null,
    year: null,
    duration_seconds: null,
    artwork_kind: 'none',
    artwork_path: null,
    size_bytes: 1234,
    dedup_key: 'song|artist|1234',
    ...overrides,
  };
}

function insert(row: Row): void {
  const columns = Object.keys(row);
  db.connection
    .prepare(`INSERT INTO tracks (${columns.join(', ')}) VALUES (${columns.map((c) => `@${c}`).join(', ')})`)
    .run(row);
}

describe('schema: tracks table', () => {
  it('creates the tracks table, the dedup index and the migrations table', () => {
    const names = (
      db.connection.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(['tracks', 'idx_tracks_dedup_key', 'schema_migrations']));
  });

  it('has exactly the columns the Track model + file facts justify', () => {
    const columns = (db.connection.prepare('PRAGMA table_info(tracks)').all() as { name: string; notnull: number }[]);
    expect(columns.map((c) => c.name)).toEqual([
      'id', 'source_path', 'source_path_key', 'title', 'title_source', 'artist', 'artist_source',
      'album', 'album_artist', 'genre', 'track_number', 'disc_number', 'year', 'duration_seconds',
      'artwork_kind', 'artwork_path', 'size_bytes', 'dedup_key', 'modified_at_ms',
    ]);
    const required = columns.filter((c) => c.notnull === 1).map((c) => c.name);
    expect(required).toEqual(
      expect.arrayContaining(['id', 'source_path', 'title', 'title_source', 'artist', 'artist_source', 'artwork_kind', 'size_bytes', 'dedup_key']),
    );
  });

  it('round-trips a fully populated row through real SQLite read/write', () => {
    const row = validRow({
      album: 'Album', album_artist: 'Various', genre: 'Rock',
      track_number: 3, disc_number: 1, year: 1999, duration_seconds: 215.5,
      artwork_kind: 'external', artwork_path: 'C:\\Music\\cover.jpg',
    });
    insert(row);
    expect(db.connection.prepare('SELECT * FROM tracks WHERE id = ?').get(row.id)).toEqual({ ...row, modified_at_ms: 0 });
  });

  it('round-trips a minimal row with optional fields as NULL', () => {
    insert(validRow());
    const stored = db.connection.prepare('SELECT * FROM tracks').get() as Row;
    expect(stored.album).toBeNull();
    expect(stored.year).toBeNull();
    expect(stored.artwork_kind).toBe('none');
  });

  describe('constraints', () => {
    const rejected: [string, Row][] = [
      ['id of the wrong length', { id: 'not-a-uuid' }],
      ['empty source_path', { source_path: '' }],
      ['empty source_path_key', { source_path_key: '' }],
      ['negative modified_at_ms', { modified_at_ms: -1 }],
      ['empty title', { title: '' }],
      ['NULL title', { title: null }],
      ['invalid title_source', { title_source: 'guess' }],
      ['empty artist', { artist: '' }],
      ['invalid artist_source', { artist_source: 'magic' }],
      ['empty (non-NULL) album', { album: '' }],
      ['empty (non-NULL) genre', { genre: '' }],
      ['zero track_number', { track_number: 0 }],
      ['negative disc_number', { disc_number: -1 }],
      ['year below 1000', { year: 999 }],
      ['year above 9999', { year: 10000 }],
      ['negative duration', { duration_seconds: -0.5 }],
      ['infinite duration', { duration_seconds: Infinity }],
      ['unknown artwork_kind', { artwork_kind: 'remote' }],
      ['external artwork without a path', { artwork_kind: 'external', artwork_path: null }],
      ['external artwork with an empty path', { artwork_kind: 'external', artwork_path: '' }],
      ['embedded artwork carrying a path', { artwork_kind: 'embedded', artwork_path: 'x.jpg' }],
      ['negative size_bytes', { size_bytes: -1 }],
      ['NULL dedup_key', { dedup_key: null }],
    ];

    it.each(rejected)('rejects %s', (_label, overrides) => {
      expect(() => insert(validRow(overrides))).toThrow(/constraint|CHECK|NOT NULL/i);
      expect(db.connection.prepare('SELECT COUNT(*) AS n FROM tracks').get()).toEqual({ n: 0 });
    });

    it('rejects a non-integer track_number (STRICT typing)', () => {
      expect(() => insert(validRow({ track_number: 'three' }))).toThrow();
    });

    it('rejects a duplicate id', () => {
      insert(validRow());
      expect(() => insert(validRow({ source_path: 'C:\\other.mp3', source_path_key: 'other' }))).toThrow(/UNIQUE|PRIMARY KEY/i);
    });

    it('rejects a duplicate source_path_key (one row per file, however the path is spelled)', () => {
      insert(validRow());
      expect(() =>
        insert(validRow({ id: '223e4567-e89b-42d3-a456-426614174000', source_path: 'c:\\MUSIC\\Artist - Song.mp3' })),
      ).toThrow(/UNIQUE/i);
    });

    it('allows the same display source_path text only once per key, but different keys freely', () => {
      insert(validRow());
      insert(validRow({ id: '223e4567-e89b-42d3-a456-426614174000', source_path_key: 'other-key' }));
      expect(db.connection.prepare('SELECT COUNT(*) AS n FROM tracks').get()).toEqual({ n: 2 });
    });

    it('allows duplicate dedup_key values (the key is advisory, not unique)', () => {
      insert(validRow());
      insert(validRow({ id: '223e4567-e89b-42d3-a456-426614174000', source_path: 'D:\\copy.mp3', source_path_key: 'd:\\copy.mp3' }));
      expect(db.connection.prepare('SELECT COUNT(*) AS n FROM tracks').get()).toEqual({ n: 2 });
    });

    it('accepts boundary values (year 1000/9999, zero duration, embedded artwork)', () => {
      insert(validRow({ year: 1000, duration_seconds: 0, artwork_kind: 'embedded' }));
      insert(validRow({ id: '223e4567-e89b-42d3-a456-426614174000', source_path: 'x', source_path_key: 'x', year: 9999 }));
    });
  });

  it('uses the dedup index for dedup_key lookups', () => {
    const plan = db.connection
      .prepare('EXPLAIN QUERY PLAN SELECT id FROM tracks WHERE dedup_key = ?')
      .all('k') as { detail: string }[];
    expect(plan.map((p) => p.detail).join(' ')).toContain('idx_tracks_dedup_key');
  });
});
