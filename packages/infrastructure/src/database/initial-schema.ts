import type { Migration } from './migration-runner.js';

/**
 * Migration 1: the `tracks` table - the persisted form of the Phase 1
 * `Track` entity plus the two file facts the domain model needs a database
 * for. Deliberately nothing else: no playlists, queue, albums, artists,
 * lyrics or settings tables, because no current phase persists them.
 *
 * Non-obvious decisions:
 *  - Column names are snake_case; mapping to/from the camelCase domain
 *    `Track` is the Phase 2B repository's job. Domain types stay DB-free.
 *  - `id` is the TrackId (UUID text, 36 chars). It is NOT derived from
 *    `source_path`, so a moved/renamed file keeps its identity.
 *  - `source_path` is UNIQUE (one row per file). Path normalisation
 *    (separators, drive-letter case) is Phase 2C's concern and must happen
 *    BEFORE insert; the constraint itself is a plain byte-exact match.
 *  - title/artist are NOT NULL and non-empty, mirroring `createTrack`, which
 *    always resolves them ("Untitled Track"/"Unknown Artist" at worst). The
 *    *_source columns store MetadataFieldSource for the self-healing policy.
 *  - album/album_artist/genre/track_number/disc_number/year/duration_seconds
 *    are nullable: the domain leaves them `undefined` when absent. CHECKs
 *    repeat the domain's sanitisation rules as a last line of defence
 *    (positive integers, 4-digit year, finite non-negative duration), so a
 *    buggy writer fails loudly instead of persisting garbage.
 *  - Artwork is stored as a REFERENCE (kind + optional path), never bytes.
 *    A CHECK keeps the pair consistent: a path exists iff kind = 'external'.
 *  - `size_bytes` + `dedup_key` exist because `computeDeduplicationKey`
 *    needs the file size, which `Track` does not carry. The key is advisory
 *    ("looks like a duplicate"), so its index is deliberately NOT unique.
 *  - No foreign keys: there is exactly one entity table. `foreign_keys` is
 *    still switched ON per connection so later tables get enforcement.
 *  - No title/artist indexes: search is an in-memory domain scan (Phase 1C),
 *    so those indexes would cost writes without serving a query.
 *  - Modified-time / scan bookkeeping columns are left to Phase 2E, which
 *    will know exactly what incremental scanning needs.
 *  - STRICT table: SQLite enforces declared column types instead of its
 *    default permissive type affinity.
 */
export const initialSchemaMigration: Migration = {
  version: 1,
  name: 'initial-schema',
  up: (db) => {
    db.exec(`
      CREATE TABLE tracks (
        id               TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
        source_path      TEXT NOT NULL UNIQUE CHECK (length(source_path) > 0),

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
        -- '< 1e300' rejects Infinity (SQLite stores it as a real value).
        duration_seconds REAL CHECK (duration_seconds IS NULL OR (duration_seconds >= 0 AND duration_seconds < 1e300)),

        artwork_kind     TEXT NOT NULL CHECK (artwork_kind IN ('embedded', 'external', 'none')),
        artwork_path     TEXT,

        size_bytes       INTEGER NOT NULL CHECK (size_bytes >= 0),
        dedup_key        TEXT NOT NULL,

        CHECK (
          (artwork_kind = 'external' AND artwork_path IS NOT NULL AND length(artwork_path) > 0)
          OR (artwork_kind <> 'external' AND artwork_path IS NULL)
        )
      ) STRICT;

      CREATE INDEX idx_tracks_dedup_key ON tracks (dedup_key);
    `);
  },
};
