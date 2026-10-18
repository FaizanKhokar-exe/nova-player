import type Database from 'better-sqlite3';
import type { NovaDatabase } from '../database/index.js';

/**
 * The listener's favourite tracks (migration 6). Keyed by track id; takes an already-open database and
 * never opens or closes a connection. A track that leaves the library takes its favourite with it (cascade).
 */
export class SqliteFavoritesRepository {
  private readonly insert: Database.Statement;
  private readonly remove: Database.Statement<[string]>;
  private readonly selectIds: Database.Statement<[]>;
  private readonly exists: Database.Statement<[string]>;
  private readonly now: () => number;

  constructor(database: NovaDatabase, options: { readonly now?: () => number } = {}) {
    const db = database.connection;
    this.now = options.now ?? Date.now;
    // Favouriting a favourite keeps its ORIGINAL time: the list is "newest first", and a repeated click must not reorder it.
    this.insert = db.prepare('INSERT OR IGNORE INTO favorites (track_id, added_at_ms) VALUES (?, ?)');
    this.remove = db.prepare('DELETE FROM favorites WHERE track_id = ?');
    // `rowid` breaks ties between favourites added in the same millisecond: the later insert is "newer".
    this.selectIds = db.prepare('SELECT track_id FROM favorites ORDER BY added_at_ms DESC, rowid DESC');
    this.exists = db.prepare('SELECT 1 FROM favorites WHERE track_id = ?');
  }

  /** Adds the favourite (no-op when it already is one). Throws if the track is not in the library (foreign key). */
  add(trackId: string): void {
    this.insert.run(trackId, Math.max(0, Math.trunc(this.now())));
  }

  /** Removes the favourite; `true` when there was one. */
  delete(trackId: string): boolean {
    return this.remove.run(trackId).changes > 0;
  }

  has(trackId: string): boolean {
    return this.exists.get(trackId) !== undefined;
  }

  /** Every favourite track id, most recently favourited first. */
  listIds(): string[] {
    return (this.selectIds.all() as { track_id: string }[]).map((row) => row.track_id);
  }
}
