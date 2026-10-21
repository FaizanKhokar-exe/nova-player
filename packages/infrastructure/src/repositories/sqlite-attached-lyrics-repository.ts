import type Database from 'better-sqlite3';
import type { NovaDatabase } from '../database/index.js';

/**
 * The lyrics text a listener attached to a track (migration 5). Keyed by track id; takes an already-open
 * database and never opens or closes a connection.
 */
export class SqliteAttachedLyricsRepository {
  private readonly selectText: Database.Statement<[string]>;
  private readonly selectSource: Database.Statement<[string]>;
  private readonly upsert: Database.Statement;
  private readonly remove: Database.Statement<[string]>;
  private readonly now: () => number;

  constructor(database: NovaDatabase, options: { readonly now?: () => number } = {}) {
    const db = database.connection;
    this.now = options.now ?? Date.now;
    this.selectText = db.prepare('SELECT lrc_text FROM attached_lyrics WHERE track_id = ?');
    this.selectSource = db.prepare('SELECT source_path FROM attached_lyrics WHERE track_id = ?');
    this.upsert = db.prepare(`
      INSERT INTO attached_lyrics (track_id, lrc_text, attached_at_ms, source_path) VALUES (@track_id, @lrc_text, @attached_at_ms, @source_path)
      ON CONFLICT (track_id) DO UPDATE SET lrc_text = excluded.lrc_text, attached_at_ms = excluded.attached_at_ms, source_path = excluded.source_path
    `);
    this.remove = db.prepare('DELETE FROM attached_lyrics WHERE track_id = ?');
  }

  /** The attached lyrics text, or `undefined` when none is attached. */
  get(trackId: string): string | undefined {
    const row = this.selectText.get(trackId) as { lrc_text: string } | undefined;
    return row?.lrc_text;
  }

  /** Attaches (or replaces) the lyrics. Throws if the track is not in the library (foreign key). */
  set(trackId: string, lrcText: string, sourcePath?: string): void {
    this.upsert.run({ track_id: trackId, lrc_text: lrcText, attached_at_ms: Math.max(0, Math.trunc(this.now())), source_path: sourcePath ?? null });
  }

  /** Where the attached file came from (main-only), or `undefined` (attached before v0.11.3, or no attachment). */
  getSource(trackId: string): string | undefined {
    const row = this.selectSource.get(trackId) as { source_path: string | null } | undefined;
    return row?.source_path ?? undefined;
  }

  /** Removes the attachment; `true` when there was one. */
  delete(trackId: string): boolean {
    return this.remove.run(trackId).changes > 0;
  }
}
