import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import type BetterSqlite3 from 'better-sqlite3';
import { launchApp } from './helpers.js';

// better-sqlite3 is a dependency of the infrastructure package, not of the
// repo root, so resolve it from there (the test process runs plain Node, for
// which the prebuilt binary also loads).
const infrastructureRequire = createRequire(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../packages/infrastructure/package.json'),
);
const Database = infrastructureRequire('better-sqlite3') as typeof BetterSqlite3;

/**
 * Phase 2G: the Electron main process opens the library database under the
 * per-user app-data folder at startup and closes it in an orderly way on quit.
 */
test('the library database is created under userData at startup and closed cleanly on quit', async () => {
  const userData = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nova-e2e-userdata-')));
  try {
    const { app } = await launchApp({ userDataDir: userData });
    let mainOutput = '';
    app.process().stdout?.on('data', (chunk: Buffer) => {
      mainOutput += chunk.toString();
    });

    const reportedUserData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
    expect(fs.realpathSync(reportedUserData)).toBe(userData);

    const dbFile = path.join(userData, 'library', 'nova.db');
    await expect.poll(() => fs.existsSync(dbFile), { timeout: 10_000 }).toBe(true);

    await app.close();

    // The main process ran its orderly shutdown (stop watchers, abort scans,
    // close the database) rather than just being torn down.
    expect(mainOutput).toContain('[nova] library closed cleanly');

    // A clean shutdown closes the database: SQLite then removes its WAL side files.
    const leftovers = fs.readdirSync(path.dirname(dbFile)).sort();
    expect(leftovers).toEqual(['nova.db']);

    // And the file is a fully migrated, valid database.
    const db = new Database(dbFile, { readonly: true });
    try {
      expect(db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()).toEqual({ v: 6 }); // migration 6 (collections) is the latest
      expect(db.prepare('SELECT COUNT(*) AS n FROM tracks').get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('a second launch reopens the same library database (no re-creation)', async () => {
  const userData = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nova-e2e-userdata-')));
  try {
    const dbFile = path.join(userData, 'library', 'nova.db');
    const first = await launchApp({ userDataDir: userData });
    await expect.poll(() => fs.existsSync(dbFile), { timeout: 10_000 }).toBe(true);
    await first.app.close();

    const before = new Database(dbFile, { readonly: true });
    const appliedAt = before.prepare('SELECT applied_at FROM schema_migrations WHERE version = 2').get();
    before.close();
    expect(appliedAt).toBeDefined();

    const second = await launchApp({ userDataDir: userData });
    await second.window.waitForLoadState('domcontentloaded');
    await second.app.close();

    const after = new Database(dbFile, { readonly: true });
    try {
      expect(after.prepare('SELECT applied_at FROM schema_migrations WHERE version = 2').get()).toEqual(appliedAt);
    } finally {
      after.close();
    }
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});
