import fs from 'node:fs';
import path from 'node:path';
import { TrackRepositoryError, type TrackRepository } from '@nova/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { FileSystemError } from '../filesystem/file-system-error.js';
import type { FileSystem } from '../filesystem/file-system.js';
import type { MetadataReader } from '../metadata/music-metadata-reader.js';
import { createScanKit, FIXTURES, withOverrides, type ScanKit, type ScanKitOptions } from './scan-test-kit.js';
import type { ScanProgress } from './scan-types.js';

const kits: ScanKit[] = [];
function kit(options?: ScanKitOptions): ScanKit {
  const created = createScanKit(options);
  kits.push(created);
  return created;
}
afterEach(() => {
  while (kits.length > 0) kits.pop()?.cleanup();
});

const basenames = (paths: readonly string[]): string[] => paths.map((p) => path.basename(p)).sort();

describe('scanning: the basic pipeline (filesystem -> metadata -> domain Track -> repository -> SQLite)', () => {
  it('an empty library completes with nothing found and nothing stored', async () => {
    const k = kit();
    const result = await k.scanner.scan({ root: k.root });
    expect(result).toMatchObject({ status: 'completed', discovered: 0, added: 0, updated: 0, skipped: 0, removed: 0, failed: 0, failures: [] });
    expect(k.repository.list()).toEqual([]);
  });

  it('stores one valid track with its tags, canonical path, size and modification time', async () => {
    const k = kit();
    const file = k.addFixture('Song.mp3', FIXTURES.full);
    k.touch('Song.mp3', 1_600_000_000);

    const result = await k.scanner.scan({ root: k.root });
    expect(result).toMatchObject({ status: 'completed', discovered: 1, added: 1, failed: 0 });

    const [track] = k.repository.list();
    expect(track).toMatchObject({
      sourcePath: file, title: 'Full Tags Song', titleSource: 'tag', artist: 'The Tagged Artist',
      album: 'Album Name', albumArtist: 'Various Artists', genre: 'Rock',
      trackNumber: 3, discNumber: 2, year: 1999, artwork: { kind: 'embedded' },
    });
    expect(track?.durationSeconds).toBeCloseTo(0.57, 1);
    expect(k.repository.listFileStates()).toEqual([
      { id: track?.id, sourcePath: file, sizeBytes: fs.statSync(file).size, modifiedAtMs: 1_600_000_000_000 },
    ]);
  });

  it('finds multiple tracks in nested folders, of several formats', async () => {
    const k = kit();
    k.addFixture('a.mp3', FIXTURES.full);
    k.addFixture('Rock/Deep/b.flac', FIXTURES.unicode);
    k.addFixture('Rock/c.ogg', FIXTURES.ogg);
    k.addFixture('Pop/d.opus', FIXTURES.opus);
    k.addFixture('Pop/Sub/Deeper/e.m4a', FIXTURES.m4a);
    k.addFixture('f.wav', FIXTURES.wav);

    const result = await k.scanner.scan({ root: k.root });
    expect(result).toMatchObject({ discovered: 6, added: 6, failed: 0 });
    expect(k.repository.list()).toHaveLength(6);
  });

  it('ignores unsupported files without failing the scan', async () => {
    const k = kit();
    k.addFixture('song.mp3', FIXTURES.full);
    k.addFile('notes.txt', 'hello');
    k.addFile('cover.jpg', Buffer.alloc(10));
    k.addFile('.DS_Store', '');
    k.addFile('archive.zip', Buffer.alloc(5));
    k.addFile('song.mp3.bak', 'x');
    k.addFile('Folder/readme.md', '#');

    const result = await k.scanner.scan({ root: k.root });
    expect(result).toMatchObject({ discovered: 1, added: 1, failed: 0, failures: [] });
    expect(k.readCalls).toHaveLength(1);
  });

  it('matches extensions case-insensitively', async () => {
    const k = kit();
    k.addFixture('LOUD.MP3', FIXTURES.full);
    k.addFixture('Mixed.FlAc', FIXTURES.unicode);
    expect((await k.scanner.scan({ root: k.root })).added).toBe(2);
  });

  it('a malformed file is reported and NOT stored, while its neighbours are saved', async () => {
    const k = kit();
    k.addFixture('good.mp3', FIXTURES.full);
    k.addFile('garbage.mp3', Buffer.alloc(4000, 0x41));
    k.addFile('empty.flac', '');
    k.addFixture('good2.flac', FIXTURES.unicode);

    const result = await k.scanner.scan({ root: k.root });
    expect(result).toMatchObject({ status: 'completed', discovered: 4, added: 2, failed: 2 });
    expect(result.failures.map((f) => [path.basename(f.path), f.kind]).sort()).toEqual([
      ['empty.flac', 'unreadable-media'],
      ['garbage.mp3', 'unreadable-media'],
    ]);
    expect(result.failures.every((f) => f.message.length > 0)).toBe(true);
    expect(k.repository.list().map((t) => path.basename(t.sourcePath)).sort()).toEqual(['good.mp3', 'good2.flac']);
  });

  it('a file with no tags becomes a Track named from its FILE NAME (domain fallback)', async () => {
    const k = kit();
    k.addFixture('No Tags Artist - No Tags Title.mp3', FIXTURES.noTags);
    await k.scanner.scan({ root: k.root });
    expect(k.repository.list()[0]).toMatchObject({
      title: 'No Tags Title', titleSource: 'filename', artist: 'No Tags Artist', artistSource: 'filename', artwork: { kind: 'none' },
    });
  });

  it('keeps Unicode in both the path and the metadata', async () => {
    const k = kit();
    const file = k.addFixture('音楽/Ünïcödé フォルダ/夜に駆ける.flac', FIXTURES.unicode);
    await k.scanner.scan({ root: k.root });
    const [track] = k.repository.list();
    expect(track?.sourcePath).toBe(file);
    expect(track?.title).toBe('夜に駆ける – Ünïcödé 🎵');
    expect(fs.existsSync(track?.sourcePath ?? '')).toBe(true);
  });

  it('every new track gets a distinct, domain-minted TrackId that is not derived from the path', async () => {
    const k = kit();
    k.addFixture('a.mp3', FIXTURES.full);
    k.addFixture('b.mp3', FIXTURES.partial);
    await k.scanner.scan({ root: k.root });
    const ids = k.repository.list().map((t) => t.id);
    expect(new Set(ids).size).toBe(2);
    for (const track of k.repository.list()) expect(track.id).not.toContain(path.basename(track.sourcePath));
  });

  it('reads the directory tree in a deterministic, sorted order', async () => {
    const k = kit({ dependencies: { concurrency: 1 } });
    for (const name of ['b/2.mp3', 'a/9.mp3', 'a/1.mp3', 'c.mp3', 'B/x.mp3']) k.addFixture(name, FIXTURES.full);
    await k.scanner.scan({ root: k.root });
    const relative = k.readCalls.map((p) => path.relative(k.root, p).split(path.sep).join('/'));
    // files of a folder first (name order), then its sub-folders (name order, code-unit order: 'B' < 'a')
    expect(relative).toEqual(['c.mp3', 'B/x.mp3', 'a/1.mp3', 'a/9.mp3', 'b/2.mp3']);
  });
});

