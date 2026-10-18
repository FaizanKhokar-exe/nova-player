import Database from 'better-sqlite3';
import type { DatabaseDiagnosticsResponse } from '@nova/shared';

/**
 * Phase 0 diagnostic only.
 *
 * This does NOT implement the real catalog schema (that's Phase 1, per the
 * accepted data model in the architecture review). Its only job is to prove
 * that `better-sqlite3`'s prebuilt N-API binary actually loads and runs
 * inside the *Electron main process* - a distinct Node/V8 embedding from
 * plain Node - not just in a standalone Node script. Validating it in plain
 * Node (done during the technology spike) is necessary but not sufficient;
 * this function is what the Electron smoke test calls at runtime.
 */
export function runDatabaseDiagnostics(): DatabaseDiagnosticsResponse {
  const rowCount = 5_000;

  try {
    const db = new Database(':memory:');
    const sqliteVersion = db.prepare('select sqlite_version() as v').get() as { v: string };

    db.exec('CREATE TABLE diagnostic_rows (id TEXT PRIMARY KEY, title TEXT NOT NULL)');
    const insert = db.prepare('INSERT INTO diagnostic_rows (id, title) VALUES (?, ?)');
    const insertMany = db.transaction((n: number) => {
      for (let i = 0; i < n; i += 1) {
        insert.run(`id-${i}`, `Diagnostic Row ${i}`);
      }
    });

    const startedAt = performance.now();
    insertMany(rowCount);
    const insertDurationMs = performance.now() - startedAt;

    const { count } = db.prepare('SELECT COUNT(*) as count FROM diagnostic_rows').get() as {
      count: number;
    };

    db.close();

    return {
      ok: count === rowCount,
      driver: 'better-sqlite3',
      sqliteVersion: sqliteVersion.v,
      rowCountAfterInsert: count,
      insertDurationMs,
    };
  } catch (error) {
    return {
      ok: false,
      driver: 'better-sqlite3',
      sqliteVersion: 'unknown',
      rowCountAfterInsert: 0,
      insertDurationMs: 0,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
  }
}
