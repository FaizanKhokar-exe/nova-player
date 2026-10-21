import type { Migration } from './migration-runner.js';

/**
 * Migration 7 (v0.11.3): two small additions for per-track things the listener chose by hand.
 *  - `attached_lyrics.source_path` remembers WHERE an attached `.lrc` came from (main-only; never sent to the renderer), so edits to that
 *    file are picked up again later. Nullable: rows attached before this version keep their stored copy, which also remains the fallback
 *    when the source file moves or is deleted.
 *  - `custom_covers`: a picture the listener attached to a track from the player bar. Stored in the database (<= 5 MiB, JPEG/PNG/WebP by
 *    content) so it survives the picture being moved; `ON DELETE CASCADE` removes it with its track. It wins over embedded and folder covers.
 */
export const customMediaMigration: Migration = {
  version: 7,
  name: 'custom-media',
  up: (db) => {
    db.exec(`
      ALTER TABLE attached_lyrics ADD COLUMN source_path TEXT;
      CREATE TABLE custom_covers (
        track_id        TEXT PRIMARY KEY NOT NULL REFERENCES tracks (id) ON DELETE CASCADE,
        mime_type       TEXT NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
        data            BLOB NOT NULL CHECK (length(data) > 0),
        attached_at_ms  INTEGER NOT NULL CHECK (attached_at_ms >= 0)
      ) STRICT;
    `);
  },
};