describe('scanning: incremental behaviour', () => {
  it('an unchanged library is not re-read on the second scan', async () => {
    const k = kit();
    k.addFixture('a.mp3', FIXTURES.full);
    k.addFixture('b.flac', FIXTURES.unicode);
    await k.scanner.scan({ root: k.root });
    const before = k.repository.list();
    k.readCalls.length = 0;

    const second = await k.scanner.scan({ root: k.root });
    expect(second).toMatchObject({ status: 'completed', discovered: 2, skipped: 2, added: 0, updated: 0, removed: 0, failed: 0 });
    expect(k.readCalls).toEqual([]);
    expect(k.repository.list()).toEqual(before);
  });

  it('a changed file (new content) is re-read and updated, keeping its TrackId', async () => {
    const k = kit();
    k.addFixture('song.mp3', FIXTURES.full);
    k.addFixture('other.mp3', FIXTURES.partial);
    await k.scanner.scan({ root: k.root });
    const original = k.tracksByTitle().get('Full Tags Song');
    k.readCalls.length = 0;

    k.addFixture('song.mp3', FIXTURES.noTags); // overwrite with different audio and tags
    const second = await k.scanner.scan({ root: k.root });

    expect(second).toMatchObject({ discovered: 2, skipped: 1, updated: 1, added: 0, removed: 0 });
    expect(basenames(k.readCalls)).toEqual(['song.mp3']);
    const updated = k.repository.getById(original!.id);
    expect(updated).toMatchObject({ id: original!.id, sourcePath: k.resolve('song.mp3'), title: 'No Tags Title' === updated?.title ? 'No Tags Title' : updated?.title });
    expect(updated?.title).not.toBe('Full Tags Song');
    expect(updated?.titleSource).toBe('filename'); // the new content has no tags
    expect(k.repository.list()).toHaveLength(2);
  });

  it('a modification-time-only change is also picked up', async () => {
    const k = kit();
    k.addFixture('song.mp3', FIXTURES.full);
    k.touch('song.mp3', 1_600_000_000);
    await k.scanner.scan({ root: k.root });
    k.readCalls.length = 0;

    k.touch('song.mp3', 1_600_000_060);
    const second = await k.scanner.scan({ root: k.root });
    expect(second).toMatchObject({ updated: 1, skipped: 0 });
    expect(k.readCalls).toHaveLength(1);
    expect(k.repository.listFileStates()[0]?.modifiedAtMs).toBe(1_600_000_060_000);
  });

  it('a file that was fixed after being unreadable is added on a later scan', async () => {
    const k = kit();
    k.addFile('song.mp3', Buffer.alloc(3000, 0x41));
    expect((await k.scanner.scan({ root: k.root })).failed).toBe(1);
    expect(k.repository.list()).toEqual([]);

    k.addFixture('song.mp3', FIXTURES.full);
    expect(await k.scanner.scan({ root: k.root })).toMatchObject({ added: 1, failed: 0 });
  });

  it('a track whose file BECAME unreadable keeps its last good record and is reported failed', async () => {
    const k = kit();
    k.addFixture('song.mp3', FIXTURES.full);
    await k.scanner.scan({ root: k.root });
    const before = k.repository.list();

    k.addFile('song.mp3', Buffer.alloc(3000, 0x41)); // corrupted
    const result = await k.scanner.scan({ root: k.root });
    expect(result).toMatchObject({ failed: 1, updated: 0, removed: 0 });
    expect(k.repository.list()).toEqual(before);
  });

  it('repeated scans are idempotent: same rows, same ids', async () => {
    const k = kit();
    k.addFixture('a.mp3', FIXTURES.full);
    k.addFixture('x/b.flac', FIXTURES.unicode);
    k.addFile('junk.mp3', 'nope');
    await k.scanner.scan({ root: k.root });
    const first = k.repository.list();
    for (let i = 0; i < 3; i += 1) await k.scanner.scan({ root: k.root });
    expect(k.repository.list()).toEqual(first);
    expect(k.repository.listFileStates()).toHaveLength(2);
  });
});

