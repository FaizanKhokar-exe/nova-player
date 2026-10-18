import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initialSchemaMigration } from './initial-schema.js';
import { MIGRATIONS } from './migrations.js';
import { openDatabase } from './open-database.js';
import { makeTempDir, removeDir } from './test-helpers.js';

let dir: string;
beforeEach(() => {
  dir = makeTempDir();
});
afterEach(() => {
  removeDir(dir);
});

const ID_A = '123e4567-e89b-42d3-a456-426614174000';
const ID_B = '223e4567-e89b-42d3-a456-426614174000';

function insertV1(db: ReturnType<typeof openDatabase>, id: string, sourcePath: string): void {
  db.connection
    .prepare(
      `INSERT INTO tracks (id, source_path, title, title_source, artist, artist_source, album, artwork_kind, size_bytes, dedup_key)
       VALUES (?, ?, 'Title', 'tag', 'Artist', 'tag', 'Album', 'none', 500, 'dedup')`,
    )
    .run(id, sourcePath);
}

describe('migration 2: scan state + path key', () => {
  it('upgrades a version-1 database in place, keeping every row and column value', () => {
    const filePath = path.join(dir, 'nova.db');
    const v1 = openDatabase({ filePath, migrations: [initialSchemaMigration] });
    insertV1(v1, ID_A, 'C:\\Music\\a.mp3');
    insertV1(v1, ID_B, 'C:\\Music\\b.mp3');
    expect(v1.getSchemaVersion()).toBe(1);
    v1.close();

    const upgraded = openDatabase({ filePath });
    try {
      expect(upgraded.getSchemaVersion()).toBe(MIGRATIONS.length);
      const rows = upgraded.connection.prepare('SELECT * FROM tracks ORDER BY id').all() as Record<string, unknown>[];
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        id: ID_A, source_path: 'C:\\Music\\a.mp3', source_path_key: 'C:\\Music\\a.mp3',
        title: 'Title', album: 'Album', size_bytes: 500, dedup_key: 'dedup',
        modified_at_ms: 0, // unknown -> the first scan re-reads it
      });
    } finally {
      upgraded.close();
    }
  });

  it('keeps the dedup index and enforces the new unique path key', () => {
    const db = openDatabase({ filePath: path.join(dir, 'nova.db') });
    try {
      const plan = (db.connection.prepare('EXPLAIN QUERY PLAN SELECT id FROM tracks WHERE dedup_key = ?').all('k') as { detail: string }[])
        .map((p) => p.detail)
        .join(' ');
      expect(plan).toContain('idx_tracks_dedup_key');

      const insert = db.connection.prepare(
        `INSERT INTO tracks (id, source_path, source_path_key, title, title_source, artist, artist_source, artwork_kind, size_bytes, dedup_key)
         VALUES (?, ?, ?, 'T', 'tag', 'A', 'tag', 'none', 1, 'k')`,
      );
      insert.run(ID_A, 'C:\\Music\\a.mp3', 'c:\\music\\a.mp3');
      expect(() => insert.run(ID_B, 'c:\\MUSIC\\A.MP3', 'c:\\music\\a.mp3')).toThrow(/UNIQUE/);
    } finally {
      db.close();
    }
  });

  it('a failing upgrade rolls back completely and leaves the v1 table and its rows intact', () => {
    const filePath = path.join(dir, 'nova.db');
    const v1 = openDatabase({ filePath, migrations: [initialSchemaMigration] });
    insertV1(v1, ID_A, 'C:\\Music\\a.mp3');
    // A stray table with the migration's temp name makes CREATE TABLE tracks_v2 fail.
    v1.connection.exec('CREATE TABLE tracks_v2 (x INTEGER)');
    v1.close();

    expect(() => openDatabase({ filePath })).toThrow(/scan-state-and-path-key/);

    const check = openDatabase({ filePath, migrations: [initialSchemaMigration] });
    try {
      expect(check.getSchemaVersion()).toBe(1);
      expect(check.connection.prepare('SELECT COUNT(*) AS n FROM tracks').get()).toEqual({ n: 1 });
      expect(check.connection.prepare("SELECT name FROM pragma_table_info('tracks') WHERE name = 'source_path_key'").all()).toEqual([]);
    } finally {
      check.close();
    }
  });
});
