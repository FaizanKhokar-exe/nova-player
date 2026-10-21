import type Database from 'better-sqlite3';
import type { NovaDatabase } from '../database/index.js';

/** Pictures the listener attached to tracks (migration 7). Takes an already-open database; never opens or closes a connection. */
export class SqliteCustomCoverRepository {
  private readonly select: Database.Statement<[string]>;
  private readonly upsert: Database.Statement;
  private readonly remove: Database.Statement<[string]>;
  private readonly now: () => number;

  constructor(database: NovaDatabase, options: { readonly now?: () => number } = {}) {
    const db = database.connection;
    this.now = options.now ?? Date.now;
    this.select = db.prepare('SELECT mime_type, data FROM custom_covers WHERE track_id = ?');
    this.upsert = db.prepare(`
      INSERT INTO custom_covers (track_id, mime_type, data, attached_at_ms) VALUES (@track_id, @mime_type, @data, @attached_at_ms)
      ON CONFLICT (track_id) DO UPDATE SET mime_type = excluded.mime_type, data = excluded.data, attached_at_ms = excluded.attached_at_ms
    `);
    this.remove = db.prepare('DELETE FROM custom_covers WHERE track_id = ?');
  }

  get(trackId: string): { readonly mimeType: string; readonly bytes: Uint8Array } | undefined {
    const row = this.select.get(trackId) as { mime_type: string; data: Buffer } | undefined;
    return row === undefined ? undefined : { mimeType: row.mime_type, bytes: new Uint8Array(row.data) };
  }

  /** Attaches (or replaces) the picture. Throws if the track is not in the library (foreign key). */
  set(trackId: string, mimeType: string, bytes: Uint8Array): void {
    this.upsert.run({ track_id: trackId, mime_type: mimeType, data: Buffer.from(bytes), attached_at_ms: Math.max(0, Math.trunc(this.now())) });
  }

  delete(trackId: string): boolean {
    return this.remove.run(trackId).changes > 0;
  }
}
