import type { Migration } from './migration-runner.js';

/**
 * Migration 2: what Phase 2E (library scanning) needs from the `tracks`
 * table, and nothing else.
 *
 *  - `modified_at_ms`: the file's last-modified time when it was read. With
 *    the existing `size_bytes` it is what incremental scanning compares to
 *    decide "unchanged - skip the metadata read". DEFAULT 0 = unknown, which
 *    never equals a real file time, so such a row is simply re-read.
 *
 *  - `source_path_key`: the path COMPARISON key (see the path policy in
 *    filesystem/path-policy.ts), UNIQUE. `source_path` itself keeps the
 *    display-case canonical path but is no longer UNIQUE, because on Windows
 *    `C:\Music\A.mp3` and `c:\music\a.mp3` are the same file and a
 *    byte-exact UNIQUE on `source_path` could not see that. The key can.
 *    The key is written by the repository, never by callers.
 *
 * SQLite cannot `ALTER TABLE ... ADD COLUMN ... UNIQUE`, so the table is
 * rebuilt (create new, copy, drop old, rename). Rows written before this
 * migration get `source_path_key = source_path` and `modified_at_ms = 0`:
 * before Phase 2E no production code wrote to this table, and the first scan
 * re-reads those rows (time 0) and rewrites them with a proper key. If two
 * legacy rows somehow collide on the key, the UNIQUE constraint fails the
 * migration, which rolls back and leaves the database at version 1 rather
 * than silently dropping a row.
 */
export const scanStateMigration: Migration = {
  version: 2,
  name: 'scan-state-and-path-key',
  up: (db) => {
    db.exec(`
      CREATE TABLE tracks_v2 (
        id               TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
        source_path      TEXT NOT NULL CHECK (length(source_path) > 0),
        source_path_key  TEXT NOT NULL UNIQUE CHECK (length(source_path_key) > 0),

        title            TEXT NOT NULL CHECK (length(title) > 0),
        title_source     TEXT NOT NULL CHECK (title_source IN ('tag', 'filename', 'unknown')),
        artist           TEXT NOT NULL CHECK (length(artist) > 0),
        artist_source    TEXT NOT NULL CHECK (artist_source IN ('tag', 'filename', 'unknown')),

        album            TEXT CHECK (album IS NULL OR length(album) > 0),
        album_artist     TEXT CHECK (album_artist IS NULL OR length(album_artist) > 0),
        genre            TEXT CHECK (genre IS NULL OR length(genre) > 0),

        track_number     INTEGER CHECK (track_number IS NULL OR track_number > 0),
        disc_number      INTEGER CHECK (disc_number IS NULL OR disc_number > 0),
        year             INTEGER CHECK (year IS NULL OR year BETWEEN 1000 AND 9999),
        duration_seconds REAL CHECK (duration_seconds IS NULL OR (duration_seconds >= 0 AND duration_seconds < 1e300)),

        artwork_kind     TEXT NOT NULL CHECK (artwork_kind IN ('embedded', 'external', 'none')),
        artwork_path     TEXT,

        size_bytes       INTEGER NOT NULL CHECK (size_bytes >= 0),
        dedup_key        TEXT NOT NULL,
        modified_at_ms   INTEGER NOT NULL DEFAULT 0 CHECK (modified_at_ms >= 0),

        CHECK (
          (artwork_kind = 'external' AND artwork_path IS NOT NULL AND length(artwork_path) > 0)
          OR (artwork_kind <> 'external' AND artwork_path IS NULL)
        )
      ) STRICT;

      INSERT INTO tracks_v2 (
        id, source_path, source_path_key, title, title_source, artist, artist_source,
        album, album_artist, genre, track_number, disc_number, year, duration_seconds,
        artwork_kind, artwork_path, size_bytes, dedup_key, modified_at_ms
      )
      SELECT
        id, source_path, source_path, title, title_source, artist, artist_source,
        album, album_artist, genre, track_number, disc_number, year, duration_seconds,
        artwork_kind, artwork_path, size_bytes, dedup_key, 0
      FROM tracks;

      DROP TABLE tracks;
      ALTER TABLE tracks_v2 RENAME TO tracks;
      CREATE INDEX idx_tracks_dedup_key ON tracks (dedup_key);
    `);
  },
};
