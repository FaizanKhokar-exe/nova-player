import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp } from './helpers.js';

/**
 * Phase 3 half 1: the REAL boundary. These tests drive the real Electron app
 * through `window.nova` exactly as a renderer would - nothing in main is
 * mocked except the native folder picker, which cannot be operated by a test.
 */
const fixtureDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/metadata');

type Ok<T = unknown> = { ok: true; value: T };
type Fail = { ok: false; error: { code: string; message: string; operation: string } };
type Result<T = unknown> = Ok<T> | Fail;

function invoke<T = unknown>(window: Page, channel: string, request?: unknown): Promise<Result<T>> {
  return window.evaluate(([c, r]) => (window as never as { nova: { invoke(c: string, r: unknown): Promise<unknown> } }).nova.invoke(c as string, r), [channel, request] as const) as Promise<Result<T>>;
}
async function ok<T>(window: Page, channel: string, request?: unknown): Promise<T> {
  const result = await invoke<T>(window, channel, request);
  if (!result.ok) throw new Error(`${channel} failed: ${result.error.code} - ${result.error.message}`);
  return result.value;
}

/** Records every event the renderer receives, in `window.__novaEvents`. */
async function recordEvents(window: Page): Promise<void> {
  await window.evaluate(() => {
    const w = window as never as { __novaEvents: { channel: string; payload: unknown }[]; nova: { subscribe(c: string, l: (p: unknown) => void): () => void } };
    w.__novaEvents = [];
    for (const channel of ['library:scanProgress', 'library:scanFinished', 'library:changed', 'library:watcherStatus']) {
      w.nova.subscribe(channel, (payload) => w.__novaEvents.push({ channel, payload }));
    }
  });
}
const events = (window: Page, channel: string): Promise<{ payload: Record<string, unknown> }[]> =>
  window.evaluate((c) => (window as never as { __novaEvents: { channel: string; payload: Record<string, unknown> }[] }).__novaEvents.filter((e) => e.channel === c), channel);

/** The OS folder picker cannot be driven by a test, so the main process's `dialog.showOpenDialog` is told what the "user" picks. */
async function pickFolders(app: ElectronApplication, ...folders: (string | undefined)[]): Promise<void> {
  await app.evaluate(({ dialog }, queue) => {
    const remaining = [...queue];
    (dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = async () => {
      const next = remaining.shift();
      return next === undefined ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [next] };
    };
  }, folders);
}

function makeLibrary(parent: string, name: string, files: Record<string, string>): string {
  const root = path.join(parent, name);
  for (const [relative, fixture] of Object.entries(files)) {
    const target = path.join(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(fixtureDir, fixture), target);
  }
  fs.mkdirSync(root, { recursive: true });
  return root;
}

let sandbox: string;
test.beforeEach(() => {
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nova-e2e-ipc-')));
});
test.afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test('the renderer sees only window.nova.{invoke,subscribe} - no Node, no Electron, no ipcRenderer', async () => {
  const { app, window } = await launchApp({ userDataDir: path.join(sandbox, 'userData') });

  const surface = await window.evaluate(() => {
    const w = window as never as Record<string, unknown> & { nova: Record<string, unknown> };
    return {
      novaKeys: Object.keys(w.nova).sort(),
      require: typeof w['require'],
      process: typeof w['process'],
      module: typeof w['module'],
      buffer: typeof w['Buffer'],
      electron: typeof w['electron'],
      ipcRenderer: typeof w['ipcRenderer'],
      novaIpcRenderer: typeof w.nova['ipcRenderer'],
      novaSend: typeof w.nova['send'],
      novaOn: typeof w.nova['on'],
    };
  });
  expect(surface).toEqual({
    novaKeys: ['invoke', 'subscribe'],
    require: 'undefined', process: 'undefined', module: 'undefined', buffer: 'undefined',
    electron: 'undefined', ipcRenderer: 'undefined', novaIpcRenderer: 'undefined', novaSend: 'undefined', novaOn: 'undefined',
  });

  // An unknown channel never reaches the main process.
  const rejection = await window.evaluate(async () => {
    try {
      await (window as never as { nova: { invoke(c: string, r?: unknown): Promise<unknown> } }).nova.invoke('library:deleteEverything');
      return 'resolved';
    } catch (error) {
      return (error as Error).message;
    }
  });
  expect(rejection).toContain('Unknown IPC channel');
  const badSubscribe = await window.evaluate(() => {
    try {
      (window as never as { nova: { subscribe(c: string, l: () => void): void } }).nova.subscribe('app:ping', () => undefined);
      return 'subscribed';
    } catch (error) {
      return (error as Error).message;
    }
  });
  expect(badSubscribe).toContain('Unknown IPC event');

  // The Phase 0 channels still work through the same bridge.
  const ping = await window.evaluate(() => (window as never as { nova: { invoke(c: string, r: unknown): Promise<{ pong: boolean }> } }).nova.invoke('app:ping', { nonce: 'n' }));
  expect(ping.pong).toBe(true);
  await app.close();
});

