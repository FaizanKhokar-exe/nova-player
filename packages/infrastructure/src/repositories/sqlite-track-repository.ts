import type Database from 'better-sqlite3';
import {
  parseTrackId,
  TrackRepositoryError,
  type DeduplicationKey,
  type Track,
  type TrackFileState,
  type TrackId,
  type TrackRecord,
  type TrackRepository,
} from '@nova/domain';
import type { NovaDatabase } from '../database/index.js';
import { pathComparisonKey } from '../filesystem/index.js';
import { rowToTrack, trackToRowParams, TRACK_COLUMNS, type PathKeyFunction, type TrackRow } from './track-row-mapping.js';

/** A stored row that can no longer be turned into a `Track`, and why. Never carries a path. */
export interface UnreadableTrackRow {
  readonly id: string;
  readonly reason: string;
}

export interface SqliteTrackRepositoryOptions {
  /** Computes the unique path comparison key stored with every track.
   *  Defaults to the filesystem layer's `pathComparisonKey` for this platform. */
  readonly pathKey?: PathKeyFunction;
}

const COLUMN_LIST = TRACK_COLUMNS.join(', ');
const NAMED_PARAMS = TRACK_COLUMNS.map((column) => `@${column}`).join(', ');
// `id` is the identity and is never rewritten by an update.
const UPDATE_ASSIGNMENTS = TRACK_COLUMNS.filter((column) => column !== 'id')
  .map((column) => `${column} = @${column}`)
  .join(', ');

interface SqliteErrorLike {
  readonly code: string;
  readonly message: string;
}

function isSqliteConstraintError(error: unknown): error is Error & SqliteErrorLike {
  if (!(error instanceof Error)) return false;
  const { code } = error as Error & { code?: unknown };
  return typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT');
}

/** Translates a SQLite constraint failure into the domain's error codes.
 *  Anything that is not a constraint failure (I/O error, closed database,
 *  ...) is a real fault and is rethrown untouched. */
function translateWriteError(error: unknown): never {
  if (!isSqliteConstraintError(error)) throw error;

  if (error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
    throw new TrackRepositoryError('duplicate-track-id', 'A track with this id already exists.', { cause: error });
  }
  if (error.code === 'SQLITE_CONSTRAINT_UNIQUE' && error.message.includes('tracks.source_path_key')) {
    throw new TrackRepositoryError('duplicate-source-path', 'A track with this source path already exists.', {
      cause: error,
    });
  }
  throw new TrackRepositoryError('constraint-violation', `The library rejected this track: ${error.message}`, {
    cause: error,
  });
}

/**
 * The SQLite implementation of the domain's `TrackRepository` port.
 *
 * It is handed an already-open `NovaDatabase` (Phase 2A) and never opens,
 * owns or closes a connection - the caller that opened the database closes
 * it. All statements are prepared once, here, so a schema that doesn't match
 * fails immediately at construction rather than on first use.
 */
export class SqliteTrackRepository implements TrackRepository {
  private readonly connection: Database.Database;
  private readonly pathKey: PathKeyFunction;
  private readonly selectFileStates: Database.Statement<[]>;
  private readonly selectById: Database.Statement<[string]>;
  private readonly selectAll: Database.Statement<[]>;
  private readonly selectByDedupKey: Database.Statement<[string]>;
  private readonly insertTrack: Database.Statement;
  private readonly updateTrack: Database.Statement;
  private readonly deleteTrack: Database.Statement<[string]>;