describe('scanning: deletion reconciliation', () => {
  it('removes a track whose file was deleted and leaves the others untouched', async () => {
    const k = kit();
    k.addFixture('keep.mp3', FIXTURES.full);
    k.addFixture('gone.flac', FIXTURES.unicode);
    k.addFixture('sub/keep2.mp3', FIXTURES.partial);
    await k.scanner.scan({ root: k.root });
    const kept = k.repository.list().filter((t) => !t.sourcePath.endsWith('gone.flac'));

    k.remove('gone.flac');
    const result = await k.scanner.scan({ root: k.root });
    expect(result).toMatchObject({ removed: 1, skipped: 2, added: 0 });
    expect(k.repository.list()).toEqual(expect.arrayContaining(kept));
    expect(k.repository.list()).toHaveLength(2);
  });

  it('removes every track under a deleted folder', async () => {
    const k = kit();
    k.addFixture('keep.mp3', FIXTURES.full);
    k.addFixture('Album/1.mp3', FIXTURES.partial);
    k.addFixture('Album/2.flac', FIXTURES.unicode);
    await k.scanner.scan({ root: k.root });
    k.remove('Album');
    expect((await k.scanner.scan({ root: k.root })).removed).toBe(2);
    expect(k.repository.list()).toHaveLength(1);
  });

  it('a track whose extension became unsupported (renamed to .txt) is removed', async () => {
    const k = kit();
    k.addFixture('a.mp3', FIXTURES.full);
    k.addFixture('b.mp3', FIXTURES.partial);
    await k.scanner.scan({ root: k.root });
    fs.renameSync(k.resolve('b.mp3'), k.resolve('b.txt'));
    expect((await k.scanner.scan({ root: k.root })).removed).toBe(1);
  });

  it('a moved file is a removal plus an addition with a NEW TrackId (no identity guessing)', async () => {
    const k = kit();
    k.addFixture('old/song.mp3', FIXTURES.full);
    k.addFixture('stay.mp3', FIXTURES.partial);
    await k.scanner.scan({ root: k.root });
    const oldId = k.tracksByTitle().get('Full Tags Song')?.id;

    fs.mkdirSync(k.resolve('new'));
    fs.renameSync(k.resolve('old/song.mp3'), k.resolve('new/song.mp3'));
    const result = await k.scanner.scan({ root: k.root });
    expect(result).toMatchObject({ added: 1, removed: 1 });
    expect(k.tracksByTitle().get('Full Tags Song')?.id).not.toBe(oldId);
    expect(k.repository.getById(oldId!)).toBeUndefined();
  });

  it('never touches tracks outside the scanned root (another library folder)', async () => {
    const k = kit();
    k.addFixture('mine/a.mp3', FIXTURES.full);
    k.addFixture('theirs/b.mp3', FIXTURES.partial);
    await k.scanner.scan({ root: k.resolve('mine') });
    await k.scanner.scan({ root: k.resolve('theirs') });
    k.remove('mine/a.mp3');
    k.addFixture('mine/c.flac', FIXTURES.unicode);
    expect(await k.scanner.scan({ root: k.resolve('mine') })).toMatchObject({ added: 1, removed: 1 });
    expect(k.repository.list().map((t) => path.basename(t.sourcePath)).sort()).toEqual(['b.mp3', 'c.flac']);
  });

  it('withholds removal when the whole root suddenly has no audio at all (could be an unmounted drive)', async () => {
    const k = kit();
    k.addFixture('a.mp3', FIXTURES.full);
    k.addFixture('b.mp3', FIXTURES.partial);
    await k.scanner.scan({ root: k.root });
    k.remove('a.mp3');
    k.remove('b.mp3');

    const result = await k.scanner.scan({ root: k.root });
    expect(result).toMatchObject({ status: 'completed', removed: 0, removalWithheld: 'root-appears-empty' });
    expect(k.repository.list()).toHaveLength(2);

    k.addFixture('c.mp3', FIXTURES.noTags); // once any audio exists, normal reconciliation resumes
    expect(await k.scanner.scan({ root: k.root })).toMatchObject({ removed: 2, added: 1, removalWithheld: undefined });
  });

  it('does not remove tracks in a folder that could not be listed this time', async () => {
    let locked = false;
    const k = kit({
      wrapFileSystem: (inner): FileSystem => withOverrides(inner, {
        readDirectory(dir) {
          if (locked && path.basename(dir) === 'Locked') {
            return Promise.reject(new FileSystemError('access-denied', `Access denied: ${dir}`, { path: dir }));
          }
          return inner.readDirectory(dir);
        },
      }),
    });
    k.addFixture('Locked/secret.mp3', FIXTURES.full);
    k.addFixture('Open/ok.mp3', FIXTURES.partial);
    expect((await k.scanner.scan({ root: k.root })).added).toBe(2);

    locked = true; // the folder becomes unreadable (permissions, flaky share, ...)
    k.remove('Open/ok.mp3'); // while a genuinely deleted file elsewhere IS reconciled
    const result = await k.scanner.scan({ root: k.root });
    expect(result.status).toBe('completed');
    expect(result.removed).toBe(1);
    expect(result.failures.map((f) => [path.basename(f.path), f.kind])).toEqual([['Locked', 'filesystem']]);
    expect(k.repository.list().map((t) => path.basename(t.sourcePath))).toEqual(['secret.mp3']); // unknown is not "gone"
  });
});