test('library roots through the bridge: add via the (main-process) picker, list, reject duplicates, cancel, remove', async () => {
  const { app, window } = await launchApp({ userDataDir: path.join(sandbox, 'userData') });
  const music = makeLibrary(sandbox, 'Music', { 'a.mp3': 'full-tags.mp3' });
  await recordEvents(window);

  expect(await ok(window, 'library:listRoots')).toEqual({ roots: [] });

  // A cancelled picker adds nothing.
  await pickFolders(app, undefined);
  expect(await ok(window, 'library:addRoot')).toEqual({ outcome: 'cancelled' });

  await pickFolders(app, music, music, path.join(sandbox, 'does-not-exist'));
  const added = await ok<{ outcome: string; root: { id: string; path: string; available: boolean; trackCount: number; watched: boolean } }>(window, 'library:addRoot');
  expect(added.outcome).toBe('added');
  expect(added.root).toMatchObject({ path: music, available: true, trackCount: 0, watched: false });
  expect(await ok(window, 'library:listRoots')).toEqual({ roots: [added.root] });
  expect((await events(window, 'library:changed')).map((e) => e.payload)).toContainEqual({ reason: 'root-added' });

  // The same folder again, and a missing one: coded, serializable errors.
  expect(await invoke(window, 'library:addRoot')).toEqual({ ok: false, error: { code: 'root-exists', message: expect.any(String), operation: 'library:addRoot' } });
  expect(await invoke(window, 'library:addRoot')).toMatchObject({ ok: false, error: { code: 'root-unavailable' } });

  // The renderer cannot smuggle a path into addRoot.
  expect(await invoke(window, 'library:addRoot', { path: sandbox })).toMatchObject({ ok: false, error: { code: 'invalid-request' } });

  // Validation and unknown ids.
  expect(await invoke(window, 'library:removeRoot', { rootId: 'nope' })).toMatchObject({ ok: false, error: { code: 'invalid-request' } });
  expect(await invoke(window, 'library:removeRoot', { rootId: '123e4567-e89b-42d3-a456-426614174000' })).toMatchObject({ ok: false, error: { code: 'root-not-found' } });

  expect(await ok(window, 'library:removeRoot', { rootId: added.root.id })).toEqual({ removedTracks: 0 });
  expect(await ok(window, 'library:listRoots')).toEqual({ roots: [] });
  expect(fs.existsSync(path.join(music, 'a.mp3'))).toBe(true); // the user's files are never touched
  await app.close();
});