  constructor(database: NovaDatabase, options: SqliteTrackRepositoryOptions = {}) {
    const db = database.connection;
    this.connection = db;
    this.pathKey = options.pathKey ?? ((sourcePath) => pathComparisonKey(sourcePath));
    this.selectFileStates = db.prepare('SELECT id, source_path, size_bytes, modified_at_ms FROM tracks');
    this.selectById = db.prepare(`SELECT ${COLUMN_LIST} FROM tracks WHERE id = ?`);
    this.selectAll = db.prepare(`SELECT ${COLUMN_LIST} FROM tracks`);
    this.selectByDedupKey = db.prepare(`SELECT ${COLUMN_LIST} FROM tracks WHERE dedup_key = ?`);
    this.insertTrack = db.prepare(`INSERT INTO tracks (${COLUMN_LIST}) VALUES (${NAMED_PARAMS})`);
    this.updateTrack = db.prepare(`UPDATE tracks SET ${UPDATE_ASSIGNMENTS} WHERE id = @id`);
    this.deleteTrack = db.prepare('DELETE FROM tracks WHERE id = ?');
  }

  getById(id: TrackId): Track | undefined {
    const row = this.selectById.get(id) as TrackRow | undefined;
    return row === undefined ? undefined : rowToTrack(row);
  }

  list(): readonly Track[] {
    return (this.selectAll.all() as TrackRow[]).map(rowToTrack);
  }

  insert(record: TrackRecord): void {
    try {
      this.insertTrack.run(trackToRowParams(record, this.pathKey));
    } catch (error) {
      translateWriteError(error);
    }
  }

  update(record: TrackRecord): void {
    let changes: number;
    try {
      changes = this.updateTrack.run(trackToRowParams(record, this.pathKey)).changes;
    } catch (error) {
      translateWriteError(error);
    }
    if (changes === 0) {
      throw new TrackRepositoryError('track-not-found', `No track with id "${record.track.id}" to update.`);
    }
  }

  delete(id: TrackId): boolean {
    return this.deleteTrack.run(id).changes > 0;
  }

  findByDeduplicationKey(key: DeduplicationKey): readonly Track[] {
    return (this.selectByDedupKey.all(key) as TrackRow[]).map(rowToTrack);
  }

  listFileStates(): readonly TrackFileState[] {
    const rows = this.selectFileStates.all() as { id: string; source_path: string; size_bytes: number; modified_at_ms: number }[];
    return rows.map((row) => {
      const id = parseTrackId(row.id);
      if (id === undefined) {
        throw new TrackRepositoryError('corrupt-record', `Stored track "${row.id}" is unreadable: id is not a valid TrackId.`);
      }
      return { id, sourcePath: row.source_path, sizeBytes: row.size_bytes, modifiedAtMs: row.modified_at_ms };
    });
  }

  /**
   * Phase 8 recovery. Every other read (`list`, `getById`, ...) stays strict - a row the app cannot read is a
   * loud `corrupt-record`, never a silently wrong track - but one such row used to make `list()` and
   * `listFileStates()` throw on every launch, so the track list, every scan and the queue restore all failed
   * until the file was edited by hand. A `tracks` row is only a CACHE of what is in an audio file (the file is
   * never touched and the next reconciliation scan reads it again, under a valid id), so a row that cannot be
   * read is removed and REPORTED (id and reason; the caller logs it), and every readable row keeps its
   * identity. All-or-nothing: one transaction deletes every unreadable row, and if it fails nothing is deleted.
   */
  removeUnreadableRecords(): readonly UnreadableTrackRow[] {
    const unreadable: UnreadableTrackRow[] = [];
    for (const row of this.selectAll.all() as TrackRow[]) {
      try {
        rowToTrack(row);
      } catch (error) {
        if (!(error instanceof TrackRepositoryError) || error.code !== 'corrupt-record') throw error;
        const marker = 'is unreadable: ';
        const at = error.message.indexOf(marker);
        unreadable.push({ id: String(row.id), reason: at < 0 ? error.message : error.message.slice(at + marker.length) });
      }
    }
    if (unreadable.length > 0) {
      this.runInTransaction(() => {
        for (const row of unreadable) this.deleteTrack.run(row.id);
      });
    }
    return unreadable;
  }

  runInTransaction<T>(work: () => T): T {
    // better-sqlite3 turns a nested call into a SAVEPOINT, which is what
    // gives the port its "a nested failure undoes only itself" guarantee.
    return this.connection.transaction(work).immediate();
  }
}