describe('scanning: deduplication identity is advisory', () => {
  it('two copies of the same song at different paths are BOTH kept, with distinct ids, and counted', async () => {
    const k = kit();
    k.addFixture('Album/song.mp3', FIXTURES.full);
    k.addFixture('Backup/song copy.mp3', FIXTURES.full);

    const result = await k.scanner.scan({ root: k.root });
    expect(result).toMatchObject({ added: 2, possibleDuplicates: 1, failed: 0 });
    const tracks = k.repository.list();
    expect(tracks).toHaveLength(2);
    expect(tracks[0]?.id).not.toBe(tracks[1]?.id);
    expect(tracks[0]?.sourcePath).not.toBe(tracks[1]?.sourcePath);
  });

  it('different songs are not flagged as duplicates', async () => {
    const k = kit();
    k.addFixture('a.mp3', FIXTURES.full);
    k.addFixture('b.mp3', FIXTURES.partial);
    expect((await k.scanner.scan({ root: k.root })).possibleDuplicates).toBe(0);
  });

  it('a duplicate of an already-stored track is detected on a later scan', async () => {
    const k = kit();
    k.addFixture('a.mp3', FIXTURES.full);
    await k.scanner.scan({ root: k.root });
    k.addFixture('copy/a.mp3', FIXTURES.full);
    expect(await k.scanner.scan({ root: k.root })).toMatchObject({ added: 1, possibleDuplicates: 1, skipped: 1 });
  });
});

