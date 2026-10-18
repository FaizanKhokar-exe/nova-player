import type { Migration } from './migration-runner.js';

/**
 * Migration 5: lyrics the user attached to a track by hand.
 *
 * A track's lyrics normally come from a `.lrc` file next to it (Phase 6). This table lets the listener
 * pick any `.lrc` file with a file dialog and attach it to a track. The text is COPIED into the database
 * when it is attached - nothing is read from the picked file afterwards, so no path is stored and the file
 * may be moved or deleted. Attached lyrics win over a sidecar file.
 *
 * `track_id` is a real foreign key with `ON DELETE CASCADE`: when a track leaves the library (its file was
 * removed, or its folder was removed) its attachment goes with it. Updates to a track (a rescan with new
 * tags) never delete the row, so attachments survive rescans; a moved file gets a new id (a documented
 * limitation shared by the queue and everything else that is keyed by track id).
 */
export const attachedLyricsMigration: Migration = {
  version: 5,
  name: 'attached-lyrics',
  up: (db) => {
    db.exec(`
      CREATE TABLE attached_lyrics (
        track_id         TEXT PRIMARY KEY NOT NULL REFERENCES tracks (id) ON DELETE CASCADE,
        lrc_text         TEXT NOT NULL CHECK (length(lrc_text) > 0),
        attached_at_ms   INTEGER NOT NULL CHECK (attached_at_ms >= 0)
      ) STRICT;
    `);
  },
};
