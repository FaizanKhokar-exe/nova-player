import type { Migration } from './migration-runner.js';

/**
 * Migration 8 (v0.15.0): names the listener corrected by hand. A SEPARATE table, so the scanner (which rewrites a track's
 * tag columns whenever the file changes) can never undo an edit; reads lay the edit over the scanned tags. Removing the
 * row ("Reset to the file's tags") brings the original tags back. `ON DELETE CASCADE` drops it with its track.
 */
export const trackEditsMigration: Migration = {
  version: 8,
  name: 'track-edits',
  up: (db) => {
    db.exec(`
      CREATE TABLE track_edits (
        track_id   TEXT PRIMARY KEY NOT NULL REFERENCES tracks (id) ON DELETE CASCADE,
        title      TEXT NOT NULL CHECK (length(title) > 0),
        artist     TEXT NOT NULL CHECK (length(artist) > 0),
        album      TEXT,
        edited_at_ms INTEGER NOT NULL CHECK (edited_at_ms >= 0)
      ) STRICT;
    `);
  },
};