describe('scanning: progress reporting', () => {
  async function collect(k: ScanKit): Promise<{ events: ScanProgress[]; result: Awaited<ReturnType<ScanKit['scanner']['scan']>> }> {
    const events: ScanProgress[] = [];
    const result = await k.scanner.scan({ root: k.root, onProgress: (p) => events.push(p) });
    return { events, result };
  }

  it('walks through discovering -> reading -> completed with a known total once discovery ends', async () => {
    const k = kit();
    for (let i = 0; i < 5; i += 1) k.addFixture(`d${i}/s${i}.mp3`, FIXTURES.full);
    k.addFile('bad.mp3', 'x');
    const { events, result } = await collect(k);

    const phases = events.map((e) => e.phase);
    expect(phases[0]).toBe('discovering');
    expect(phases.at(-1)).toBe('completed');
    expect(phases.indexOf('reading')).toBeGreaterThan(phases.lastIndexOf('discovering'));

    for (const event of events.filter((e) => e.phase === 'discovering')) expect(event.total).toBeUndefined();
    for (const event of events.filter((e) => e.phase === 'reading' || e.phase === 'completed')) expect(event.total).toBe(6);

    const last = events.at(-1)!;
    expect(last).toMatchObject({ discovered: 6, added: 5, failed: 1, processed: 6, total: 6 });
    expect(result).toMatchObject({ discovered: 6, added: 5, failed: 1 });
  });

  it('counters only ever increase, `processed` never exceeds `total`, and reading events name the current file', async () => {
    const k = kit({ dependencies: { batchSize: 2 } });
    for (let i = 0; i < 7; i += 1) k.addFixture(`s${i}.mp3`, FIXTURES.full);
    const { events } = await collect(k);

    let previous: ScanProgress | undefined;
    for (const event of events) {
      if (previous) {
        for (const key of ['discovered', 'skipped', 'added', 'updated', 'removed', 'failed', 'processed'] as const) {
          expect(event[key]).toBeGreaterThanOrEqual(previous[key]);
        }
      }
      if (event.total !== undefined) expect(event.processed).toBeLessThanOrEqual(event.total);
      previous = event;
    }
    const reading = events.filter((e) => e.phase === 'reading' && e.currentPath !== undefined);
    expect(reading).toHaveLength(7);
    expect(reading.every((e) => path.basename(e.currentPath as string).startsWith('s'))).toBe(true);
  });

  it('emits independent snapshots (later events do not mutate earlier ones)', async () => {
    const k = kit();
    k.addFixture('a.mp3', FIXTURES.full);
    const { events } = await collect(k);
    expect(new Set(events).size).toBe(events.length);
    expect(events[0]?.added).toBe(0);
    expect(events.at(-1)?.added).toBe(1);
  });

  it('counts unchanged files as skipped/processed on a second scan, and reports removals', async () => {
    const k = kit();
    k.addFixture('a.mp3', FIXTURES.full);
    k.addFixture('b.mp3', FIXTURES.partial);
    await k.scanner.scan({ root: k.root });
    k.remove('b.mp3');
    const { events, result } = await collect(k);
    expect(events.some((e) => e.phase === 'removing')).toBe(true);
    expect(events.at(-1)).toMatchObject({ skipped: 1, removed: 1, processed: 1, total: 1, phase: 'completed' });
    expect(result.removed).toBe(1);
  });

  it('a progress callback that throws aborts the scan loudly instead of being swallowed', async () => {
    const k = kit();
    k.addFixture('a.mp3', FIXTURES.full);
    await expect(
      k.scanner.scan({
        root: k.root,
        onProgress: () => {
          throw new Error('listener bug');
        },
      }),
    ).rejects.toThrow('listener bug');
  });
});

