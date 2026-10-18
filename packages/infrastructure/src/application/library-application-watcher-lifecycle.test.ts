import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLibraryServices, type LibraryServices } from '../composition/library-services.js';
import type { LibraryScanner, ScanResult } from '../scanning/scan-types.js';
import { createFolderWatcher, type WatchFunction } from '../watching/folder-watcher.js';
import { createLibraryApplication, type LibraryApplication } from './library-application.js';

/**
 * Phase 8: the folder watcher's start/stop operations each take an `await`, so two of them interleaving
 * (a root added while another caller starts the watcher; repeated start/stop) must still leave EXACTLY one
 * watcher running over the current roots - never a second one that nothing remembers and nothing can stop.
 * "Live" below counts OS watch handles that were opened and not yet closed, which is what would leak.
 */
let dir: string;
let services: LibraryServices;
let app: LibraryApplication | undefined;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nova-watcher-lifecycle-')));
  services = createLibraryServices({ databasePath: path.join(dir, 'data', 'nova.db') });
});
afterEach(async () => {
  await app?.dispose();
  app = undefined;
  await services.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const folder = (name: string): string => {
  const target = path.join(dir, name);
  fs.mkdirSync(target);
  return target;
};

function countingWatch(): { watch: WatchFunction; live: () => string[] } {
  const open: string[] = [];
  return {
    watch: (root) => {
      open.push(root);
      return { close: () => void open.splice(open.indexOf(root), 1) };
    },
    live: () => [...open].sort(),
  };
}

describe('watcher lifecycle', () => {
  it('a root added while another caller starts the watcher leaves exactly one watcher per root (no leaked second watcher)', async () => {
    const a = folder('A');
    const b = folder('B');

    // Hold a reconciliation of A in flight, so stopping the watcher (which waits for it) takes a while.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let inFlight!: () => void;
    const scanStarted = new Promise<void>((resolve) => (inFlight = resolve));
    const slowScanner: LibraryScanner = {
      async scan(request) {
        inFlight();
        await gate;
        return { status: 'completed', root: request.root, scope: request.scope ?? request.root, discovered: 0, skipped: 0, added: 0, updated: 0, removed: 0, failed: 0, possibleDuplicates: 0, failures: [], removalWithheld: undefined } satisfies ScanResult;
      },
    };
    const { watch, live } = countingWatch();
    let fire: (relative: string | null) => void = () => undefined;
    const recording: WatchFunction = (root, onEvent, onError) => {
      if (root === a) fire = onEvent;
      return watch(root, onEvent, onError);
    };
    const racing: LibraryServices = { ...services, createFolderWatcher: (options = {}) => createFolderWatcher({ ...options, scanner: slowScanner }) };
    app = createLibraryApplication({ services: racing, watcher: { watch: recording, debounceMs: 0, reconcileIntervalMs: 0 } });

    await app.addRoot(a);
    await app.startWatching();
    fire(null);
    await scanStarted; // the watcher's scan of A is in flight

    const adding = app.addRoot(b); // stops the watcher (waits for the scan) and restarts it over A and B
    await vi.waitFor(() => expect(app!.getWatcherStatus().running).toBe(false)); // the old watcher is being stopped...
    const starting = app.startWatching(); // ...when somebody else asks for the watcher
    release();
    await Promise.all([adding, starting]);

    expect(live()).toEqual([a, b]);
    expect(app.getWatcherStatus()).toMatchObject({ running: true });
    expect(app.getWatcherStatus().roots.map((entry) => entry.path).sort()).toEqual([a, b]);
  });

  it('repeated start / stop cycles never leave a watch handle open', async () => {
    const a = folder('A');
    const { watch, live } = countingWatch();
    app = createLibraryApplication({ services, watcher: { watch, debounceMs: 0, reconcileIntervalMs: 0 } });
    await app.addRoot(a);

    for (let i = 0; i < 25; i += 1) {
      await app.startWatching();
      await app.startWatching(); // idempotent
      expect(live()).toEqual([a]);
      await app.stopWatching();
      expect(live()).toEqual([]);
    }
  });

  it('concurrent start and stop requests end in a consistent state', async () => {
    const a = folder('A');
    const { watch, live } = countingWatch();
    app = createLibraryApplication({ services, watcher: { watch, debounceMs: 0, reconcileIntervalMs: 0 } });
    await app.addRoot(a);

    await Promise.all([app.startWatching(), app.stopWatching(), app.startWatching(), app.stopWatching(), app.startWatching()]);
    // Requests run in the order they were made: the last one (start) wins, and there is exactly one watcher.
    expect(live()).toEqual([a]);
    expect(app.getWatcherStatus().running).toBe(true);
  });

  it('disposing while a start is under way leaves no watcher behind', async () => {
    const a = folder('A');
    const { watch, live } = countingWatch();
    app = createLibraryApplication({ services, watcher: { watch, debounceMs: 0, reconcileIntervalMs: 0 } });
    await app.addRoot(a);
    const starting = app.startWatching();
    const disposing = app.dispose();
    await Promise.allSettled([starting, disposing]);
    expect(live()).toEqual([]);
    expect(app.getWatcherStatus().running).toBe(false);
  });
});
