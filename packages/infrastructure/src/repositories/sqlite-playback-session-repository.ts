import type Database from 'better-sqlite3';
import { parseTrackId, type PersistedPlaybackSession, type PlaybackSessionRepository, type QueueState, type RepeatMode, type TrackId } from '@nova/domain';
import type { NovaDatabase } from '../database/index.js';

/** The saved playback session exists but cannot be turned back into a valid queue. */
export class PlaybackSessionCorruptError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'PlaybackSessionCorruptError';
  }
}

interface SessionRow {
  readonly queue_json: string;
  readonly unshuffled_json: string | null;
  readonly current_index: number | null;
  readonly repeat_mode: string;
  readonly position_ms: number;
}

export interface SqlitePlaybackSessionRepositoryOptions {
  /** Clock for `updated_at_ms`. Defaults to `Date.now`. */
  readonly now?: () => number;
}

const REPEAT_MODES: readonly string[] = ['off', 'all', 'one'];

function parseIdList(json: string, what: string): TrackId[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new PlaybackSessionCorruptError(`The saved ${what} is not valid JSON.`, { cause: error });
  }
  if (!Array.isArray(parsed)) throw new PlaybackSessionCorruptError(`The saved ${what} is not a list.`);
  return parsed.map((value) => {
    const id = typeof value === 'string' ? parseTrackId(value) : undefined;
    if (id === undefined) throw new PlaybackSessionCorruptError(`The saved ${what} contains an invalid track id.`);
    return id;
  });
}

/** SQLite implementation of the domain's `PlaybackSessionRepository` port.
 *  Takes an already-open `NovaDatabase`; never opens or closes a connection. */
export class SqlitePlaybackSessionRepository implements PlaybackSessionRepository {
  private readonly now: () => number;
  private readonly select: Database.Statement<[]>;
  private readonly upsert: Database.Statement;
  private readonly updatePosition: Database.Statement;
  private readonly remove: Database.Statement<[]>;

  constructor(database: NovaDatabase, options: SqlitePlaybackSessionRepositoryOptions = {}) {
    const db = database.connection;
    this.now = options.now ?? Date.now;
    this.select = db.prepare(
      'SELECT queue_json, unshuffled_json, current_index, repeat_mode, position_ms FROM playback_session WHERE id = 1',
    );
    this.upsert = db.prepare(`
      INSERT INTO playback_session (id, queue_json, unshuffled_json, current_index, repeat_mode, position_ms, updated_at_ms)
      VALUES (1, @queue_json, @unshuffled_json, @current_index, @repeat_mode, @position_ms, @updated_at_ms)
      ON CONFLICT (id) DO UPDATE SET
        queue_json = excluded.queue_json,
        unshuffled_json = excluded.unshuffled_json,
        current_index = excluded.current_index,
        repeat_mode = excluded.repeat_mode,
        position_ms = excluded.position_ms,
        updated_at_ms = excluded.updated_at_ms
    `);
    this.updatePosition = db.prepare('UPDATE playback_session SET position_ms = ?, updated_at_ms = ? WHERE id = 1');
    this.remove = db.prepare('DELETE FROM playback_session WHERE id = 1');
  }

  load(): PersistedPlaybackSession | undefined {
    const row = this.select.get() as SessionRow | undefined;
    if (row === undefined) return undefined;

    const tracks = parseIdList(row.queue_json, 'queue');
    const unshuffledTracks = row.unshuffled_json === null ? undefined : parseIdList(row.unshuffled_json, 'pre-shuffle queue');
    if (!REPEAT_MODES.includes(row.repeat_mode)) throw new PlaybackSessionCorruptError('The saved repeat mode is not valid.');
    const currentIndex = row.current_index ?? undefined;
    if (currentIndex !== undefined && currentIndex >= tracks.length) {
      throw new PlaybackSessionCorruptError('The saved current track is outside the saved queue.');
    }
    if (unshuffledTracks !== undefined && unshuffledTracks.length !== tracks.length) {
      throw new PlaybackSessionCorruptError('The saved pre-shuffle queue does not match the saved queue.');
    }
    const queue: QueueState = { tracks, currentIndex, repeatMode: row.repeat_mode as RepeatMode, unshuffledTracks };
    // The column's CHECK only says "not negative". A position that is not a whole, safe number is damage to a
    // value that is merely a convenience (where in the track to resume), so it must not cost the whole queue.
    const position = Number.isSafeInteger(row.position_ms) && row.position_ms >= 0 ? row.position_ms : 0;
    return { queue, positionMs: currentIndex === undefined ? 0 : position };
  }

  save(session: PersistedPlaybackSession): void {
    const { queue, positionMs } = session;
    assertPosition(positionMs);
    this.upsert.run({
      queue_json: JSON.stringify(queue.tracks),
      unshuffled_json: queue.unshuffledTracks === undefined ? null : JSON.stringify(queue.unshuffledTracks),
      current_index: queue.currentIndex ?? null,
      repeat_mode: queue.repeatMode,
      position_ms: queue.currentIndex === undefined ? 0 : positionMs,
      updated_at_ms: this.now(),
    });
  }

  savePosition(positionMs: number): void {
    assertPosition(positionMs);
    this.updatePosition.run(positionMs, this.now());
  }

  clear(): void {
    this.remove.run();
  }
}

function assertPosition(positionMs: number): void {
  if (!Number.isSafeInteger(positionMs) || positionMs < 0) {
    throw new RangeError('A playback position must be a non-negative whole number of milliseconds.');
  }
}
