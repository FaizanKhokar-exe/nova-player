import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchTracks } from '@nova/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLibraryServices, type LibraryServices } from '../composition/library-services.js';
import type { WatchFunction } from '../watching/folder-watcher.js';
import {
  createLibraryApplication,
  LibraryApplicationError,
  type LibraryApplication,
  type LibraryApplicationDependencies,
  type LibraryApplicationEvent,
  type LibraryApplicationErrorCode,
} from './library-application.js';

const fixtureDir = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../tests/fixtures/metadata');
const FULL = 'full-tags.mp3';
const UNICODE = 'unicode-tags.flac';
const PARTIAL = 'Partial Tags.mp3';
const NO_TAGS = 'No Tags Artist - No Tags Title.mp3';

let dir: string;
let services: LibraryServices;
let app: LibraryApplication;
let events: LibraryApplicationEvent[];
let internalErrors: unknown[];

function folder(name: string): string {
  const full = path.join(dir, name);
  fs.mkdirSync(full, { recursive: true });
  return full;
}
function put(folderPath: string, relative: string, fixture: string): string {
  const target = path.join(folderPath, ...relative.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(fixtureDir, fixture), target);
  return target;
}
// Roots list oldest-first with ties broken by (random) id, so two roots added
// within the same millisecond would come back in an arbitrary order. A strictly
// increasing test clock keeps "oldest first" unambiguous.
let tick = 0;
function make(overrides: Partial<LibraryApplicationDependencies> = {}): LibraryApplication {
  app = createLibraryApplication({
    services, progressIntervalMs: 0, now: () => Date.now() + (tick += 1), onInternalError: (e) => internalErrors.push(e),
    watcher: { debounceMs: 100, reconcileIntervalMs: 0 }, ...overrides,
  });
  app.subscribe((e) => events.push(e));
  return app;
}
async function waitFor(condition: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const finished = (): boolean => events.some((e) => e.type === 'scan-finished');
async function scanAll(a: LibraryApplication, rootId?: string): Promise<Extract<LibraryApplicationEvent, { type: 'scan-finished' }>['result']> {
  events.length = 0;
  a.startScan(rootId === undefined ? {} : { rootId });
  await waitFor(finished, 'scan to finish');
  return (events.find((e) => e.type === 'scan-finished') as Extract<LibraryApplicationEvent, { type: 'scan-finished' }>).result;
}
async function expectCode(promise: Promise<unknown> | (() => unknown), code: LibraryApplicationErrorCode): Promise<void> {
  try {
    await (typeof promise === 'function' ? promise() : promise);
  } catch (error) {
    expect(error).toBeInstanceOf(LibraryApplicationError);
    expect((error as LibraryApplicationError).code).toBe(code);
    return;
  }
  throw new Error(`expected LibraryApplicationError(${code})`);
}

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nova-app-test-')));
  services = createLibraryServices({ databasePath: path.join(dir, 'data', 'nova.db') });
  events = [];
  internalErrors = [];
});
afterEach(async () => {
  await app?.dispose();
  await services.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('library roots', () => {
  it('registers an existing folder, returning its status; starts empty', async () => {
    make();
    expect(await app.listRoots()).toEqual([]);
    const music = folder('Music');
    const root = await app.addRoot(music);
    expect(root).toMatchObject({ path: music, available: true, trackCount: 0, watched: false });
    expect(root.id).toHaveLength(36);
    expect(root.addedAtMs).toBeGreaterThan(0);
    expect(await app.listRoots()).toEqual([root]);
    expect(events).toContainEqual({ type: 'library-changed', reason: 'root-added' });
  });

  it('stores the true on-disk path, so differently-spelled paths are the same root', async () => {
    make();
    const music = folder('Music');
    await app.addRoot(music);
    await expectCode(app.addRoot(`${music}${path.sep}`), 'root-exists');
    await expectCode(app.addRoot(path.join(music, '..', 'Music', '.')), 'root-exists');
  });

  it('refuses a folder that contains, or is inside, an existing root', async () => {
    make();
    const music = folder('Music');
    folder('Music/Rock');
    await app.addRoot(music);
    await expectCode(app.addRoot(path.join(music, 'Rock')), 'root-overlaps');
    const sub = folder('Library/Sub');
    await app.addRoot(sub);
    await expectCode(app.addRoot(path.join(dir, 'Library')), 'root-overlaps');
    expect((await app.listRoots()).map((r) => r.path)).toEqual([music, sub]);
  });

  it('a sibling that merely shares a name prefix is not an overlap', async () => {
    make();
    await app.addRoot(folder('Music'));
    await expect(app.addRoot(folder('Music2'))).resolves.toBeDefined();
  });

  it('refuses a missing path, a file, and a relative path', async () => {
    make();
    await expectCode(app.addRoot(path.join(dir, 'nope')), 'root-unavailable');
    const file = put(folder('f'), 'a.mp3', FULL);
    await expectCode(app.addRoot(file), 'root-not-directory');
    await expect(app.addRoot('relative/path')).rejects.toMatchObject({ code: 'invalid-path' });
  });

  it('roots persist across an application restart', async () => {
    make();
    const root = await app.addRoot(folder('Music'));
    await app.dispose();
    await services.close();

    services = createLibraryServices({ databasePath: path.join(dir, 'data', 'nova.db') });
    make();
    expect(await app.listRoots()).toEqual([root]);
  });

  it('reports how many tracks lie inside each root, and whether it is still available', async () => {
    make();
    const a = folder('A');
    const b = folder('B');
    put(a, 'one.mp3', FULL);
    put(a, 'deep/two.flac', UNICODE);
    put(b, 'three.mp3', PARTIAL);
    const ra = await app.addRoot(a);
    const rb = await app.addRoot(b);
    await scanAll(app);

    const roots = await app.listRoots();
    expect(roots.find((r) => r.id === ra.id)).toMatchObject({ trackCount: 2, available: true });
    expect(roots.find((r) => r.id === rb.id)).toMatchObject({ trackCount: 1, available: true });

    fs.rmSync(b, { recursive: true });
    expect((await app.listRoots()).find((r) => r.id === rb.id)).toMatchObject({ available: false, trackCount: 1 });
  });

  describe('removeRoot', () => {
    it('removes the root and ONLY the tracks inside it', async () => {
      make();
      const a = folder('A');
      const b = folder('B');
      put(a, 'one.mp3', FULL);
      put(a, 'deep/two.flac', UNICODE);
      put(b, 'three.mp3', PARTIAL);
      const ra = await app.addRoot(a);
      await app.addRoot(b);
      await scanAll(app);

      expect(await app.removeRoot(ra.id)).toEqual({ removedTracks: 2 });
      expect((await app.listRoots()).map((r) => r.path)).toEqual([b]);
      expect(app.listTracks().map((t) => path.basename(t.sourcePath))).toEqual(['three.mp3']);
      expect(events).toContainEqual({ type: 'library-changed', reason: 'root-removed' });
      expect(fs.existsSync(path.join(a, 'one.mp3'))).toBe(true); // never touches the user's files
    });

    it('an unknown id is root-not-found', async () => {
      make();
      await expectCode(app.removeRoot('123e4567-e89b-42d3-a456-426614174000'), 'root-not-found');
    });

    it('is refused while a scan is running', async () => {
      make();
      const a = folder('A');
      for (let i = 0; i < 20; i += 1) put(a, `t${i}.mp3`, FULL);
      const root = await app.addRoot(a);
      app.startScan();
      await expectCode(app.removeRoot(root.id), 'scan-running');
      await waitFor(finished, 'scan');
    });
  });
});

describe('scan lifecycle', () => {
  it('scans every root in the background: progress events, then a final result and a library-changed event', async () => {
    make();
    const a = folder('A');
    const b = folder('B');
    put(a, 'one.mp3', FULL);
    put(b, 'two.flac', UNICODE);
    fs.writeFileSync(path.join(b, 'broken.mp3'), Buffer.alloc(500, 0x41));
    const ra = await app.addRoot(a);
    const rb = await app.addRoot(b);

    events.length = 0;
    const started = app.startScan();
    expect(started).toMatchObject({ rootCount: 2 });
    expect(started.scanId).toHaveLength(36);
    expect(app.getScanState().active?.scanId).toBe(started.scanId);
    await waitFor(finished, 'scan to finish');

    const progress = events.filter((e) => e.type === 'scan-progress');
    expect(progress.length).toBeGreaterThan(0);
    for (const e of progress) {
      if (e.type === 'scan-progress') expect(e.progress).toMatchObject({ scanId: started.scanId, rootCount: 2 });
    }
    const result = events.find((e) => e.type === 'scan-finished');
    expect(result).toMatchObject({
      type: 'scan-finished',
      result: { scanId: started.scanId, status: 'completed' },
    });
    if (result?.type !== 'scan-finished') throw new Error('unreachable');
    expect(result.result.roots.map((r) => [r.rootId, r.status, r.counts.added, r.failureCount])).toEqual([
      [ra.id, 'completed', 1, 0],
      [rb.id, 'completed', 1, 1],
    ]);
    expect(result.result.roots[1]?.failures[0]).toMatchObject({ kind: 'unreadable-media' });
    expect(events.at(-1)).toEqual({ type: 'library-changed', reason: 'scan' });
    expect(app.getScanState()).toMatchObject({ active: undefined, last: { scanId: started.scanId, status: 'completed' } });
    expect(app.listTracks()).toHaveLength(2);
  });

  it('can scan just one root', async () => {
    make();
    const a = folder('A');
    const b = folder('B');
    put(a, 'one.mp3', FULL);
    put(b, 'two.flac', UNICODE);
    await app.addRoot(a);
    const rb = await app.addRoot(b);
    const result = await scanAll(app, rb.id);
    expect(result.roots).toHaveLength(1);
    expect(app.listTracks().map((t) => path.basename(t.sourcePath))).toEqual(['two.flac']);
  });

  it('refuses a second scan while one runs, and invalid requests', async () => {
    make();
    const a = folder('A');
    for (let i = 0; i < 15; i += 1) put(a, `t${i}.mp3`, FULL);
    await app.addRoot(a);
    app.startScan();
    expect(() => app.startScan()).toThrow(LibraryApplicationError);
    await expectCode(() => app.startScan(), 'scan-running');
    await waitFor(finished, 'scan');

    await expectCode(() => app.startScan({ rootId: '123e4567-e89b-42d3-a456-426614174000' }), 'root-not-found');
  });

  it('with no roots there is nothing to scan', async () => {
    make();
    await expectCode(() => app.startScan(), 'no-roots');
  });

  it('a second scan after the first finished re-reads nothing (incremental)', async () => {
    make();
    const a = folder('A');
    put(a, 'one.mp3', FULL);
    put(a, 'two.flac', UNICODE);
    await app.addRoot(a);
    await scanAll(app);
    const second = await scanAll(app);
    expect(second.roots[0]?.counts).toMatchObject({ skipped: 2, added: 0, updated: 0 });
  });

  it('cancellation: reports cancelled, keeps whole tracks only, and the next scan resumes', async () => {
    make();
    const a = folder('A');
    for (let i = 0; i < 60; i += 1) put(a, `t${String(i).padStart(2, '0')}.mp3`, FULL);
    await app.addRoot(a);

    events.length = 0;
    app.startScan();
    expect(app.cancelScan()).toBe(true);
    await waitFor(finished, 'cancelled scan to finish');
    const result = events.find((e) => e.type === 'scan-finished');
    if (result?.type !== 'scan-finished') throw new Error('unreachable');
    expect(result.result.status).toBe('cancelled');
    expect(app.cancelScan()).toBe(false); // nothing running any more
    const saved = app.listTracks().length;
    expect(saved).toBeLessThan(60);
    for (const track of app.listTracks()) expect(track.title).toBe('Full Tags Song');

    const resumed = await scanAll(app);
    expect(resumed.status).toBe('completed');
    expect(app.listTracks()).toHaveLength(60);
  });

  it('a root that is unavailable fails that root with a stable code; the job fails if every root failed', async () => {
    make();
    const a = folder('A');
    await app.addRoot(a);
    fs.rmSync(a, { recursive: true });
    const result = await scanAll(app);
    expect(result.status).toBe('failed');
    expect(result.roots[0]).toMatchObject({ status: 'failed', error: { code: 'root-unavailable' } });
  });

  it('one bad root does not stop the others, and the job still completes', async () => {
    make();
    const a = folder('A');
    const b = folder('B');
    put(b, 'ok.mp3', FULL);
    await app.addRoot(a);
    await app.addRoot(b);
    fs.rmSync(a, { recursive: true });
    const result = await scanAll(app);
    expect(result.status).toBe('completed');
    expect(result.roots.map((r) => r.status)).toEqual(['failed', 'completed']);
    expect(app.listTracks()).toHaveLength(1);
  });

  it('throttles progress events within a phase but always sends phase changes', async () => {
    const frozenClock = 0; // time never advances, so only phase changes can pass the throttle
    make({ progressIntervalMs: 1_000_000, now: () => frozenClock });
    const a = folder('A');
    for (let i = 0; i < 12; i += 1) put(a, `s${i}/t.mp3`, FULL);
    await app.addRoot(a);
    events.length = 0;
    app.startScan();
    await waitFor(finished, 'scan');
    const phases = events.flatMap((e) => (e.type === 'scan-progress' ? [e.progress.progress.phase] : []));
    // one event per phase (discovering, reading, completed...), not one per file
    expect(new Set(phases).size).toBe(phases.length);
    expect(phases).toContain('discovering');
    expect(phases).toContain('reading');
  });

  it('the latest progress is always available via getScanState while running', async () => {
    make();
    const a = folder('A');
    for (let i = 0; i < 30; i += 1) put(a, `t${i}.mp3`, FULL);
    await app.addRoot(a);
    app.startScan();
    await waitFor(() => app.getScanState().active?.progress !== undefined || finished(), 'first progress');
    await waitFor(finished, 'scan');
    expect(app.getScanState().active).toBeUndefined();
  });

  it('a throwing subscriber is contained: it never aborts the scan', async () => {
    make();
    app.subscribe(() => {
      throw new Error('subscriber bug');
    });
    const a = folder('A');
    put(a, 'one.mp3', FULL);
    await app.addRoot(a);
    const result = await scanAll(app);
    expect(result.status).toBe('completed');
    expect(app.listTracks()).toHaveLength(1);
    expect(internalErrors.length).toBeGreaterThan(0);
  });

  it('an unexpected scanner crash is contained, reported internally, and surfaced as a generic failure', async () => {
    const crashing = { ...services, scanner: { scan: () => Promise.reject(new TypeError('secret internal detail')) } } as unknown as LibraryServices;
    make({ services: crashing });
    const a = folder('A');
    await app.addRoot(a);
    const result = await scanAll(app);
    expect(result.roots[0]?.error).toEqual({ code: 'internal', message: 'The scan stopped because of an unexpected error.' });
    expect(JSON.stringify(result)).not.toContain('secret internal detail');
    expect(internalErrors).toHaveLength(1);
  });
});

describe('track listing and search', () => {
  async function seeded(): Promise<void> {
    make();
    const a = folder('A');
    put(a, 'full.mp3', FULL);
    put(a, 'unicode.flac', UNICODE);
    put(a, 'partial.mp3', PARTIAL);
    put(a, NO_TAGS, NO_TAGS);
    await app.addRoot(a);
    await scanAll(app);
  }

  it('lists every stored track in a stable title/artist order', async () => {
    await seeded();
    const tracks = app.listTracks();
    expect(tracks.map((t) => t.title)).toEqual(['Full Tags Song', 'No Tags Title', 'Only A Title', '夜に駆ける – Ünïcödé 🎵']);
    expect(app.listTracks()).toEqual(tracks);
  });

  it('search is exactly the domain search over the stored tracks (not reimplemented)', async () => {
    await seeded();
    for (const query of ['tagged', 'THE  tagged', 'full', 'ünï', 'yoasobi', 'rock', 'no tags', 'zzz-nothing', '']) {
      expect(app.searchTracks(query)).toEqual(searchTracks(services.trackRepository.list(), query));
    }
    expect(app.searchTracks('tagged').map((r) => r.track.title)).toEqual(['Full Tags Song']);
    expect(app.searchTracks('   ')).toEqual([]);
  });
});

describe('watcher lifecycle', () => {
  const deaf: WatchFunction = () => ({ close: () => undefined });

  it('is stopped by default; start/stop are idempotent and report status', async () => {
    make();
    const a = await app.addRoot(folder('A'));
    expect(app.getWatcherStatus()).toMatchObject({ running: false, roots: [] });

    const started = await app.startWatching();
    expect(started).toMatchObject({ running: true, roots: [{ rootId: a.id, state: 'watching' }] });
    expect((await app.startWatching()).running).toBe(true); // idempotent
    expect((await app.listRoots())[0]?.watched).toBe(true);

    expect(await app.stopWatching()).toMatchObject({ running: false, roots: [] });
    expect((await app.stopWatching()).running).toBe(false); // idempotent
    expect((await app.listRoots())[0]?.watched).toBe(false);
    expect(events.filter((e) => e.type === 'watcher-status').length).toBeGreaterThanOrEqual(2);
  });

  it('starting with no roots is fine, and the watcher picks up roots added later', async () => {
    make();
    expect((await app.startWatching()).roots).toEqual([]);
    const a = await app.addRoot(folder('A'));
    expect(app.getWatcherStatus().roots).toEqual([{ rootId: a.id, path: a.path, state: 'watching' }]);
    await app.removeRoot(a.id);
    expect(app.getWatcherStatus()).toMatchObject({ running: true, roots: [] });
  });

  it('a root that cannot be watched is reported unavailable, not hidden', async () => {
    make();
    const a = folder('A');
    await app.addRoot(a);
    fs.rmSync(a, { recursive: true });
    const status = await app.startWatching();
    expect(status.roots).toMatchObject([{ state: 'unavailable' }]);
    expect(status.lastError?.message).toBeTruthy();
  });

  it('real file changes are reconciled and announced as library-changed', async () => {
    make();
    const a = folder('A');
    await app.addRoot(a);
    await app.startWatching();
    events.length = 0;

    put(a, 'new.mp3', FULL);
    await waitFor(() => app.listTracks().length === 1, 'new file to be added by the watcher');
    await waitFor(() => events.some((e) => e.type === 'library-changed' && e.reason === 'watcher'), 'library-changed event');
    expect(app.getWatcherStatus().lastReconcile).toMatchObject({ status: 'completed' });
    expect(app.getWatcherStatus().lastReconcile?.counts.added).toBeGreaterThanOrEqual(0);
  });

  it('periodic reconciliation works through the application layer (deaf OS watch)', async () => {
    make({ watcher: { watch: deaf, debounceMs: 50, reconcileIntervalMs: 120 } });
    const a = folder('A');
    await app.addRoot(a);
    await app.startWatching();
    put(a, 'late.mp3', FULL);
    await waitFor(() => app.listTracks().length === 1, 'periodic reconcile');
  });
});

describe('dispose', () => {
  it('aborts and awaits a running scan, stops the watcher, and silences events', async () => {
    make();
    const a = folder('A');
    for (let i = 0; i < 40; i += 1) put(a, `t${i}.mp3`, FULL);
    await app.addRoot(a);
    await app.startWatching();
    app.startScan();

    await app.dispose();
    expect(app.getWatcherStatus().running).toBe(false);
    expect(app.getScanState().active).toBeUndefined();
    const seen = events.length;
    await new Promise((r) => setTimeout(r, 100));
    expect(events.length).toBe(seen); // nothing is emitted after dispose
    await app.dispose(); // idempotent
    expect(() => app.startScan()).toThrow(/closed/);
  });

  it('unsubscribe stops delivery to that listener only', async () => {
    make();
    const received: string[] = [];
    const off = app.subscribe((e) => received.push(e.type));
    await app.addRoot(folder('A'));
    expect(received).toEqual(['library-changed']);
    off();
    await app.addRoot(folder('B'));
    expect(received).toEqual(['library-changed']);
    expect(events.filter((e) => e.type === 'library-changed')).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ *
 * Phase 5: sorting, groups, and the launch policy
 * ------------------------------------------------------------------ */

describe('sorted listing and groups (Phase 5)', () => {
  async function populated(): Promise<void> {
    make();
    const music = folder('Music');
    put(music, 'a.mp3', FULL);
    put(music, 'b.flac', UNICODE);
    put(music, 'c.mp3', PARTIAL);
    put(music, 'd.mp3', NO_TAGS);
    await app.addRoot(music);
    await scanAll(app);
  }

  it('listTracks defaults to title ascending and honours a sort; descending reverses the known values', async () => {
    await populated();
    const defaultOrder = app.listTracks().map((t) => t.id);
    expect(app.listTracks({ field: 'title', direction: 'asc' }).map((t) => t.id)).toEqual(defaultOrder);
    const titlesAsc = app.listTracks({ field: 'title', direction: 'asc' }).map((t) => t.title.toLowerCase());
    expect(titlesAsc).toEqual([...titlesAsc].sort());
    expect(app.listTracks({ field: 'title', direction: 'desc' }).map((t) => t.id)).toEqual([...defaultOrder].reverse());
  });

  it('summary counts agree with the group lists', async () => {
    await populated();
    const summary = app.getSummary();
    expect(summary.trackCount).toBe(4);
    expect(summary.albumCount).toBe(app.listGroups('album').length);
    expect(summary.artistCount).toBe(app.listGroups('artist').length);
    expect(summary.genreCount).toBe(app.listGroups('genre').length);
    expect(summary.albumCount).toBeGreaterThan(0);
  });

  it('every track is in exactly one album and one artist group; group counts add up', async () => {
    await populated();
    for (const kind of ['album', 'artist'] as const) {
      const groups = app.listGroups(kind);
      expect(groups.reduce((sum, g) => sum + g.trackCount, 0)).toBe(4);
      for (const group of groups) {
        const detail = app.getGroup(kind, group.key);
        expect(detail.tracks).toHaveLength(group.trackCount);
        expect(detail.group.key).toBe(group.key);
      }
    }
  });

  it('getGroup applies a sort when asked and throws group-not-found for a vanished group', async () => {
    await populated();
    const everyone = app.listGroups('artist')[0]!;
    const natural = app.getGroup('artist', everyone.key).tracks;
    expect(app.getGroup('artist', everyone.key, { field: 'title', direction: 'desc' }).tracks).toHaveLength(natural.length);
    await expectCode(() => app.getGroup('album', 'does-not-exist'), 'group-not-found');
    await expectCode(() => app.getGroup('genre', everyone.key), 'group-not-found');
  });

  it('an empty library has empty groups and a zero summary', () => {
    make();
    expect(app.getSummary()).toEqual({ trackCount: 0, albumCount: 0, artistCount: 0, genreCount: 0 });
    expect(app.listGroups('genre')).toEqual([]);
  });

  it('groups follow the library: removing a root removes its tracks from the counts', async () => {
    await populated();
    const [root] = await app.listRoots();
    await app.removeRoot(root!.id);
    expect(app.getSummary().trackCount).toBe(0);
  });
});

describe('startup policy (Phase 5)', () => {
  it('with no roots it does nothing: no scan, no watcher', async () => {
    make();
    const report = await app.startup();
    expect(report).toEqual({ rootCount: 0, availableRoots: 0, unavailableRoots: 0, watching: false, scanStarted: false });
    expect(app.getScanState().active).toBeUndefined();
    expect(app.getWatcherStatus().running).toBe(false);
  });

  it('starts the watcher and one reconciliation scan over the available roots, returning at once', async () => {
    make();
    const music = folder('Music');
    put(music, 'a.mp3', FULL);
    await app.addRoot(music);
    const report = await app.startup();
    expect(report).toMatchObject({ rootCount: 1, availableRoots: 1, unavailableRoots: 0, watching: true, scanStarted: true });
    expect(app.getWatcherStatus().running).toBe(true);
    await waitFor(finished, 'the startup scan to finish');
    expect(app.listTracks()).toHaveLength(1);
    expect(events).toContainEqual({ type: 'library-changed', reason: 'scan' });
  });

  it('picks up changes made while the app was closed (incremental reconcile): added, removed and unchanged', async () => {
    make();
    const music = folder('Music');
    const keep = put(music, 'keep.mp3', FULL);
    const gone = put(music, 'gone.mp3', PARTIAL);
    await app.addRoot(music);
    await scanAll(app);
    expect(app.listTracks()).toHaveLength(2);
    await app.dispose();
    fs.rmSync(gone);
    put(music, 'new.flac', UNICODE);
    events = [];
    make();
    await app.startup();
    await waitFor(finished, 'startup scan');
    const result = (events.find((e) => e.type === 'scan-finished') as Extract<LibraryApplicationEvent, { type: 'scan-finished' }>).result;
    expect(result.roots[0]?.counts).toMatchObject({ added: 1, removed: 1, skipped: 1 });
    expect(fs.existsSync(keep)).toBe(true);
    expect(app.listTracks()).toHaveLength(2);
  });

  it('skips an unavailable root: no failure result, its tracks are kept, the available root is still scanned', async () => {
    make();
    const here = folder('Here');
    const away = folder('Away');
    put(here, 'h.mp3', FULL);
    put(away, 'a.mp3', PARTIAL);
    await app.addRoot(here);
    await app.addRoot(away);
    await scanAll(app);
    expect(app.listTracks()).toHaveLength(2);
    await app.dispose();
    const parked = `${away}-parked`;
    fs.renameSync(away, parked); // "unplug the drive"
    events = [];
    make();
    const report = await app.startup();
    expect(report).toMatchObject({ rootCount: 2, availableRoots: 1, unavailableRoots: 1, scanStarted: true });
    await waitFor(finished, 'startup scan');
    const result = (events.find((e) => e.type === 'scan-finished') as Extract<LibraryApplicationEvent, { type: 'scan-finished' }>).result;
    expect(result.status).toBe('completed');
    expect(app.listTracks()).toHaveLength(2); // the unplugged drive's tracks are NOT removed
    const roots = await app.listRoots();
    expect(roots.filter((r) => !r.available)).toHaveLength(1);
    // plugging it back in and starting up again reconciles it
    fs.renameSync(parked, away);
    await app.dispose();
    events = [];
    make();
    expect((await app.startup()).unavailableRoots).toBe(0);
    await waitFor(finished, 'second startup scan');
  });

  it('with every root unavailable it only watches (and reports); it starts no scan', async () => {
    make();
    const music = folder('Music');
    await app.addRoot(music);
    await app.dispose();
    fs.rmSync(music, { recursive: true });
    make();
    const report = await app.startup();
    expect(report).toMatchObject({ rootCount: 1, availableRoots: 0, unavailableRoots: 1, scanStarted: false });
    expect(app.getScanState().active).toBeUndefined();
  });

  it('never starts a second scan or watcher: a scan already running, or a second call, is left alone', async () => {
    make();
    const music = folder('Music');
    for (let i = 0; i < 20; i += 1) put(music, `t${i}.mp3`, FULL);
    await app.addRoot(music);
    app.startScan({});
    const duringScan = await app.startup();
    expect(duringScan.scanStarted).toBe(false);
    await waitFor(finished, 'the manual scan');
    const first = await app.startup();
    const second = await app.startup();
    expect(first.scanStarted).toBe(true);
    expect(second.scanStarted).toBe(false); // the first startup scan is still running or just finished: never two at once
    expect(app.getWatcherStatus().running).toBe(true);
    await waitFor(() => app.getScanState().active === undefined, 'scans to settle');
  });

  it('a library application that is closed refuses to start up', async () => {
    make();
    await app.dispose();
    await expect(app.startup()).rejects.toThrow();
  });
});
