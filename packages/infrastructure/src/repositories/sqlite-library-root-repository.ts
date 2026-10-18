import type Database from 'better-sqlite3';
import { LibraryRootRepositoryError, type LibraryRoot, type LibraryRootRepository } from '@nova/domain';
import type { NovaDatabase } from '../database/index.js';
import { pathComparisonKey } from '../filesystem/index.js';
import type { PathKeyFunction } from './track-row-mapping.js';

export interface SqliteLibraryRootRepositoryOptions {
  /** Computes the unique path key stored with every root. Defaults to the
   *  filesystem layer's `pathComparisonKey` for this platform. */
  readonly pathKey?: PathKeyFunction;
}

interface RootRow {
  readonly id: string;
  readonly path: string;
  readonly added_at_ms: number;
}

function translateWriteError(error: unknown): never {
  const code = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;
  if (typeof code !== 'string' || !code.startsWith('SQLITE_CONSTRAINT')) throw error;
  const message = (error as Error).message;
  if (code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
    throw new LibraryRootRepositoryError('duplicate-root-id', 'A library root with this id already exists.', { cause: error });
  }
  if (code === 'SQLITE_CONSTRAINT_UNIQUE' && message.includes('library_roots.path_key')) {
    throw new LibraryRootRepositoryError('duplicate-root-path', 'This folder is already a library root.', { cause: error });
  }
  throw new LibraryRootRepositoryError('constraint-violation', `The library rejected this root: ${message}`, { cause: error });
}

/** SQLite implementation of the domain's `LibraryRootRepository` port. Takes
 *  an already-open `NovaDatabase`; never opens or closes a connection. */
export class SqliteLibraryRootRepository implements LibraryRootRepository {
  private readonly pathKey: PathKeyFunction;
  private readonly selectAll: Database.Statement<[]>;
  private readonly selectById: Database.Statement<[string]>;
  private readonly insertRoot: Database.Statement;
  private readonly deleteRoot: Database.Statement<[string]>;

  constructor(database: NovaDatabase, options: SqliteLibraryRootRepositoryOptions = {}) {
    const db = database.connection;
    this.pathKey = options.pathKey ?? ((path) => pathComparisonKey(path));
    this.selectAll = db.prepare('SELECT id, path, added_at_ms FROM library_roots ORDER BY added_at_ms, id');
    this.selectById = db.prepare('SELECT id, path, added_at_ms FROM library_roots WHERE id = ?');
    this.insertRoot = db.prepare(
      'INSERT INTO library_roots (id, path, path_key, added_at_ms) VALUES (@id, @path, @path_key, @added_at_ms)',
    );
    this.deleteRoot = db.prepare('DELETE FROM library_roots WHERE id = ?');
  }

  list(): readonly LibraryRoot[] {
    return (this.selectAll.all() as RootRow[]).map(toRoot);
  }

  getById(id: string): LibraryRoot | undefined {
    const row = this.selectById.get(id) as RootRow | undefined;
    return row === undefined ? undefined : toRoot(row);
  }

  insert(root: LibraryRoot): void {
    try {
      this.insertRoot.run({ id: root.id, path: root.path, path_key: this.pathKey(root.path), added_at_ms: root.addedAtMs });
    } catch (error) {
      translateWriteError(error);
    }
  }

  delete(id: string): boolean {
    return this.deleteRoot.run(id).changes > 0;
  }
}

function toRoot(row: RootRow): LibraryRoot {
  if (row.id.length === 0 || row.path.length === 0) {
    throw new LibraryRootRepositoryError('corrupt-record', `Stored library root "${row.id}" is unreadable.`);
  }
  return { id: row.id, path: row.path, addedAtMs: row.added_at_ms };
}
