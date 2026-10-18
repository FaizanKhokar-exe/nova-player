import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationError, runMigrations, type Migration } from './migration-runner.js';

const createA: Migration = {
  version: 1,
  name: 'create-a',
  up: (db) => db.exec('CREATE TABLE a (id INTEGER PRIMARY KEY)'),
};
const createB: Migration = {
  version: 2,
  name: 'create-b',
  up: (db) => db.exec('CREATE TABLE b (id INTEGER PRIMARY KEY)'),
};

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
});
afterEach(() => {
  if (db.open) db.close();
});

function tableExists(name: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined
  );
}
function recordedVersions(): number[] {
  return (db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as { version: number }[]).map(
    (r) => r.version,
  );
}

describe('runMigrations', () => {
  it('applies pending migrations in order and records each version', () => {
    const result = runMigrations(db, [createA, createB]);
    expect(result).toEqual({ applied: [1, 2], currentVersion: 2 });
    expect(tableExists('a')).toBe(true);
    expect(tableExists('b')).toBe(true);
    expect(recordedVersions()).toEqual([1, 2]);
  });

  it('stores name and an ISO timestamp for each applied migration', () => {
    runMigrations(db, [createA], () => new Date('2026-01-02T03:04:05.000Z'));
    expect(db.prepare('SELECT version, name, applied_at FROM schema_migrations').get()).toEqual({
      version: 1,
      name: 'create-a',
      applied_at: '2026-01-02T03:04:05.000Z',
    });
  });

  it('is a no-op when run again against an up-to-date database', () => {
    runMigrations(db, [createA, createB]);
    const second = runMigrations(db, [createA, createB]);
    expect(second).toEqual({ applied: [], currentVersion: 2 });
    expect(recordedVersions()).toEqual([1, 2]);
  });

  it('applies only the new migrations when the list has grown', () => {
    runMigrations(db, [createA]);
    const result = runMigrations(db, [createA, createB]);
    expect(result.applied).toEqual([2]);
    expect(recordedVersions()).toEqual([1, 2]);
  });

  it('works with an empty migration list', () => {
    expect(runMigrations(db, [])).toEqual({ applied: [], currentVersion: 0 });
  });

  describe('failure handling', () => {
    const failing: Migration = {
      version: 2,
      name: 'fails-midway',
      up: (d) => {
        d.exec('CREATE TABLE half_done (id INTEGER PRIMARY KEY)');
        throw new Error('boom');
      },
    };

    it('rolls back the failing migration completely and does not record it', () => {
      let caught: unknown;
      try {
        runMigrations(db, [createA, failing]);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(MigrationError);
      expect((caught as MigrationError).code).toBe('migration-failed');
      expect((caught as MigrationError).version).toBe(2);
      expect((caught as MigrationError).cause).toBeInstanceOf(Error);

      expect(tableExists('half_done')).toBe(false); // partial DDL rolled back
      expect(recordedVersions()).toEqual([1]); // failed one NOT marked complete
      expect(tableExists('a')).toBe(true); // earlier success is kept
    });

    it('rolls back on a SQL error too, and a fixed retry then succeeds', () => {
      const badSql: Migration = {
        version: 2,
        name: 'bad-sql',
        up: (d) => d.exec('CREATE TABLE ok_first (id INTEGER); THIS IS NOT SQL;'),
      };
      expect(() => runMigrations(db, [createA, badSql])).toThrow(MigrationError);
      expect(tableExists('ok_first')).toBe(false);

      const fixed: Migration = { version: 2, name: 'bad-sql', up: createB.up };
      expect(runMigrations(db, [createA, fixed]).applied).toEqual([2]);
      expect(recordedVersions()).toEqual([1, 2]);
    });

    it('leaves the connection usable (no dangling transaction) after a failure', () => {
      expect(() => runMigrations(db, [createA, failing])).toThrow(MigrationError);
      expect(db.inTransaction).toBe(false);
      db.exec('CREATE TABLE still_works (id INTEGER)');
    });
  });

  describe('history validation', () => {
    it('refuses a database written by a newer app version', () => {
      runMigrations(db, [createA, createB]);
      try {
        runMigrations(db, [createA]);
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(MigrationError);
        expect((error as MigrationError).code).toBe('unknown-applied-migration');
        expect((error as MigrationError).version).toBe(2);
      }
    });

    it('refuses when a recorded migration name differs from the code', () => {
      runMigrations(db, [createA]);
      try {
        runMigrations(db, [{ ...createA, name: 'renamed' }]);
        expect.unreachable('should have thrown');
      } catch (error) {
        expect((error as MigrationError).code).toBe('applied-migration-mismatch');
      }
    });

    it.each<[string, Migration[]]>([
      ['a gap in versions', [createA, { ...createB, version: 3 }]],
      ['not starting at 1', [{ ...createA, version: 2 }]],
      ['duplicate names', [createA, { ...createB, name: 'create-a' }]],
      ['an empty name', [{ ...createA, name: '  ' }]],
      ['a non-integer version', [{ ...createA, version: 1.5 }]],
    ])('rejects an invalid migration list: %s', (_label, list) => {
      try {
        runMigrations(db, list);
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(MigrationError);
        expect((error as MigrationError).code).toBe('invalid-migration-list');
      }
      expect(tableExists('a')).toBe(false); // validation happens before any change
    });
  });
});