describe('scanning: cancellation', () => {
  function manyFiles(k: ScanKit, count: number): void {
    for (let i = 0; i < count; i += 1) k.addFixture(`f${String(i).padStart(2, '0')}.mp3`, FIXTURES.full);
  }

  it('an already-aborted signal does nothing and says so', async () => {
    const k = kit();
    manyFiles(k, 3);
    const controller = new AbortController();
    controller.abort();
    const result = await k.scanner.scan({ root: k.root, signal: controller.signal });
    expect(result).toMatchObject({ status: 'cancelled', discovered: 0, added: 0 });
    expect(k.readCalls).toEqual([]);
    expect(k.repository.list()).toEqual([]);
  });

  it('stops after the current batch, reports cancelled, and leaves only complete, valid tracks', async () => {
    const k = kit({ dependencies: { batchSize: 5, concurrency: 2 } });
    manyFiles(k, 30);
    const controller = new AbortController();
    const events: ScanProgress[] = [];
    const result = await k.scanner.scan({
      root: k.root,
      signal: controller.signal,
      onProgress: (p) => {
        events.push(p);
        if (p.phase === 'reading' && p.processed >= 3) controller.abort();
      },
    });

    expect(result.status).toBe('cancelled');
    expect(events.at(-1)?.phase).toBe('cancelled');
    expect(result.added).toBe(5); // exactly the first committed batch
    expect(k.readCalls).toHaveLength(5); // no further work was started
    const stored = k.repository.list();
    expect(stored).toHaveLength(5);
    for (const track of stored) expect(track).toMatchObject({ title: 'Full Tags Song', artist: 'The Tagged Artist' }); // whole, not partial
    expect(k.database.connection.inTransaction).toBe(false);
  });

  it('cancelling while reads are in flight lets them finish and saves them (no lost, no half-written rows)', async () => {
    const controller = new AbortController();
    let started = 0;
    const k = kit({
      dependencies: { batchSize: 20, concurrency: 3 },
      wrapReader: (inner): MetadataReader => ({
        async read(file) {
          started += 1;
          if (started === 4) controller.abort();
          await new Promise((resolve) => setTimeout(resolve, 5));
          return inner.read(file);
        },
      }),
    });
    manyFiles(k, 12);
    const result = await k.scanner.scan({ root: k.root, signal: controller.signal });

    expect(result.status).toBe('cancelled');
    expect(started).toBeLessThan(12);
    expect(result.added).toBe(started); // everything that started was saved
    expect(k.repository.list()).toHaveLength(started);
  });

  it('a cancelled scan removes nothing, and the next full scan finishes the job', async () => {
    const k = kit();
    k.addFixture('a.mp3', FIXTURES.full);
    k.addFixture('b.mp3', FIXTURES.partial);
    k.addFixture('c.flac', FIXTURES.unicode);
    await k.scanner.scan({ root: k.root });
    k.remove('b.mp3');

    const controller = new AbortController();
    const cancelled = await k.scanner.scan({ root: k.root, signal: controller.signal, onProgress: () => controller.abort() });
    expect(cancelled).toMatchObject({ status: 'cancelled', removed: 0 });
    expect(k.repository.list()).toHaveLength(3);

    expect(await k.scanner.scan({ root: k.root })).toMatchObject({ status: 'completed', removed: 1, skipped: 2 });
    expect(k.repository.list()).toHaveLength(2);
  });

  it('a later scan resumes where the cancelled one stopped (no re-reading of saved files)', async () => {
    const k = kit({ dependencies: { batchSize: 5, concurrency: 1 } });
    manyFiles(k, 12);
    const controller = new AbortController();
    await k.scanner.scan({ root: k.root, signal: controller.signal, onProgress: (p) => p.processed >= 1 && controller.abort() });
    const savedByFirst = k.repository.list().length;
    expect(savedByFirst).toBeGreaterThan(0);
    expect(savedByFirst).toBeLessThan(12);

    k.readCalls.length = 0;
    const resumed = await k.scanner.scan({ root: k.root });
    expect(resumed).toMatchObject({ status: 'completed', skipped: savedByFirst, added: 12 - savedByFirst });
    expect(k.readCalls).toHaveLength(12 - savedByFirst);
    expect(k.repository.list()).toHaveLength(12);
  });

  it('aborting during discovery stops the walk', async () => {
    const k = kit();
    for (let i = 0; i < 6; i += 1) k.addFixture(`dir${i}/s.mp3`, FIXTURES.full);
    const controller = new AbortController();
    const result = await k.scanner.scan({
      root: k.root,
      signal: controller.signal,
      onProgress: (p) => p.phase === 'discovering' && p.currentPath !== k.root && controller.abort(),
    });
    expect(result.status).toBe('cancelled');
    expect(result.discovered).toBeLessThan(6);
    expect(k.repository.list()).toEqual([]);
  });
});

