import type Database from 'better-sqlite3';
import type { NovaDatabase } from '../database/index.js';

/** Most rows the history keeps; recording past it prunes the oldest. */
export const MAX_HISTORY_ROWS = 200;

export interface HistoryRow {
  readonly trackId: string;
  readonly lastPlayedAtMs: number;
  readonly playCount: number;
}

/**
 * What the listener played recently (migration 6): one row per track, holding when it was last played and how
 * often. Takes an already-open database and never opens or closes a connection.
 */
export class SqliteHistoryRepository {
  private readonly upsert: Database.Statement;
  private readonly prune: Database.Statement<[number]>;
  private readonly selectRecent: Database.Statement<[number]>;
  private readonly deleteAll: Database.Statement<[]>;
  private readonly record_: Database.Transaction<(trackId: string, atMs: number) => void>;
  private readonly now: () => number;
  /** Plays within one millisecond must still have a strict order ("most recent first"), so a time never repeats. */
  private lastAtMs = 0;

  constructor(database: NovaDatabase, options: { readonly now?: () => number } = {}) {
    const db = database.connection;
    this.now = options.now ?? Date.now;
    this.upsert = db.prepare(`
      INSERT INTO play_history (track_id, last_played_at_ms, play_count) VALUES (?, ?, 1)
      ON CONFLICT (track_id) DO UPDATE SET last_played_at_ms = excluded.last_played_at_ms, play_count = play_count + 1
    `);
    // Keeps the newest `?` rows. Ties in time are broken by id, so which row goes is deterministic.
    this.prune = db.prepare(`
      DELETE FROM play_history WHERE track_id NOT IN (
        SELECT track_id FROM play_history ORDER BY last_played_at_ms DESC, track_id LIMIT ?
      )
    `);
    this.selectRecent = db.prepare(
      'SELECT track_id, last_played_at_ms, play_count FROM play_history ORDER BY last_played_at_ms DESC, track_id LIMIT ?',
    );
    this.deleteAll = db.prepare('DELETE FROM play_history');
    // One transaction: a failed insert (unknown track) must not leave the prune half done, and vice versa.
    this.record_ = db.transaction((trackId: string, atMs: number) => {
      this.upsert.run(trackId, atMs);
      this.prune.run(MAX_HISTORY_ROWS);
    });
  }

  /** Records one play: sets the time, adds one to the count, prunes. Throws if the track is not in the library (foreign key). */
  record(trackId: string): void {
    this.lastAtMs = Math.max(Math.max(0, Math.trunc(this.now())), this.lastAtMs + 1);
    this.record_(trackId, this.lastAtMs);
  }

  /** The most recent plays, each track once, newest first. */
  list(limit: number): HistoryRow[] {
    const rows = this.selectRecent.all(Math.max(0, Math.trunc(limit))) as { track_id: string; last_played_at_ms: number; play_count: number }[];
    return rows.map((row) => ({ trackId: row.track_id, lastPlayedAtMs: row.last_played_at_ms, playCount: row.play_count }));
  }

  /** Forgets everything; returns how many rows were removed. */
  clear(): number {
    return this.deleteAll.run().changes;
  }
}
