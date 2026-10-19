import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createLibraryServices, type LibraryServices } from '../composition/library-services.js';
import type { MetadataReader } from '../metadata/music-metadata-reader.js';
import { makeTrack } from '../repositories/test-tracks.js';
import { createLibraryScanner } from '../scanning/library-scanner.js';
import type { LibraryScanner, ScanResult } from '../scanning/scan-types.js';
import { createFolderWatcher, type WatchFunction } from '../watching/folder-watcher.js';
import { createLibraryApplication, type LibraryApplication } from './library-application.js';

/**
 * Phase 8: removing a library folder while the folder watcher is in the middle of reconciling it.
 *
 * The scanner's documented cancellation policy is "no new file is started, in-flight tag reads finish and
 * are saved". So a watcher scan that is already reading files when the user removes the folder will still
 * SAVE those files after the removal has deleted the folder's tracks. Before Phase 8 `removeRoot` deleted
 * first and only then stopped the watcher, leaving "orphan" tracks that belong to no registered folder:
 * they showed up in the library, could not be played (`root-not-registered`) and could never be removed
 * (there is no folder left to remove).
 */
let dir: string;
let services: LibraryServices;
let app: LibraryApplication | undefined;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nova-app-hardening-')));
  services = createLibraryServices({ databasePath: path.join(dir, 'data', 'nova.db') });
});
afterEach(async () => {
  await app?.dispose();
  app = undefined;
  await services.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const fixtureDir = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../tests/fixtures/metadata');

describe('removeRoot while the watcher is reconciling that root', () => {
  it('REAL scanner, real files: a scan that is mid-read when the folder is removed cannot leave orphan tracks behind', async () => {
    const music = path.join(dir, 'Music');
    fs.mkdirSync(music);
    for (const name of ['a.mp3', 'b.mp3', 'c.mp3']) fs.copyFileSync(path.join(fixtureDir, 'full-tags.mp3'), path.join(music, name));

    // The first tag read blocks, so the watcher's scan is genuinely "in flight" with files still to save.
    const reading = deferred();
    const gate = deferred();
    const realReader = services.metadataReader;
    let blocked = false;
    const gatedReader: MetadataReader = {
      async read(filePath) {
        if (!blocked) {
          blocked = true;
          reading.resolve();
          await gate.promise;
        }
        return realReader.read(filePath);
      },
    };
    const scanner = createLibraryScanner({ fileSystem: services.fileSystem, metadataReader: gatedReader, trackRepository: services.trackRepository, concurrency: 1, batchSize: 1 });
    let fireWatchEvent: (relativePath: string | null) => void = () => undefined;
    const fakeWatch: WatchFunction = (_root, onEvent) => {
      fireWatchEvent = onEvent;
      return { close: () => undefined };
    };
    const racing: LibraryServices = { ...services, createFolderWatcher: (options = {}) => createFolderWatcher({ ...options, scanner }) };
    app = createLibraryApplication({ services: racing, watcher: { watch: fakeWatch, debounceMs: 0, reconcileIntervalMs: 0 }, progressIntervalMs: 0 });

    const root = await app.addRoot(music);
    await app.startWatching();
    fireWatchEvent(null); // "something changed, look at the whole folder"
    await reading.promise; // the watcher's scan is now inside its first tag read

    const removal = app.removeRoot(root.id);
    gate.resolve();
    await removal;

    expect(await app.listRoots()).toEqual([]);
    expect(services.trackRepository.list().map((track) => path.basename(track.sourcePath))).toEqual([]);
  });

  it('leaves no orphan tracks behind: tracks saved by an in-flight watcher scan are removed with the folder', async () => {
    const music = path.join(dir, 'Music');
    fs.mkdirSync(music);

    const started = deferred();
    const gate = deferred();
    const racingScanner: LibraryScanner = {
      async scan(request) {
        started.resolve();
        await gate.promise; // the tag reads of this batch are "in flight"...
        // ...and the scanner's cancellation policy saves what was already read, even though the scan was told to stop.
        services.trackRepository.insert({ track: makeTrack({ sourcePath: path.join(music, 'late.mp3') }), sizeBytes: 1, modifiedAtMs: 1 });
        return {
          status: request.signal?.aborted === true ? 'cancelled' : 'completed',
          root: request.root,
          scope: request.scope ?? request.root,
          discovered: 1, skipped: 0, added: 1, updated: 0, removed: 0, failed: 0, possibleDuplicates: 0,
          failures: [],
          removalWithheld: undefined,
        } satisfies ScanResult;
      },
    };
    let fireWatchEvent: (relativePath: string | null) => void = () => undefined;
    const fakeWatch: WatchFunction = (_root, onEvent) => {
      fireWatchEvent = onEvent;
      return { close: () => undefined };
    };
    const racing: LibraryServices = {
      ...services,
      createFolderWatcher: (options = {}) => createFolderWatcher({ ...options, scanner: racingScanner }),
    };
    app = createLibraryApplication({ services: racing, watcher: { watch: fakeWatch, debounceMs: 0, reconcileIntervalMs: 0 }, progressIntervalMs: 0 });

    const root = await app.addRoot(music);
    services.trackRepository.insert({ track: makeTrack({ sourcePath: path.join(music, 'existing.mp3') }), sizeBytes: 1, modifiedAtMs: 1 });
    await app.startWatching();
    fireWatchEvent('late.mp3');
    await started.promise; // the watcher's scan is now running

    const removal = app.removeRoot(root.id);
    gate.resolve();
    const result = await removal;

    expect(await app.listRoots()).toEqual([]);
    expect(services.trackRepository.list().map((track) => path.basename(track.sourcePath))).toEqual([]);
    expect(result.removedTracks).toBe(2); // the existing track AND the one the in-flight scan saved
  });

  it('keeps watching the REMAINING folders afterwards, and a failed removal leaves the watcher running', async () => {
    const a = path.join(dir, 'A');
    const b = path.join(dir, 'B');
    fs.mkdirSync(a);
    fs.mkdirSync(b);
    const watched: string[] = [];
    const closed: string[] = [];
    const fakeWatch: WatchFunction = (root) => {
      watched.push(root);
      return { close: () => void closed.push(root) };
    };
    app = createLibraryApplication({ services, watcher: { watch: fakeWatch, debounceMs: 0, reconcileIntervalMs: 0 } });
    const ra = await app.addRoot(a);
    await app.addRoot(b);
    await app.startWatching();
    // The ORDER in which roots are watched is not part of the contract (the list order is storage-defined and differs between platforms), so compare as sets.
    const same = (actual: readonly string[], expected: readonly string[]) => expect([...actual].sort()).toEqual([...expected].sort());
    same(watched, [a, b]);

    await app.removeRoot(ra.id);
    same(closed, [a, b]); // the old watcher was stopped...
    expect(watched.slice(2)).toEqual([b]); // ...and a new one watches only what is left
    expect(app.getWatcherStatus().running).toBe(true);
    expect(app.getWatcherStatus().roots.map((entry) => entry.path)).toEqual([b]);

    // A removal that fails (unknown id) must not stop a running watcher.
    await expect(app.removeRoot('123e4567-e89b-42d3-a456-426614174000')).rejects.toMatchObject({ code: 'root-not-found' });
    expect(app.getWatcherStatus().running).toBe(true);
    same(watched.slice(0, 2), [a, b]);
    expect(watched.slice(2)).toEqual([b]); // the failed removal started nothing new
  });

  it('a database failure during removal still restores the watcher and keeps the tracks', async () => {
    const a = path.join(dir, 'A');
    fs.mkdirSync(a);
    const fakeWatch: WatchFunction = () => ({ close: () => undefined });
    const failing = {
      ...services,
      trackRepository: { ...services.trackRepository, runInTransaction: () => { throw new Error('disk I/O error'); } },
    } as unknown as LibraryServices;
    // Bind the real methods the application calls on the spread copies.
    Object.assign(failing.trackRepository, { listFileStates: () => services.trackRepository.listFileStates(), list: () => services.trackRepository.list() });
    app = createLibraryApplication({ services: failing, watcher: { watch: fakeWatch, debounceMs: 0, reconcileIntervalMs: 0 } });
    const root = await app.addRoot(a);
    await app.startWatching();

    await expect(app.removeRoot(root.id)).rejects.toThrow('disk I/O error');
    expect(await app.listRoots()).toHaveLength(1);
    expect(app.getWatcherStatus().running).toBe(true);
  });
});


describe('removeRoot is refused if a scan starts while the watcher is being stopped', () => {
  it('does not delete a folder that a manual scan has just begun reading', async () => {
    const a = path.join(dir, 'A');
    fs.mkdirSync(a);
    const reading = deferred();
    const gate = deferred();
    const slow: LibraryScanner = {
      async scan(request) {
        reading.resolve();
        await gate.promise; // the watcher's reconciliation is in flight, so stopping the watcher takes a while
        return { status: 'completed', root: request.root, scope: request.scope ?? request.root, discovered: 0, skipped: 0, added: 0, updated: 0, removed: 0, failed: 0, possibleDuplicates: 0, failures: [], removalWithheld: undefined } satisfies ScanResult;
      },
    };
    let fire: (relative: string | null) => void = () => undefined;
    const fakeWatch: WatchFunction = (_root, onEvent) => {
      fire = onEvent;
      return { close: () => undefined };
    };
    const racing: LibraryServices = { ...services, createFolderWatcher: (options = {}) => createFolderWatcher({ ...options, scanner: slow }) };
    app = createLibraryApplication({ services: racing, watcher: { watch: fakeWatch, debounceMs: 0, reconcileIntervalMs: 0 } });
    const root = await app.addRoot(a);
    await app.startWatching();
    fire(null);
    await reading.promise;

    const removal = app.removeRoot(root.id);
    const rejected = expect(removal).rejects.toMatchObject({ code: 'scan-running' });
    await vi.waitFor(() => expect(app!.getWatcherStatus().running).toBe(false)); // the watcher is being stopped...
    app.startScan(); // ...and the user starts a scan of that very folder
    gate.resolve();
    await rejected;

    expect(await app.listRoots()).toHaveLength(1); // the folder is still there, untouched
    expect(app.getWatcherStatus().running).toBe(true); // and the watcher was put back
  });
});
