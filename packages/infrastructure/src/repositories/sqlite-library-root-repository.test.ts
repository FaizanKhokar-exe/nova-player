import path from 'node:path';
import { LibraryRootRepositoryError, type LibraryRoot } from '@nova/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IN_MEMORY_DATABASE, MIGRATIONS, openDatabase, type NovaDatabase } from '../database/index.js';
import { makeTempDir, removeDir } from '../database/test-helpers.js';
import { SqliteLibraryRootRepository } from './sqlite-library-root-repository.js';

const exact = { pathKey: (p: string): string => p };
const ID_A = '123e4567-e89b-42d3-a456-426614174000';
const ID_B = '223e4567-e89b-42d3-a456-426614174000';
const root = (id: string, p: string, addedAtMs = 1000): LibraryRoot => ({ id, path: p, addedAtMs });

let db: NovaDatabase;
let repo: SqliteLibraryRootRepository;
beforeEach(() => {
  db = openDatabase({ filePath: IN_MEMORY_DATABASE });
  repo = new SqliteLibraryRootRepository(db, exact);
});
afterEach(() => db.close());

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(LibraryRootRepositoryError);
    return (error as LibraryRootRepositoryError).code;
  }
  throw new Error('expected LibraryRootRepositoryError');
}

describe('SqliteLibraryRootRepository', () => {
  it('migration 3 is applied', () => {
    expect(db.getSchemaVersion()).toBe(MIGRATIONS.length);
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(3);
  });

  it('starts empty; stores and returns a root', () => {
    expect(repo.list()).toEqual([]);
    repo.insert(root(ID_A, '/music', 5));
    expect(repo.getById(ID_A)).toEqual({ id: ID_A, path: '/music', addedAtMs: 5 });
    expect(repo.getById(ID_B)).toBeUndefined();
  });

  it('lists oldest first, then by id, regardless of insertion order', () => {
    repo.insert(root(ID_B, '/b', 10));
    repo.insert(root(ID_A, '/a', 10));
    repo.insert(root('323e4567-e89b-42d3-a456-426614174000', '/c', 1));
    expect(repo.list().map((r) => r.path)).toEqual(['/c', '/a', '/b']);
  });

  it('deletes a root and reports whether one was removed', () => {
    repo.insert(root(ID_A, '/a'));
    expect(repo.delete(ID_A)).toBe(true);
    expect(repo.delete(ID_A)).toBe(false);
    expect(repo.list()).toEqual([]);
  });

  it('rejects a duplicate id and a duplicate path (by key), storing nothing extra', () => {
    repo.insert(root(ID_A, '/a'));
    expect(code(() => repo.insert(root(ID_A, '/other')))).toBe('duplicate-root-id');
    expect(code(() => repo.insert(root(ID_B, '/a')))).toBe('duplicate-root-path');
    expect(repo.list()).toHaveLength(1);
  });

  it('uses the injected path key: differently spelled paths with the same key collide', () => {
    const folding = new SqliteLibraryRootRepository(db, { pathKey: (p) => p.toLowerCase().replace(/\/$/, '') });
    folding.insert(root(ID_A, '/Music'));
    expect(code(() => folding.insert(root(ID_B, '/music/')))).toBe('duplicate-root-path');
  });

  it('defaults to the real path policy and rejects a path it cannot canonicalise', () => {
    const real = new SqliteLibraryRootRepository(db);
    expect(() => real.insert(root(ID_A, 'relative/path'))).toThrow(/Invalid path/);
  });

  it('surfaces schema constraint failures as constraint-violation', () => {
    expect(code(() => repo.insert(root('short-id', '/a')))).toBe('constraint-violation');
    expect(code(() => repo.insert(root(ID_A, '')))).toBe('constraint-violation');
    expect(code(() => repo.insert(root(ID_A, '/a', -1)))).toBe('constraint-violation');
  });

  it('persists across closing and reopening the database file', () => {
    const dir = makeTempDir();
    try {
      const file = path.join(dir, 'nova.db');
      const first = openDatabase({ filePath: file });
      new SqliteLibraryRootRepository(first, exact).insert(root(ID_A, '/persisted', 42));
      first.close();
      const second = openDatabase({ filePath: file });
      try {
        expect(new SqliteLibraryRootRepository(second, exact).list()).toEqual([{ id: ID_A, path: '/persisted', addedAtMs: 42 }]);
      } finally {
        second.close();
      }
    } finally {
      removeDir(dir);
    }
  });
});
