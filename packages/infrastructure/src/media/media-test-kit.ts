import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Track } from '@nova/domain';
import { IN_MEMORY_DATABASE, openDatabase } from '../database/index.js';
import { createNodeFileSystem } from '../filesystem/node-file-system.js';
import { SqliteLibraryRootRepository } from '../repositories/sqlite-library-root-repository.js';
import { SqliteTrackRepository } from '../repositories/sqlite-track-repository.js';
import { makeTrack } from '../repositories/test-tracks.js';
import { createMediaAccess } from './media-access.js';

/* Test-only: a real sandbox directory, real SQLite repositories (in memory) and
 * the real file system, so the security tests exercise real symlinks, real
 * renames and real bytes - not mocks of them. */

export const fixturesDir = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../tests/fixtures');
export const mp3Fixture = path.join(fixturesDir, 'sample-track.mp3');
export const flacFixture = path.join(fixturesDir, 'sample-track.flac');

export interface MediaKit {
  /** The sandbox directory (a real path: symlinks in the temp dir are resolved). */
  readonly sandbox: string;
  readonly trackRepository: SqliteTrackRepository;
  readonly libraryRootRepository: SqliteLibraryRootRepository;
  readonly fileSystem: ReturnType<typeof createNodeFileSystem>;
  readonly access: ReturnType<typeof createMediaAccess>;
  /** Creates `<sandbox>/<name>` and registers it as a library root. */
  addRoot(name: string): { readonly id: string; readonly path: string };
  /** Copies `source` (default: the mp3 fixture) to `<sandbox>/<relativePath>` and stores a track for it. */
  addTrack(relativePath: string, source?: string | Buffer): Track;
  /** Stores a track row for a path WITHOUT creating any file. */
  addTrackRecordOnly(absolutePath: string): Track;
  close(): void;
}

export function createMediaKit(): MediaKit {
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nova-media-test-')));
  const database = openDatabase({ filePath: IN_MEMORY_DATABASE });
  const trackRepository = new SqliteTrackRepository(database);
  const libraryRootRepository = new SqliteLibraryRootRepository(database);
  const fileSystem = createNodeFileSystem();
  const access = createMediaAccess({ trackRepository, libraryRootRepository, fileSystem });

  function addTrackRecordOnly(absolutePath: string): Track {
    const track = makeTrack({ sourcePath: absolutePath });
    trackRepository.insert({ track, sizeBytes: 1 });
    return track;
  }

  return {
    sandbox,
    trackRepository,
    libraryRootRepository,
    fileSystem,
    access,
    addRoot(name) {
      const rootPath = path.join(sandbox, name);
      fs.mkdirSync(rootPath, { recursive: true });
      const root = { id: crypto.randomUUID(), path: rootPath, addedAtMs: Date.now() };
      libraryRootRepository.insert(root);
      return root;
    },
    addTrack(relativePath, source = mp3Fixture) {
      const target = path.join(sandbox, ...relativePath.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (typeof source === 'string') fs.copyFileSync(source, target);
      else fs.writeFileSync(target, source);
      return addTrackRecordOnly(target);
    },
    addTrackRecordOnly,
    close() {
      database.close();
      fs.rmSync(sandbox, { recursive: true, force: true });
    },
  };
}