test('scan lifecycle through the bridge: progress events, final result, tracks, search, incremental rescan, errors serializable', async () => {
  const { app, window } = await launchApp({ userDataDir: path.join(sandbox, 'userData') });
  const music = makeLibrary(sandbox, 'Music', {
    'Rock/full.mp3': 'full-tags.mp3',
    '音楽/夜に駆ける.flac': 'unicode-tags.flac',
    'Misc/partial.mp3': 'Partial Tags.mp3',
    'Misc/No Tags Artist - No Tags Title.mp3': 'No Tags Artist - No Tags Title.mp3',
  });
  fs.writeFileSync(path.join(music, 'broken.mp3'), Buffer.alloc(800, 0x41));
  fs.writeFileSync(path.join(music, 'notes.txt'), 'ignored');
  await recordEvents(window);

  // No roots yet: nothing to scan.
  expect(await invoke(window, 'library:startScan', {})).toMatchObject({ ok: false, error: { code: 'no-roots' } });

  await pickFolders(app, music);
  const { root } = await ok<{ root: { id: string } }>(window, 'library:addRoot');

  const started = await ok<{ scanId: string; rootCount: number }>(window, 'library:startScan', {});
  expect(started.rootCount).toBe(1);
  await expect.poll(async () => (await events(window, 'library:scanFinished')).length, { timeout: 15_000 }).toBe(1);

  const finished = (await events(window, 'library:scanFinished'))[0]!.payload as { scanId: string; status: string; roots: { rootId: string; counts: Record<string, number>; failureCount: number; failures: { kind: string }[] }[] };
  expect(finished).toMatchObject({ scanId: started.scanId, status: 'completed' });
  expect(finished.roots[0]).toMatchObject({ rootId: root.id, failureCount: 1 });
  expect(finished.roots[0]!.counts).toMatchObject({ discovered: 5, added: 4, failed: 1 });
  expect(finished.roots[0]!.failures[0]!.kind).toBe('unreadable-media');

  const progress = await events(window, 'library:scanProgress');
  expect(progress.length).toBeGreaterThan(0);
  expect(progress.every((e) => e.payload.scanId === started.scanId && e.payload.rootId === root.id)).toBe(true);
  expect(progress.map((e) => e.payload.phase)).toContain('reading');
  expect((await events(window, 'library:changed')).map((e) => e.payload)).toContainEqual({ reason: 'scan' });

  // Late subscribers can ask for the state instead of having seen the events.
  const state = await ok<{ active?: unknown; last?: { scanId: string; status: string } }>(window, 'library:getScanState');
  expect(state.active).toBeUndefined();
  expect(state.last).toMatchObject({ scanId: started.scanId, status: 'completed' });

  // Track listing: DTOs only - no file paths cross the boundary.
  const listing = await ok<{ total: number; tracks: { title: string; artwork: string }[] }>(window, 'library:listTracks', {});
  expect(listing.total).toBe(4);
  expect(listing.tracks.map((t) => t.title)).toEqual(['Full Tags Song', 'No Tags Title', 'Only A Title', '夜に駆ける – Ünïcödé 🎵']);
  expect(listing.tracks.find((t) => t.title === 'Full Tags Song')!.artwork).toBe('embedded');
  const raw = JSON.stringify(listing);
  expect(raw).not.toContain(sandbox);
  expect(raw).not.toContain('sourcePath');
  const page = await ok<{ total: number; offset: number; tracks: unknown[] }>(window, 'library:listTracks', { offset: 1, limit: 2 });
  expect(page).toMatchObject({ total: 4, offset: 1 });
  expect(page.tracks).toHaveLength(2);

  // Search is the domain's Phase 1 search, executed in main.
  const search = await ok<{ total: number; results: { track: { title: string }; match: { kind: string } }[] }>(window, 'library:search', { query: 'TAGGED' });
  expect(search.results[0]).toMatchObject({ track: { title: 'Full Tags Song' }, match: { kind: 'field' } });
  expect(JSON.stringify(search)).not.toContain(sandbox);
  expect(await ok(window, 'library:search', { query: '   ' })).toEqual({ query: '   ', total: 0, results: [] });
  expect(await invoke(window, 'library:search', { query: 5 })).toMatchObject({ ok: false, error: { code: 'invalid-request' } });
  expect(await invoke(window, 'library:search', { query: 'x', limit: 999_999 })).toMatchObject({ ok: false, error: { code: 'invalid-request' } });

  // Roots now report their tracks; a rescan re-reads nothing.
  expect(await ok(window, 'library:listRoots')).toMatchObject({ roots: [{ trackCount: 4, available: true }] });
  await window.evaluate(() => ((window as never as { __novaEvents: unknown[] }).__novaEvents.length = 0));
  await ok(window, 'library:startScan', { rootId: root.id });
  await expect.poll(async () => (await events(window, 'library:scanFinished')).length, { timeout: 15_000 }).toBe(1);
  const second = (await events(window, 'library:scanFinished'))[0]!.payload as { roots: { counts: Record<string, number> }[] };
  expect(second.roots[0]!.counts).toMatchObject({ skipped: 4, failed: 1, added: 0, updated: 0 }); // the broken file is retried and reported each time

  // Removing the root removes its tracks, atomically.
  expect(await ok(window, 'library:removeRoot', { rootId: root.id })).toEqual({ removedTracks: 4 });
  expect(await ok(window, 'library:listTracks', {})).toMatchObject({ total: 0, tracks: [] });
  await app.close();
});

