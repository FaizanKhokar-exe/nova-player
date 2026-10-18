import type { Migration } from './migration-runner.js';

/**
 * Migration 4: the one saved playback session (Phase 4).
 *
 * A singleton table (`id` is always 1) holding the queue exactly as the
 * domain's `QueueState` models it, so a restart can resume where the listener
 * left off:
 *  - `queue_json`: JSON array of TrackIds in the ACTIVE play order.
 *  - `unshuffled_json`: JSON array of the pre-shuffle order, or NULL when
 *    shuffle is off (this is what makes shuffle state restorable).
 *  - `current_index`: index into `queue_json`, or NULL when nothing is current.
 *  - `repeat_mode`: 'off' | 'all' | 'one'.
 *  - `position_ms`: whole milliseconds into the current track - written
 *    separately and often (see `savePosition`), so it is its own column rather
 *    than part of the JSON.
 *
 * TrackIds are stored as JSON values, not foreign keys: a track can leave the
 * library while still being queued, and the application layer reconciles the
 * queue against the library (dropping the missing ones) when it loads.
 */
export const playbackSessionMigration: Migration = {
  version: 4,
  name: 'playback-session',
  up: (db) => {
    db.exec(`
      CREATE TABLE playback_session (
        id               INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
        queue_json       TEXT NOT NULL,
        unshuffled_json  TEXT,
        current_index    INTEGER CHECK (current_index IS NULL OR current_index >= 0),
        repeat_mode      TEXT NOT NULL CHECK (repeat_mode IN ('off', 'all', 'one')),
        position_ms      INTEGER NOT NULL CHECK (position_ms >= 0),
        updated_at_ms    INTEGER NOT NULL CHECK (updated_at_ms >= 0)
      ) STRICT;
    `);
  },
};