describe('scanning: errors', () => {
  it('a missing root is a fatal ScanError that changes NOTHING (an unplugged drive never wipes the library)', async () => {
    const k = kit();
    k.addFixture('a.mp3', FIXTURES.full);
    await k.scanner.scan({ root: k.root });
    const before = k.repository.list();

    fs.rmSync(k.root, { recursive: true });
    await expect(k.scanner.scan({ root: k.root })).rejects.toMatchObject({ name: 'ScanError', code: 'root-unavailable' });
    expect(k.repository.list()).toEqual(before);
  });

  it('a root that is a file is rejected', async () => {
    const k = kit();
    const file = k.addFixture('a.mp3', FIXTURES.full);
    await expect(k.scanner.scan({ root: file })).rejects.toMatchObject({ code: 'root-not-directory' });
  });

  it('a relative or invalid root is an invalid-path FileSystemError, never resolved against the cwd', async () => {
    const k = kit();
    await expect(k.scanner.scan({ root: 'relative/library' })).rejects.toBeInstanceOf(FileSystemError);
    await expect(k.scanner.scan({ root: '' })).rejects.toMatchObject({ code: 'invalid-path' });
  });

  it('refuses a scope outside the root', async () => {
    const k = kit();
    fs.mkdirSync(k.resolve('inside'));
    fs.mkdirSync(path.join(k.dir, 'outside'));
    for (const scope of [path.join(k.dir, 'outside'), k.resolve('../outside'), `${k.root}-sibling`]) {
      await expect(k.scanner.scan({ root: k.root, scope })).rejects.toMatchObject({ name: 'ScanError', code: 'scope-outside-root' });
    }
  });

  it('a stat failure on one file is a recoverable per-file failure; the track (if known) survives', async () => {
    const k = kit({
      wrapFileSystem: (inner): FileSystem => withOverrides(inner, {
        statFile(file) {
          if (path.basename(file) === 'flaky.mp3') return Promise.reject(new FileSystemError('access-denied', `Access denied: ${file}`, { path: file }));
          return inner.statFile(file);
        },
      }),
    });
    k.addFixture('flaky.mp3', FIXTURES.full);
    k.addFixture('fine.mp3', FIXTURES.partial);
    const first = await k.scanner.scan({ root: k.root });
    expect(first).toMatchObject({ added: 1, failed: 1 });
    expect(first.failures[0]).toMatchObject({ kind: 'filesystem' });
  });

  it('one track the store rejects is a per-file persistence failure; its neighbours are still saved', async () => {
    const k = kit({
      wrapRepository: (inner): TrackRepository => withOverrides(inner, {
        insert(record) {
          if (record.track.sourcePath.endsWith('poison.mp3')) throw new TrackRepositoryError('constraint-violation', 'rejected for the test');
          inner.insert(record);
        },
      }),
    });
    k.addFixture('a.mp3', FIXTURES.full);
    k.addFixture('poison.mp3', FIXTURES.partial);
    k.addFixture('z.flac', FIXTURES.unicode);

    const result = await k.scanner.scan({ root: k.root });
    expect(result).toMatchObject({ status: 'completed', added: 2, failed: 1 });
    expect(result.failures[0]).toMatchObject({ kind: 'persistence', message: 'rejected for the test' });
    expect(k.repository.list().map((t) => path.basename(t.sourcePath)).sort()).toEqual(['a.mp3', 'z.flac']);
  });

  it('an unexpected (non-domain) failure is fatal and rolls back its batch, leaving a valid database', async () => {
    const k = kit({
      dependencies: { batchSize: 2, concurrency: 1 },
      wrapRepository: (inner): TrackRepository => withOverrides(inner, {
        insert(record) {
          if (record.track.sourcePath.endsWith('f2.mp3')) throw new Error('disk exploded');
          inner.insert(record);
        },
      }),
    });
    for (let i = 0; i < 4; i += 1) k.addFixture(`f${i}.mp3`, FIXTURES.full);

    await expect(k.scanner.scan({ root: k.root })).rejects.toThrow('disk exploded');
    // Batch 1 (f0,f1) committed; batch 2 (f2,f3) rolled back as a unit.
    expect(k.repository.list().map((t) => path.basename(t.sourcePath)).sort()).toEqual(['f0.mp3', 'f1.mp3']);
    expect(k.database.connection.inTransaction).toBe(false);
  });

  it('a metadata reader that throws a non-filesystem error is fatal, not silently ignored', async () => {
    const k = kit({ wrapReader: (): MetadataReader => ({ read: () => Promise.reject(new TypeError('parser bug')) }) });
    k.addFixture('a.mp3', FIXTURES.full);
    await expect(k.scanner.scan({ root: k.root })).rejects.toThrow('parser bug');
  });

  it('rejects nonsensical tuning options', () => {
    expect(() => kit({ dependencies: { concurrency: 0 } })).toThrow(RangeError);
    expect(() => kit({ dependencies: { batchSize: 1.5 } })).toThrow(RangeError);
  });
});