test('scan cancellation through the bridge: cancelled result, valid library, rescan resumes', async () => {
  const { app, window } = await launchApp({ userDataDir: path.join(sandbox, 'userData') });
  const files: Record<string, string> = {};
  for (let i = 0; i < 400; i += 1) files[`d${i % 20}/t${String(i).padStart(3, '0')}.mp3`] = 'full-tags.mp3';
  const music = makeLibrary(sandbox, 'Big', files);
  await recordEvents(window);
  await pickFolders(app, music);
  await ok(window, 'library:addRoot');

  expect(await ok(window, 'library:cancelScan')).toEqual({ cancelled: false }); // nothing running
  await ok(window, 'library:startScan', {});
  // A second scan while one runs is refused with a stable code.
  expect(await invoke(window, 'library:startScan', {})).toMatchObject({ ok: false, error: { code: 'scan-running' } });
  expect(await ok(window, 'library:cancelScan')).toEqual({ cancelled: true });
  await expect.poll(async () => (await events(window, 'library:scanFinished')).length, { timeout: 15_000 }).toBe(1);

  const result = (await events(window, 'library:scanFinished'))[0]!.payload as { status: string; roots: { counts: Record<string, number> }[] };
  expect(result.status).toBe('cancelled');
  const saved = (await ok<{ total: number }>(window, 'library:listTracks', {})).total;
  expect(saved).toBeLessThan(400);
  expect(result.roots[0]!.counts.added).toBe(saved); // every reported addition is a whole, stored track

  // The library is valid and the next scan resumes.
  await window.evaluate(() => ((window as never as { __novaEvents: unknown[] }).__novaEvents.length = 0));
  await ok(window, 'library:startScan', {});
  await expect.poll(async () => (await events(window, 'library:scanFinished')).length, { timeout: 30_000 }).toBe(1);
  expect(((await events(window, 'library:scanFinished'))[0]!.payload as { status: string }).status).toBe('completed');
  expect((await ok<{ total: number }>(window, 'library:listTracks', {})).total).toBe(400);
  await app.close();
});

test('watcher lifecycle through the bridge: start, a real file change is reconciled, stop', async () => {
  const { app, window } = await launchApp({ userDataDir: path.join(sandbox, 'userData') });
  const music = makeLibrary(sandbox, 'Music', { 'a.mp3': 'full-tags.mp3' });
  await recordEvents(window);
  await pickFolders(app, music);
  const { root } = await ok<{ root: { id: string } }>(window, 'library:addRoot');
  await ok(window, 'library:startScan', {});
  await expect.poll(async () => (await events(window, 'library:scanFinished')).length, { timeout: 15_000 }).toBe(1);

  expect(await ok(window, 'library:getWatcherStatus')).toMatchObject({ running: false, roots: [] });
  const status = await ok<{ running: boolean; roots: { rootId: string; state: string }[] }>(window, 'library:startWatching');
  expect(status).toMatchObject({ running: true, roots: [{ rootId: root.id, state: 'watching' }] });
  expect(await ok(window, 'library:startWatching')).toMatchObject({ running: true }); // idempotent
  expect(await ok(window, 'library:listRoots')).toMatchObject({ roots: [{ watched: true }] });

  await window.evaluate(() => ((window as never as { __novaEvents: unknown[] }).__novaEvents.length = 0));
  fs.copyFileSync(path.join(fixtureDir, 'unicode-tags.flac'), path.join(music, 'new.flac'));
  await expect.poll(async () => (await ok<{ total: number }>(window, 'library:listTracks', {})).total, { timeout: 15_000 }).toBe(2);
  await expect.poll(async () => (await events(window, 'library:changed')).some((e) => e.payload.reason === 'watcher'), { timeout: 15_000 }).toBe(true);
  expect(await ok(window, 'library:getWatcherStatus')).toMatchObject({ running: true, lastReconcile: { status: 'completed' } });
  expect((await events(window, 'library:watcherStatus')).length).toBeGreaterThan(0);

  expect(await ok(window, 'library:stopWatching')).toMatchObject({ running: false, roots: [] });
  expect(await ok(window, 'library:stopWatching')).toMatchObject({ running: false }); // idempotent
  await app.close();
});

test('roots and tracks persist across an app restart, and a relaunch is shut down cleanly', async () => {
  const userData = path.join(sandbox, 'userData');
  const music = makeLibrary(sandbox, 'Music', { 'a.mp3': 'full-tags.mp3', 'b.flac': 'unicode-tags.flac' });

  const first = await launchApp({ userDataDir: userData });
  await pickFolders(first.app, music);
  const { root } = await ok<{ root: { id: string; path: string } }>(first.window, 'library:addRoot');
  await recordEvents(first.window);
  await ok(first.window, 'library:startScan', {});
  await expect.poll(async () => (await events(first.window, 'library:scanFinished')).length, { timeout: 15_000 }).toBe(1);
  await ok(first.window, 'library:startWatching');
  await first.app.close(); // quits with a watcher running

  const second = await launchApp({ userDataDir: userData });
  expect(await ok(second.window, 'library:listRoots')).toMatchObject({ roots: [{ id: root.id, path: root.path, trackCount: 2, available: true, watched: false }] });
  expect((await ok<{ total: number }>(second.window, 'library:listTracks', {})).total).toBe(2);
  expect(await ok(second.window, 'library:getWatcherStatus')).toMatchObject({ running: false }); // nothing is started automatically
  await second.app.close();

  expect(fs.readdirSync(path.join(userData, 'library'))).toEqual(['nova.db']); // clean close: no WAL leftovers
});
