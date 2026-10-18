import type { Migration } from './migration-runner.js';

/**
 * Migration 6 (Phase 11): the listener's own collections - favourites, recently played and playlists.
 *
 * Every table points at `tracks (id)` with `ON DELETE CASCADE`: when a track leaves the library (its file was
 * removed, or its folder was removed) it disappears from favourites, history and every playlist with it, and
 * nothing is left dangling. Updates to a track (a rescan with new tags) are UPDATEs, so ids are stable and
 * collections survive rescans. A moved file gets a new id (the documented limitation shared with the queue
 * and with attached lyrics).
 *
 *  - `favorites`: one row per favourite track.
 *  - `play_history`: one row per track (its most recent play and how often it was played). The repository
 *    keeps at most 200 rows and prunes the oldest.
 *  - `playlists` / `playlist_entries`: an entry is one ROW of a playlist (the same track may appear twice),
 *    named by its own `entry_id`. `position` is 0-based and gap-free; `UNIQUE (playlist_id, position)` makes
 *    SQLite refuse two rows at one place, which is why the repository re-numbers in two phases (see
 *    `SqlitePlaylistRepository`); the index SQLite builds for that constraint also serves "the entries of a
 *    playlist, in order".
 */
export const collectionsMigration: Migration = {
  version: 6,
  name: 'collections',
  up: (db) => {
    db.exec(`
      CREATE TABLE favorites (
        track_id    TEXT PRIMARY KEY NOT NULL REFERENCES tracks (id) ON DELETE CASCADE,
        added_at_ms INTEGER NOT NULL CHECK (added_at_ms >= 0)
      ) STRICT;
      CREATE INDEX idx_favorites_added ON favorites (added_at_ms);

      CREATE TABLE play_history (
        track_id           TEXT PRIMARY KEY NOT NULL REFERENCES tracks (id) ON DELETE CASCADE,
        last_played_at_ms  INTEGER NOT NULL CHECK (last_played_at_ms >= 0),
        play_count         INTEGER NOT NULL CHECK (play_count >= 1)
      ) STRICT;
      CREATE INDEX idx_play_history_last ON play_history (last_played_at_ms);

      CREATE TABLE playlists (
        id             TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
        name           TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
        created_at_ms  INTEGER NOT NULL CHECK (created_at_ms >= 0),
        updated_at_ms  INTEGER NOT NULL CHECK (updated_at_ms >= 0)
      ) STRICT;

      CREATE TABLE playlist_entries (
        entry_id     TEXT PRIMARY KEY NOT NULL CHECK (length(entry_id) > 0),
        playlist_id  TEXT NOT NULL REFERENCES playlists (id) ON DELETE CASCADE,
        track_id     TEXT NOT NULL REFERENCES tracks (id) ON DELETE CASCADE,
        position     INTEGER NOT NULL CHECK (position >= 0),
        UNIQUE (playlist_id, position)
      ) STRICT;
      CREATE INDEX idx_playlist_entries_track ON playlist_entries (track_id);
    `);
  },
};
