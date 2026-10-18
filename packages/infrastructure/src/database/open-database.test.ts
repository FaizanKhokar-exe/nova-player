import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationError, type Migration } from './migration-runner.js';
import { MIGRATIONS } from './migrations.js';
import { IN_MEMORY_DATABASE, openDatabase } from './open-database.js';
import { makeTempDir, removeDir } from './test-helpers.js';

let dir: string;
beforeEach(() => {
  dir = makeTempDir();
});
afterEach(() => {
  removeDir(dir);
});

describe('openDatabase', () => {
  it('creates the database file (and missing parent folders) and migrates it', () => {
    const filePath = path.join(dir, 'nested', 'deeper', 'nova.db');
    const db = openDatabase({ filePath });
    try {
      expect(fs.existsSync(filePath)).toBe(true);
      expect(db.isOpen).toBe(true);
      expect(db.filePath).toBe(filePath);
      expect(db.getSchemaVersion()).toBe(MIGRATIONS.length);
    } finally {
      db.close();
    }
  });

  it('supports an in-memory database', () => {
    const db = openDatabase({ filePath: IN_MEMORY_DATABASE });
    expect(db.getSchemaVersion()).toBe(MIGRATIONS.length);
    db.close();
  });

  it('enables foreign key enforcement, and WAL for file databases', () => {
    const db = openDatabase({ filePath: path.join(dir, 'nova.db') });
    try {
      expect(db.connection.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(db.connection.pragma('journal_mode', { simple: true })).toBe('wal');
    } finally {
      db.close();
    }
  });

  it('can be opened repeatedly against the same file without re-running migrations', () => {
    const filePath = path.join(dir, 'nova.db');
    const first = openDatabase({ filePath });
    const appliedAt = first.connection.prepare('SELECT applied_at FROM schema_migrations').all();
    first.close();

    const second = openDatabase({ filePath });
    try {
      expect(second.getSchemaVersion()).toBe(MIGRATIONS.length);
      expect(second.connection.prepare('SELECT applied_at FROM schema_migrations').all()).toEqual(appliedAt);
    } finally {
      second.close();
    }
  });

  it('persists data written through the foundation across close/reopen', () => {
    const filePath = path.join(dir, 'nova.db');
    const first = openDatabase({ filePath });
    first.connection.exec('CREATE TABLE scratch (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    first.connection.prepare('INSERT INTO scratch (k, v) VALUES (?, ?)').run('hello', 'world');
    first.close();

    const second = openDatabase({ filePath });
    try {
      expect(second.connection.prepare('SELECT v FROM scratch WHERE k = ?').get('hello')).toEqual({ v: 'world' });
    } finally {
      second.close();
    }
  });

  describe('close', () => {
    it('closes the connection and is idempotent', () => {
      const db = openDatabase({ filePath: path.join(dir, 'nova.db') });
      db.close();
      expect(db.isOpen).toBe(false);
      expect(() => db.close()).not.toThrow();
      expect(() => db.connection.prepare('SELECT 1')).toThrow();
    });

    it('checkpoints and removes the WAL side files, leaving one self-contained file', () => {
      const filePath = path.join(dir, 'nova.db');
      const db = openDatabase({ filePath });
      db.connection.exec('CREATE TABLE t (x INTEGER)');
      db.connection.exec('INSERT INTO t VALUES (1)');
      db.close();
      expect(fs.existsSync(`${filePath}-wal`)).toBe(false);
      expect(fs.existsSync(`${filePath}-shm`)).toBe(false);
    });

    it('releases the file so it can be deleted immediately after close', () => {
      const filePath = path.join(dir, 'nova.db');
      openDatabase({ filePath }).close();
      expect(() => fs.rmSync(filePath)).not.toThrow();
    });
  });

  describe('failed opens do not leak a connection or half-migrate', () => {
    it('propagates a migration failure and leaves the file at the last good version', () => {
      const filePath = path.join(dir, 'nova.db');
      const failing: Migration = {
        version: MIGRATIONS.length + 1,
        name: 'explodes',
        up: () => {
          throw new Error('nope');
        },
      };
      expect(() => openDatabase({ filePath, migrations: [...MIGRATIONS, failing] })).toThrow(MigrationError);

      // The file is not locked (connection closed) and still at v1.
      const check = new Database(filePath, { readonly: true });
      try {
        expect(check.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()).toEqual({ v: MIGRATIONS.length });
      } finally {
        check.close();
      }
    });

    it('rejects a file that is not a SQLite database', () => {
      const filePath = path.join(dir, 'garbage.db');
      fs.writeFileSync(filePath, 'this is definitely not a sqlite database file'.repeat(50));
      expect(() => openDatabase({ filePath })).toThrow();
      expect(() => fs.rmSync(filePath)).not.toThrow(); // handle was released
    });
  });
});