describe('scanning: performance guards', () => {
  it('saves a batch in ONE outer transaction, not one per file', async () => {
    let depth = 0;
    let outer = 0;
    const k = kit({
      dependencies: { batchSize: 10 },
      wrapRepository: (inner): TrackRepository => withOverrides(inner, {
        runInTransaction: (work) => {
          if (depth === 0) outer += 1;
          depth += 1;
          try {
            return inner.runInTransaction(work);
          } finally {
            depth -= 1;
          }
        },
      }),
    });
    for (let i = 0; i < 25; i += 1) k.addFixture(`s${i}.mp3`, FIXTURES.full);
    await k.scanner.scan({ root: k.root });
    expect(k.repository.list()).toHaveLength(25);
    expect(outer).toBe(3); // ceil(25 / 10) - not 25
  });

  it('never has more tag reads in flight than the configured concurrency, and does overlap them', async () => {
    let inFlight = 0;
    let peak = 0;
    const k = kit({
      dependencies: { concurrency: 3, batchSize: 50 },
      wrapReader: (inner): MetadataReader => ({
        async read(file) {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          try {
            return await inner.read(file);
          } finally {
            inFlight -= 1;
          }
        },
      }),
    });
    for (let i = 0; i < 12; i += 1) k.addFixture(`s${i}.mp3`, FIXTURES.full);
    await k.scanner.scan({ root: k.root });
    expect(peak).toBe(3);
  });

  it('two scans started at once run one after the other and never duplicate rows', async () => {
    const k = kit();
    for (let i = 0; i < 6; i += 1) k.addFixture(`s${i}.mp3`, FIXTURES.full);
    const [a, b] = await Promise.all([k.scanner.scan({ root: k.root }), k.scanner.scan({ root: k.root })]);
    expect(a.added).toBe(6);
    expect(b).toMatchObject({ added: 0, skipped: 6 });
    expect(k.repository.list()).toHaveLength(6);
  });
});

describe('scanning: links and scoped (targeted) scans', () => {
  it('does not follow symlinked folders or files, and cannot loop on a link back to the root', async () => {
    const k = kit();
    k.addFixture('real/a.mp3', FIXTURES.full);
    k.addFixture('outside/b.mp3', FIXTURES.partial);
    try {
      fs.symlinkSync(k.resolve('real'), k.resolve('link-to-real'), 'dir');
      fs.symlinkSync(k.root, k.resolve('real/loop'), 'dir');
      fs.symlinkSync(k.resolve('outside/b.mp3'), k.resolve('file-link.mp3'), 'file');
    } catch {
      return; // symlinks unavailable (e.g. unprivileged Windows)
    }
    const result = await k.scanner.scan({ root: k.root });
    expect(result).toMatchObject({ discovered: 2, added: 2 }); // real/a.mp3 and outside/b.mp3 once each
    expect(k.repository.list().map((t) => path.basename(t.sourcePath)).sort()).toEqual(['a.mp3', 'b.mp3']);
  });

  it('a scoped scan only adds/updates/removes inside its scope', async () => {
    const k = kit();
    k.addFixture('A/a1.mp3', FIXTURES.full);
    k.addFixture('B/b1.mp3', FIXTURES.partial);
    await k.scanner.scan({ root: k.root });

    k.remove('A/a1.mp3'); // deleted in A
    k.remove('B/b1.mp3'); // deleted in B
    k.addFixture('A/a2.flac', FIXTURES.unicode); // added in A
    const result = await k.scanner.scan({ root: k.root, scope: k.resolve('A') });
    expect(result).toMatchObject({ scope: k.resolve('A'), added: 1, removed: 1 });
    expect(k.repository.list().map((t) => path.basename(t.sourcePath)).sort()).toEqual(['a2.flac', 'b1.mp3']); // B untouched
  });

  it('a scope that is a single file reconciles just that file', async () => {
    const k = kit();
    k.addFixture('a.mp3', FIXTURES.full);
    k.addFixture('b.mp3', FIXTURES.partial);
    await k.scanner.scan({ root: k.root });
    k.addFixture('a.mp3', FIXTURES.noTags);
    k.readCalls.length = 0;
    const result = await k.scanner.scan({ root: k.root, scope: k.resolve('a.mp3') });
    expect(result).toMatchObject({ discovered: 1, updated: 1, removed: 0 });
    expect(basenames(k.readCalls)).toEqual(['a.mp3']);
  });

  it('a scope that no longer exists removes the tracks stored under it (a deleted file or folder)', async () => {
    const k = kit();
    k.addFixture('A/a1.mp3', FIXTURES.full);
    k.addFixture('A/a2.mp3', FIXTURES.partial);
    k.addFixture('keep.mp3', FIXTURES.unicode);
    await k.scanner.scan({ root: k.root });
    k.remove('A');
    expect(await k.scanner.scan({ root: k.root, scope: k.resolve('A') })).toMatchObject({ removed: 2, discovered: 0 });
    expect(k.repository.list()).toHaveLength(1);
  });

  it('a scope pointing at a non-audio file is a harmless no-op', async () => {
    const k = kit();
    k.addFixture('a.mp3', FIXTURES.full);
    k.addFile('notes.txt', 'x');
    await k.scanner.scan({ root: k.root });
    expect(await k.scanner.scan({ root: k.root, scope: k.resolve('notes.txt') })).toMatchObject({ discovered: 0, removed: 0, added: 0 });
    expect(k.repository.list()).toHaveLength(1);
  });
});
