import type { Migration } from './migration-runner.js';

/**
 * Migration 3: the folders the user has added to the library (Phase 3).
 *
 *  - `id`: an opaque UUID, not derived from the path.
 *  - `path`: the canonical path as chosen (display case preserved).
 *  - `path_key`: the path COMPARISON key (see filesystem/path-policy.ts),
 *    UNIQUE, so `C:\Music` and `c:\music\` are one root on Windows. Written
 *    by the repository, never by callers - the same rule as
 *    `tracks.source_path_key`.
 *  - `added_at_ms`: only so roots list in a stable, meaningful order.
 *
 * No foreign key to `tracks`: tracks belong to a root by lying inside its
 * folder (a path relationship), not by a stored link, and a root can be
 * registered before any of its tracks exist.
 */
export const libraryRootsMigration: Migration = {
  version: 3,
  name: 'library-roots',
  up: (db) => {
    db.exec(`
      CREATE TABLE library_roots (
        id           TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
        path         TEXT NOT NULL CHECK (length(path) > 0),
        path_key     TEXT NOT NULL UNIQUE CHECK (length(path_key) > 0),
        added_at_ms  INTEGER NOT NULL CHECK (added_at_ms >= 0)
      ) STRICT;
    `);
  },
};
