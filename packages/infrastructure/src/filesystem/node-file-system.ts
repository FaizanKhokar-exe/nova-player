import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { FileSystemError, toFileSystemError } from './file-system-error.js';
import type { DirectoryEntry, DirectoryEntryKind, FileKind, FileStats, FileSystem } from './file-system.js';
import { canonicalizePath, type CanonicalPath } from './path-policy.js';

// Only the callback form of realpath has a `.native` variant (the one that
// asks the OS for the true letter case and expands 8.3 short names).
const realpathNative = promisify(fs.realpath.native);

function kindOfStats(stats: { isFile(): boolean; isDirectory(): boolean }): FileKind {
  if (stats.isFile()) return 'file';
  if (stats.isDirectory()) return 'directory';
  return 'other';
}

function kindOfDirent(entry: { isSymbolicLink(): boolean; isFile(): boolean; isDirectory(): boolean }): DirectoryEntryKind {
  // A Dirent is exactly one type, so the order only matters for clarity.
  if (entry.isSymbolicLink()) return 'symlink';
  return kindOfStats(entry);
}

function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The real implementation, backed by `node:fs/promises` and the platform's
 *  own path rules. Stateless; create as many as you like. */
export function createNodeFileSystem(): FileSystem {
  async function stat(input: string): Promise<FileStats> {
    const canonical = canonicalizePath(input);
    try {
      // bigint stats give the exact nanosecond-derived millisecond (rounded
      // down by the OS layer) instead of a float that can be off by 1 ms.
      const stats = await fsPromises.stat(canonical, { bigint: true });
      return {
        path: canonical,
        kind: kindOfStats(stats),
        sizeBytes: Number(stats.size),
        modifiedAtMs: Number(stats.mtimeMs),
      };
    } catch (error) {
      throw toFileSystemError(error, canonical, 'stat');
    }
  }

  return {
    async exists(input) {
      try {
        await stat(input);
        return true;
      } catch (error) {
        if (error instanceof FileSystemError && error.code === 'not-found') return false;
        throw error;
      }
    },

    stat,

    async statFile(input) {
      const stats = await stat(input);
      if (stats.kind !== 'file') {
        throw new FileSystemError('not-a-file', `Not a regular file (it is a ${stats.kind}): ${stats.path}`, { path: stats.path });
      }
      return stats;
    },

    async readDirectory(input) {
      const canonical = canonicalizePath(input);
      try {
        const dirents = await fsPromises.readdir(canonical, { withFileTypes: true });
        const entries: DirectoryEntry[] = dirents.map((dirent) => ({
          name: dirent.name,
          // A real directory entry needs no re-normalising: `canonical` is
          // already canonical and `name` is a single real segment.
          path: path.join(canonical, dirent.name) as CanonicalPath,
          kind: kindOfDirent(dirent),
        }));
        return entries.sort((a, b) => compareNames(a.name, b.name));
      } catch (error) {
        throw toFileSystemError(error, canonical, 'readdir');
      }
    },

    async realPath(input) {
      const canonical = canonicalizePath(input);
      try {
        return canonicalizePath(await realpathNative(canonical));
      } catch (error) {
        throw toFileSystemError(error, canonical, 'realpath');
      }
    },
  };
}
