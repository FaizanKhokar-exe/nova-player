import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from './migrations.js';
import { makeTempDir, removeDir } from './test-helpers.js';

/**
 * Validates the SQLite foundation under ELECTRON'S Node/V8 (a different ABI
 * from the plain Node running Vitest), using the prebuilt better-sqlite3
 * binary exactly as installed (no rebuild, `allowBuilds` policy untouched).
 *
 * Electron's binary can run as plain Node via ELECTRON_RUN_AS_NODE=1, which
 * needs no display. The database sources are transpiled to a scratch folder
 * INSIDE this package (so `better-sqlite3` resolves from the real
 * node_modules) and executed by the Electron binary. Skipped, with a stated
 * reason, only when the Electron binary hasn't been downloaded
 * (`pnpm exec install-electron`).
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '../..');

function findElectronBinary(): string | undefined {
  try {
    const binary = createRequire(import.meta.url)('electron') as unknown;
    return typeof binary === 'string' && fs.existsSync(binary) ? binary : undefined;
  } catch {
    return undefined; // electron package present but binary not downloaded
  }
}

const electronBinary = findElectronBinary();
const SOURCES = ['migration-runner', 'initial-schema', 'scan-state-schema', 'library-roots-schema', 'playback-session-schema', 'attached-lyrics-schema', 'collections-schema', 'custom-media-schema', 'migrations', 'open-database'];

const RUNNER = `
import { openDatabase } from './open-database.js';
import path from 'node:path';
const file = path.join(process.argv[2], 'electron.db');
const db = openDatabase({ filePath: file });
db.connection.prepare(
  "INSERT INTO tracks (id, source_path, source_path_key, title, title_source, artist, artist_source, artwork_kind, size_bytes, dedup_key) VALUES (?,?,?,?,?,?,?,?,?,?)"
).run('123e4567-e89b-42d3-a456-426614174000', 'C:\\\\a.mp3', 'c:\\\\a.mp3', 'T', 'tag', 'A', 'tag', 'none', 1, 'k');
const count = db.connection.prepare('SELECT COUNT(*) AS n FROM tracks').get().n;
const version = db.getSchemaVersion();
const sqlite = db.connection.prepare('select sqlite_version() as v').get().v;
db.close();
const reopened = openDatabase({ filePath: file });
const persisted = reopened.connection.prepare('SELECT COUNT(*) AS n FROM tracks').get().n;
reopened.close();
console.log(JSON.stringify({ electron: process.versions.electron, abi: process.versions.modules, sqlite, count, version, persisted }));
`;

describe.skipIf(electronBinary === undefined)('SQLite foundation inside the Electron runtime', () => {
  it('opens, migrates, writes, closes and reopens using the prebuilt better-sqlite3', () => {
    const scratch = fs.mkdtempSync(path.join(packageRoot, '.electron-check-'));
    const dataDir = makeTempDir();
    try {
      fs.writeFileSync(path.join(scratch, 'package.json'), '{"type":"module"}');
      for (const name of SOURCES) {
        const source = fs.readFileSync(path.join(here, `${name}.ts`), 'utf8');
        const { outputText } = ts.transpileModule(source, {
          compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023, esModuleInterop: true },
        });
        fs.writeFileSync(path.join(scratch, `${name}.js`), outputText);
      }
      fs.writeFileSync(path.join(scratch, 'run.js'), RUNNER);

      const result = spawnSync(electronBinary as string, [path.join(scratch, 'run.js'), dataDir], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        encoding: 'utf8',
        timeout: 60_000,
      });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);

      const report = JSON.parse(result.stdout.trim().split('\n').pop() as string) as Record<string, unknown>;
      expect(typeof report.electron).toBe('string'); // really ran under Electron
      expect(report.abi).not.toBe(process.versions.modules); // ...a different ABI than Vitest's Node
      expect(report.count).toBe(1);
      expect(report.version).toBe(MIGRATIONS.length);
      expect(report.persisted).toBe(1);
    } finally {
      removeDir(scratch);
      removeDir(dataDir);
    }
    // The child process has its own 60 s limit; Vitest's default 5 s test
    // limit is too short when the whole suite is running in parallel.
  }, 60_000);
});
