import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations, type Migration } from './migration-runner.js';
import { MIGRATIONS } from './migrations.js';

/** Pass as `filePath` for a throwaway in-memory database (tests). */
export const IN_MEMORY_DATABASE = ':memory:';

export interface OpenDatabaseOptions {
  /** Absolute path of the database file, or `IN_MEMORY_DATABASE`. */
  readonly filePath: string;
  /** Override the migration list. Intended for tests only. */
  readonly migrations?: readonly Migration[];
}

/**
 * An open, fully migrated database. Created by `openDatabase` and passed
 * explicitly to whatever needs it (Phase 2B repositories receive one of
 * these) - there is no module-level/global instance, and the handle never
 * crosses the IPC boundary to the renderer.
 */
export interface NovaDatabase {
  /** The underlying better-sqlite3 connection. Infrastructure-internal. */
  readonly connection: Database.Database;
  readonly filePath: string;
  readonly isOpen: boolean;
  /** Highest migration version recorded in this database. */
  getSchemaVersion(): number;
  /** Closes the connection. Idempotent: closing twice is a no-op. */
  close(): void;
}

/**
 * Opens (creating if needed) the database, applies connection pragmas, and
 * brings the schema up to date. If anything fails, the connection is closed
 * before the error propagates, so a failed open never leaks a handle or
 * leaves the file locked.
 */
export function openDatabase(options: OpenDatabaseOptions): NovaDatabase {
  const { filePath } = options;
  const inMemory = filePath === IN_MEMORY_DATABASE;

  if (!inMemory) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  const connection = new Database(filePath);
  try {
    // Enforce FOREIGN KEY constraints (off by default in SQLite, per
    // connection). Verified rather than assumed.
    connection.pragma('foreign_keys = ON');
    if (connection.pragma('foreign_keys', { simple: true }) !== 1) {
      throw new Error('SQLite refused to enable foreign_keys enforcement.');
    }
    if (!inMemory) {
      // WAL: readers don't block the writer, and far fewer fsyncs. With WAL,
      // synchronous=NORMAL is the recommended durability/speed trade-off.
      connection.pragma('journal_mode = WAL');
      connection.pragma('synchronous = NORMAL');
    }

    runMigrations(connection, options.migrations ?? MIGRATIONS);
  } catch (error) {
    connection.close();
    throw error;
  }

  return {
    connection,
    filePath,
    get isOpen() {
      return connection.open;
    },
    getSchemaVersion() {
      const row = connection.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as {
        v: number | null;
      };
      return row.v ?? 0;
    },
    close() {
      if (connection.open) connection.close();
    },
  };
}
