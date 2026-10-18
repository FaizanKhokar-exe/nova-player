import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WatchFunction } from '../watching/folder-watcher.js';
import { createLibraryServices, type LibraryServices } from './library-services.js';

/**
 * Phase 2 end to end, through the composition root, on the real disk and a
 * real SQLite file: filesystem -> metadata -> domain Track -> repository ->
 * SQLite, driven by scans and by the folder watcher.
 */
const fixtureDir = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../tests/fixtures/metadata');
const FULL = 'full-tags.mp3';
const UNICODE = 'unicode-tags.flac';
const NO_TAGS = 'No Tags Artist - No Tags Title.mp3';
const PARTIAL = 'Partial Tags.mp3';

let dir: string;
let library: string;
let dbPath: string;
let services: LibraryServices | undefined;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nova-phase2-')));
  library = path.join(dir, 'My Music');
  fs.mkdirSync(library);
  dbPath = path.join(dir, 'userData', 'nova.db');
  services = undefined;
});
afterEach(async () => {
  await services?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function open(): LibraryServices {
  services = createLibraryServices({ databasePath: dbPath });
  return services;
}
function put(relative: string, fixture: string): string {
  const target = path.join(library, ...relative.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(fixtureDir, fixture), target);
  return target;
}
async function waitFor(condition: () => boolean, description: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
const names = (s: LibraryServices): string[] => s.trackRepository.list().map((t) => path.basename(t.sourcePath)).sort();

describe('Phase 2 pipeline through the composition root', () => {
  it('scans a mixed library into SQLite: tags, filename fallback, unicode, nested folders, junk ignored', async () => {
    put('Rock/full.mp3', FULL);
    put('音楽/夜に駆ける.flac', UNICODE);
    put('Misc/' + NO_TAGS, NO_TAGS);
    put('Misc/Deep/partial.mp3', PARTIAL);
    fs.writeFileSync(path.join(library, 'notes.txt'), 'x');
    fs.writeFileSync(path.join(library, 'broken.mp3'), Buffer.alloc(2000, 0x41));

    const s = open();
    const result = await s.scanner.scan({ root: library });
    expect(result).toMatchObject({ status: 'completed', discovered: 5, added: 4, failed: 1 });

    const byFile = new Map(s.trackRepository.list().map((t) => [path.basename(t.sourcePath), t]));
    expect(byFile.get('full.mp3')).toMatchObject({ title: 'Full Tags Song', titleSource: 'tag', trackNumber: 3, year: 1999, artwork: { kind: 'embedded' } });
    expect(byFile.get('夜に駆ける.flac')?.title).toBe('夜に駆ける – Ünïcödé 🎵');
    expect(byFile.get(NO_TAGS)).toMatchObject({ title: 'No Tags Title', titleSource: 'filename', artist: 'No Tags Artist' });
    expect(byFile.get('partial.mp3')).toMatchObject({ title: 'Only A Title', artistSource: 'unknown' });
    expect(byFile.has('broken.mp3')).toBe(false);
  });

  it('the library survives an app restart: TrackIds are stable and the next scan re-reads nothing', async () => {
    put('a.mp3', FULL);
    put('b.flac', UNICODE);
    const first = open();
    await first.scanner.scan({ root: library });
    const before = first.trackRepository.list();
    await first.close();

    const second = open();
    expect(second.trackRepository.list()).toEqual(before); // same rows, same ids, after reopening the file
    expect(await second.scanner.scan({ root: library })).toMatchObject({ discovered: 2, skipped: 2, added: 0, updated: 0, removed: 0 });
    expect(second.trackRepository.list()).toEqual(before);
  });

  it('changes made while the app was closed are reconciled on the next start', async () => {
    const a = put('a.mp3', FULL);
    put('b.flac', UNICODE);
    const first = open();
    await first.scanner.scan({ root: library });
    const idOfB = first.trackRepository.list().find((t) => t.sourcePath.endsWith('b.flac'))?.id;
    await first.close();

    fs.rmSync(a); // deleted
    put('c.mp3', PARTIAL); // added
    const second = open();
    expect(await second.scanner.scan({ root: library })).toMatchObject({ added: 1, removed: 1, skipped: 1 });
    expect(names(second)).toEqual(['b.flac', 'c.mp3']);
    expect(second.trackRepository.getById(idOfB!)).toBeDefined(); // untouched track kept its identity
  });

  it('uses exactly one persistence mechanism: a single SQLite file, and nothing is left behind after close', async () => {
    put('a.mp3', FULL);
    const s = open();
    await s.scanner.scan({ root: library });
    await s.close();
    expect(fs.readdirSync(path.dirname(dbPath))).toEqual(['nova.db']); // no -wal/-shm, no side stores
  });

  it('does not expose the raw database connection', () => {
    const s = open();
    expect(Object.keys(s).sort()).toEqual(
      ['attachedLyricsRepository', 'close', 'createFolderWatcher', 'databasePath', 'favoritesRepository', 'fileSystem', 'historyRepository', 'libraryRootRepository', 'metadataReader', 'playbackSessionRepository', 'playlistRepository', 'scanner', 'trackRepository'],
    );
  });
});

describe('Phase 2 watcher through the composition root (real fs.watch)', () => {
  const quick = { debounceMs: 150, reconcileIntervalMs: 0 };

  it('picks up added, modified, nested and deleted files without any manual scan', async () => {
    put('existing.mp3', FULL);
    const s = open();
    await s.scanner.scan({ root: library });
    const watcher = s.createFolderWatcher(quick);
    const report = watcher.start([library]);
    expect(report.failed).toEqual([]);

    // added, in a brand-new nested folder
    put('New Album/Disc 1/track.flac', UNICODE);
    await waitFor(() => names(s).includes('track.flac'), 'nested file to be added');

    // modified: overwritten with different content
    fs.copyFileSync(path.join(fixtureDir, NO_TAGS), path.join(library, 'existing.mp3'));
    // The new content carries no tags, so the domain falls back to the FILE name ("existing"), not the old tag title.
    await waitFor(
      () => s.trackRepository.list().some((t) => t.sourcePath.endsWith('existing.mp3') && t.titleSource === 'filename' && t.title === 'existing'),
      'file to be re-read',
    );
    expect(s.trackRepository.list()).toHaveLength(2); // updated in place, not duplicated

    // deleted
    fs.rmSync(path.join(library, 'New Album'), { recursive: true });
    await waitFor(() => !names(s).includes('track.flac'), 'deleted folder to be reconciled');
    expect(names(s)).toEqual(['existing.mp3']);

    await watcher.stop();
  });

  it('a burst of many files copied at once is reconciled correctly (debounced, targeted)', async () => {
    const s = open();
    await s.scanner.scan({ root: library });
    const reconciled: number[] = [];
    const watcher = s.createFolderWatcher({ ...quick, onReconciled: (e) => reconciled.push(e.result.added) });
    watcher.start([library]);

    for (let i = 0; i < 12; i += 1) put(`Album/t${String(i).padStart(2, '0')}.mp3`, FULL);
    await waitFor(() => s.trackRepository.list().length === 12, 'all 12 files to be added');
    expect(reconciled.reduce((a, b) => a + b, 0)).toBe(12);
    expect(reconciled.filter((n) => n > 0).length).toBeLessThan(12); // far fewer scans than raw events
    await watcher.stop();
  });

  it('ignores non-audio files', async () => {
    put('a.mp3', FULL);
    const s = open();
    await s.scanner.scan({ root: library });
    const reconciled: number[] = [];
    const watcher = s.createFolderWatcher({ ...quick, onReconciled: () => reconciled.push(1) });
    watcher.start([library]);
    fs.writeFileSync(path.join(library, 'notes.txt'), 'hello');
    await waitFor(() => reconciled.length > 0, 'the watcher to look at the new file');
    expect(names(s)).toEqual(['a.mp3']);
    await watcher.stop();
  });

  it('periodic reconciliation finds changes even when the OS delivers no events at all', async () => {
    const s = open();
    await s.scanner.scan({ root: library });
    const deaf: WatchFunction = () => ({ close: () => undefined }); // a watch that never reports anything
    const watcher = s.createFolderWatcher({ watch: deaf, debounceMs: 50, reconcileIntervalMs: 150 });
    watcher.start([library]);

    put('late.mp3', FULL);
    await waitFor(() => names(s).includes('late.mp3'), 'periodic reconcile to find the file');
    fs.rmSync(path.join(library, 'late.mp3'));
    put('other.flac', UNICODE); // keep the root non-empty
    await waitFor(() => !names(s).includes('late.mp3'), 'periodic reconcile to notice the deletion');
    await watcher.stop();
  });

  it('after stop(), later changes are not processed', async () => {
    const s = open();
    await s.scanner.scan({ root: library });
    const watcher = s.createFolderWatcher(quick);
    watcher.start([library]);
    await watcher.stop();
    put('after-stop.mp3', FULL);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(names(s)).toEqual([]);
  });

  it('watches several library roots at once', async () => {
    const second = path.join(dir, 'Other Music');
    fs.mkdirSync(second);
    const s = open();
    const watcher = s.createFolderWatcher(quick);
    expect(watcher.start([library, second]).watching).toEqual([library, second]);
    put('one.mp3', FULL);
    fs.copyFileSync(path.join(fixtureDir, UNICODE), path.join(second, 'two.flac'));
    await waitFor(() => names(s).length === 2, 'both roots to be reconciled');
    expect(names(s)).toEqual(['one.mp3', 'two.flac']);
    await watcher.stop();
  });

  it('a root that does not exist is reported at start and does not stop the others', async () => {
    const s = open();
    const errors: string[] = [];
    const watcher = s.createFolderWatcher({ ...quick, onError: (e) => errors.push(e.root) });
    const report = watcher.start([path.join(dir, 'unplugged-drive'), library]);
    expect(report.watching).toEqual([library]);
    expect(report.failed).toHaveLength(1);
    expect(errors).toEqual([path.join(dir, 'unplugged-drive')]);
    await watcher.stop();
  });
});

describe('Phase 2 shutdown', () => {
  it('close() stops watchers, aborts a running scan, and only then closes the database', async () => {
    for (let i = 0; i < 40; i += 1) put(`t${i}.mp3`, FULL);
    const s = open();
    const watcher = s.createFolderWatcher({ debounceMs: 50, reconcileIntervalMs: 0 });
    watcher.start([library]);

    const scan = s.scanner.scan({ root: library });
    await s.close(); // while the scan is running
    const result = await scan; // settles; never touches a closed database
    expect(['completed', 'cancelled']).toContain(result.status);
    expect(watcher.isRunning).toBe(false);

    // The file is a valid database with only whole tracks in it.
    const reopened = open();
    expect(reopened.trackRepository.list().every((t) => t.title === 'Full Tags Song')).toBe(true);
  });

  it('close() is idempotent and concurrent calls share one shutdown', async () => {
    const s = open();
    await Promise.all([s.close(), s.close()]);
    await s.close();
  });

  it('after close(), new work is refused or cancelled - never run against a closed database', async () => {
    put('a.mp3', FULL);
    const s = open();
    await s.close();
    expect(() => s.createFolderWatcher()).toThrow(/closed/);
    expect(await s.scanner.scan({ root: library })).toMatchObject({ status: 'cancelled', added: 0 });
  });

  it('a caller-supplied abort signal and the shutdown signal both cancel a scan', async () => {
    for (let i = 0; i < 6; i += 1) put(`t${i}.mp3`, FULL);
    const s = open();
    const controller = new AbortController();
    controller.abort();
    expect(await s.scanner.scan({ root: library, signal: controller.signal })).toMatchObject({ status: 'cancelled' });
  });
});
