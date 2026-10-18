import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Track, TrackRepository } from '@nova/domain';
import { openDatabase, type NovaDatabase } from '../database/index.js';
import { createNodeFileSystem } from '../filesystem/index.js';
import type { FileSystem } from '../filesystem/file-system.js';
import { createMusicMetadataReader, type MetadataReader } from '../metadata/music-metadata-reader.js';
import { SqliteTrackRepository } from '../repositories/sqlite-track-repository.js';
import { createLibraryScanner, type LibraryScannerDependencies } from './library-scanner.js';
import type { LibraryScanner } from './scan-types.js';

const fixtureDir = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../tests/fixtures/metadata');

/** Names of the committed fixture files. */
export const FIXTURES = {
  full: 'full-tags.mp3',
  unicode: 'unicode-tags.flac',
  noTags: 'No Tags Artist - No Tags Title.mp3',
  partial: 'Partial Tags.mp3',
  ogg: 'formats-sample.ogg',
  opus: 'formats-sample.opus',
  m4a: 'formats-sample.m4a',
  wav: 'formats-sample.wav',
} as const;

export interface ScanKit {
  readonly dir: string;
  /** The library root (a real, empty folder to start with). */
  readonly root: string;
  readonly database: NovaDatabase;
  readonly repository: TrackRepository;
  readonly fileSystem: FileSystem;
  /** Paths the metadata reader was asked to read, in call order. */
  readonly readCalls: string[];
  readonly scanner: LibraryScanner;
  /** Copies a fixture to `relative` under the root (creating folders). Returns the absolute path. */
  addFixture(relative: string, fixture: string): string;
  /** Writes arbitrary bytes at `relative` under the root. */
  addFile(relative: string, content: Buffer | string): string;
  remove(relative: string): void;
  /** Sets a file's modification time (whole seconds, so it round-trips exactly). */
  touch(relative: string, secondsSinceEpoch: number): void;
  resolve(relative: string): string;
  tracksByTitle(): Map<string, Track>;
  cleanup(): void;
}

export interface ScanKitOptions {
  readonly dependencies?: Partial<LibraryScannerDependencies>;
  /** Wraps the real reader (e.g. to count or intercept reads). */
  readonly wrapReader?: (inner: MetadataReader) => MetadataReader;
  readonly wrapRepository?: (inner: TrackRepository) => TrackRepository;
  readonly wrapFileSystem?: (inner: FileSystem) => FileSystem;
}

/** A throwaway library + database + real scanner, all on the real disk. */
export function createScanKit(options: ScanKitOptions = {}): ScanKit {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nova-scan-test-')));
  const root = path.join(dir, 'library');
  fs.mkdirSync(root);

  const database = openDatabase({ filePath: path.join(dir, 'data', 'nova.db') });
  const repository = options.wrapRepository ? options.wrapRepository(new SqliteTrackRepository(database)) : new SqliteTrackRepository(database);
  const fileSystem = options.wrapFileSystem ? options.wrapFileSystem(createNodeFileSystem()) : createNodeFileSystem();

  const readCalls: string[] = [];
  const realReader = createMusicMetadataReader();
  const countingReader: MetadataReader = {
    read(filePath) {
      readCalls.push(filePath);
      return realReader.read(filePath);
    },
  };
  const metadataReader = options.wrapReader ? options.wrapReader(countingReader) : countingReader;

  const scanner = createLibraryScanner({ fileSystem, metadataReader, trackRepository: repository, ...options.dependencies });

  const resolve = (relative: string): string => path.join(root, ...relative.split('/'));
  const ensureParent = (full: string): void => {
    fs.mkdirSync(path.dirname(full), { recursive: true });
  };

  return {
    dir,
    root,
    database,
    repository,
    fileSystem,
    readCalls,
    scanner,
    addFixture(relative, fixture) {
      const target = resolve(relative);
      ensureParent(target);
      fs.copyFileSync(path.join(fixtureDir, fixture), target);
      return target;
    },
    addFile(relative, content) {
      const target = resolve(relative);
      ensureParent(target);
      fs.writeFileSync(target, content);
      return target;
    },
    remove(relative) {
      fs.rmSync(resolve(relative), { recursive: true, force: true });
    },
    touch(relative, seconds) {
      const when = new Date(seconds * 1000);
      fs.utimesSync(resolve(relative), when, when);
    },
    resolve,
    tracksByTitle() {
      return new Map(repository.list().map((track) => [track.title, track]));
    },
    cleanup() {
      database.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Decorates `inner` with `overrides`, forwarding every other member to it
 *  (class instances keep their methods on the prototype, so `{...inner}`
 *  would silently drop them). */
export function withOverrides<T extends object>(inner: T, overrides: Partial<T>): T {
  return new Proxy(inner, {
    get(target, property, receiver) {
      if (property in overrides) return (overrides as Record<string | symbol, unknown>)[property];
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}
