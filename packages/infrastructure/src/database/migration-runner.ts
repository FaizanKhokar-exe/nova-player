import type Database from 'better-sqlite3';

/**
 * A single, forward-only schema migration.
 *
 * `up` receives the connection while a `BEGIN IMMEDIATE` transaction is
 * already open, so it must NOT start/commit its own transaction. SQLite DDL
 * is transactional, so a throw anywhere inside `up` rolls the whole
 * migration back - nothing partial is left behind and nothing is recorded.
 */
export interface Migration {
  /** Positive integer; the list must be 1, 2, 3, ... with no gaps. */
  readonly version: number;
  /** Short human-readable label, stored alongside the version. */
  readonly name: string;
  readonly up: (db: Database.Database) => void;
}

export type MigrationErrorCode =
  | 'invalid-migration-list'
  | 'unknown-applied-migration'
  | 'applied-migration-mismatch'
  | 'migration-failed';

export class MigrationError extends Error {
  readonly code: MigrationErrorCode;
  readonly version: number | undefined;

  constructor(
    code: MigrationErrorCode,
    message: string,
    options?: { readonly version?: number; readonly cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'MigrationError';
    this.code = code;
    this.version = options?.version;
  }
}

export interface MigrationResult {
  /** Versions applied by THIS call, in order. Empty when already up to date. */
  readonly applied: readonly number[];
  /** Highest applied version after this call (0 if the list is empty). */
  readonly currentVersion: number;
}

const MIGRATIONS_TABLE = 'schema_migrations';

function validateMigrationList(migrations: readonly Migration[]): void {
  const names = new Set<string>();
  migrations.forEach((migration, index) => {
    const expected = index + 1;
    if (!Number.isInteger(migration.version) || migration.version !== expected) {
      throw new MigrationError(
        'invalid-migration-list',
        `Migration at position ${index} has version ${String(migration.version)}; expected ${expected} (versions must be contiguous from 1).`,
      );
    }
    if (migration.name.trim().length === 0 || names.has(migration.name)) {
      throw new MigrationError(
        'invalid-migration-list',
        `Migration ${migration.version} needs a unique, non-empty name.`,
      );
    }
    names.add(migration.name);
  });
}

/**
 * Applies every pending migration, in order, each in its own IMMEDIATE
 * transaction together with its version-tracking row. Safe to call
 * repeatedly: an up-to-date database is left untouched.
 *
 * Refuses to run (rather than guessing) when the database's recorded history
 * doesn't match the code - e.g. it was written by a NEWER app version, or a
 * recorded migration's name differs. Silently "upgrading" such a database
 * could corrupt a user's library.
 */
export function runMigrations(
  db: Database.Database,
  migrations: readonly Migration[],
  now: () => Date = () => new Date(),
): MigrationResult {
  validateMigrationList(migrations);

  db.exec(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      version    INTEGER PRIMARY KEY NOT NULL,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT
  `);

  const recorded = db
    .prepare(`SELECT version, name FROM ${MIGRATIONS_TABLE} ORDER BY version`)
    .all() as { version: number; name: string }[];

  recorded.forEach((row, index) => {
    const known = migrations[index];
    if (known === undefined || row.version !== known.version) {
      throw new MigrationError(
        'unknown-applied-migration',
        `Database records migration ${row.version} ("${row.name}") which this app version does not know about. The database was probably written by a newer version of Nova Player.`,
        { version: row.version },
      );
    }
    if (row.name !== known.name) {
      throw new MigrationError(
        'applied-migration-mismatch',
        `Recorded migration ${row.version} is named "${row.name}" but this app version expects "${known.name}".`,
        { version: row.version },
      );
    }
  });

  const insertRecord = db.prepare(
    `INSERT INTO ${MIGRATIONS_TABLE} (version, name, applied_at) VALUES (?, ?, ?)`,
  );
  const applied: number[] = [];

  for (const migration of migrations.slice(recorded.length)) {
    const applyOne = db.transaction(() => {
      migration.up(db);
      insertRecord.run(migration.version, migration.name, now().toISOString());
    });
    try {
      applyOne.immediate();
    } catch (error) {
      throw new MigrationError(
        'migration-failed',
        `Migration ${migration.version} ("${migration.name}") failed and was rolled back: ${error instanceof Error ? error.message : String(error)}`,
        { version: migration.version, cause: error },
      );
    }
    applied.push(migration.version);
  }

  return { applied, currentVersion: migrations.length };
}
