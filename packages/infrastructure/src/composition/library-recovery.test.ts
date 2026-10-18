import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLibraryApplication, type LibraryApplicationEvent } from '../application/library-application.js';
import { createPlaybackApplication } from '../application/playback-application.js';
import { createMediaAccess } from '../media/media-access.js';
import { createLibraryServices, type LibraryServices, type LibraryServicesDiagnostic } from './library-services.js';

/**
 * Phase 8 (hardening): what happens to a REAL library database file that holds a row the app can
 * no longer read. Before Phase 8 one such row made `list()` and `listFileStates()` throw
 * `corrupt-record`, so the track list, every scan and the playback queue's restore all failed on
 * every launch - one bad row blocked the whole library, with no way out except editing the file.
 *
 * The malformed rows are written the way real damage arrives: straight into the SQLite file while
 * the app is closed (a hand edit, another tool, a flipped bit). The TrackId column only has a
 * length CHECK, so a 36-character value that is not a UUID passes SQLite and fails the domain.
 */
const fixtureDir = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../tests/fixtures/metadata');
const NOT_A_UUID = 'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz'; // 36 characters, passes the table's CHECK, is not a TrackId

let dir: string;
let library: string;
let dbPath: string;
const opened: LibraryServices[] = [];

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nova-recovery-')));
  library = path.join(dir, 'Music');
  fs.mkdirSync(library);
  dbPath = path.join(dir, 'userData', 'nova.db');
});
afterEach(async () => {
  for (const services of opened.splice(0)) await services.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function open(onDiagnostic?: (event: LibraryServicesDiagnostic) => void): LibraryServices {
  const services = createLibraryServices({ databasePath: dbPath, ...(onDiagnostic !== undefined && { onDiagnostic }) });
  opened.push(services);
  return services;
}
function put(relative: string, fixture: string): string {
  const target = path.join(library, relative);
  fs.copyFileSync(path.join(fixtureDir, fixture), target);
  return target;
}
/** Runs SQL against the closed database file, like damage done behind the app's back. */
function tamper(sql: string, ...params: unknown[]): void {
  const raw = new Database(dbPath);
  try {
    raw.pragma('ignore_check_constraints = ON'); // so damage that the table's CHECKs would normally refuse can be reproduced
    raw.prepare(sql).run(...params);
  } finally {
    raw.close();
  }
}
const basenames = (services: LibraryServices): string[] => services.trackRepository.list().map((track) => path.basename(track.sourcePath)).sort();

/** Scans three files into a fresh database, saves a playback queue over the two healthy ones, and closes it. */
async function seedLibrary(): Promise<{ healthyIds: string[] }> {
  put('a-full.mp3', 'full-tags.mp3');
  put('b-unicode.flac', 'unicode-tags.flac');
  put('c-partial.mp3', 'Partial Tags.mp3');
  const seed = open();
  seed.libraryRootRepository.insert({ id: crypto.randomUUID(), path: library, addedAtMs: 1 });
  await seed.scanner.scan({ root: library });
  const tracks = [...seed.trackRepository.list()].sort((x, y) => x.sourcePath.localeCompare(y.sourcePath));
  const healthyIds = [tracks[1]!.id, tracks[2]!.id]; // b and c; a is the one that will be damaged
  seed.playbackSessionRepository.save({ queue: { tracks: healthyIds as never, currentIndex: 1, repeatMode: 'all', unshuffledTracks: undefined }, positionMs: 42_000 });
  await seed.close();
  opened.length = 0;
  return { healthyIds };
}

describe('a library database holding a row the app cannot read', () => {
  it('opens, lists the readable tracks, reports the damage, and the next scan restores the damaged one', async () => {
    const { healthyIds } = await seedLibrary();
    tamper(`UPDATE tracks SET id = ? WHERE source_path LIKE '%a-full.mp3'`, NOT_A_UUID);

    const diagnostics: LibraryServicesDiagnostic[] = [];
    const services = open((event) => diagnostics.push(event));

    // The library loads: the two good tracks are there, the unreadable row is not blocking anything.
    expect(basenames(services)).toEqual(['b-unicode.flac', 'c-partial.mp3']);
    expect(() => services.trackRepository.listFileStates()).not.toThrow();
    expect(diagnostics).toEqual([{ kind: 'unreadable-tracks-removed', rows: [{ id: NOT_A_UUID, reason: expect.stringContaining('id is not a valid TrackId') }] }]);

    // The file was never touched, so the next reconciliation scan simply reads it again, under a valid id.
    const result = await services.scanner.scan({ root: library });
    expect(result).toMatchObject({ status: 'completed', discovered: 3, added: 1, failed: 0, skipped: 2 });
    expect(basenames(services)).toEqual(['a-full.mp3', 'b-unicode.flac', 'c-partial.mp3']);
    expect(services.trackRepository.list().every((track) => track.id !== (NOT_A_UUID as never))).toBe(true);

    // And the listener's saved queue (over the healthy tracks) and position survived the damage.
    expect(services.playbackSessionRepository.load()).toMatchObject({ queue: { tracks: healthyIds, currentIndex: 1, repeatMode: 'all' }, positionMs: 42_000 });
  });

  it('the application-level launch (startup scan, library listing, playback restore) works with the damaged row present', async () => {
    const { healthyIds } = await seedLibrary();
    tamper(`UPDATE tracks SET id = ? WHERE source_path LIKE '%a-full.mp3'`, NOT_A_UUID);

    const services = open();
    const events: LibraryApplicationEvent[] = [];
    const errors: unknown[] = [];
    const application = createLibraryApplication({ services, onInternalError: (error) => errors.push(error) });
    application.subscribe((event) => events.push(event));
    const mediaAccess = createMediaAccess({ trackRepository: services.trackRepository, libraryRootRepository: services.libraryRootRepository, fileSystem: services.fileSystem });
    const playback = createPlaybackApplication({
      trackRepository: services.trackRepository,
      playbackSessionRepository: services.playbackSessionRepository,
      library: application,
      mediaAccess,
      onInternalError: (error) => errors.push(error),
    });

    // The restored session still points at the healthy track the listener was on, paused, at the saved position.
    expect(playback.getState().current?.track.id).toBe(healthyIds[1]);
    expect(playback.getState().positionMs).toBe(42_000);

    const report = await application.startup();
    expect(report).toMatchObject({ rootCount: 1, availableRoots: 1, scanStarted: true });
    await new Promise<void>((resolve) => {
      if (events.some((event) => event.type === 'scan-finished')) resolve();
      else application.subscribe((event) => event.type === 'scan-finished' && resolve());
    });

    const finished = events.find((event) => event.type === 'scan-finished');
    expect(finished?.type === 'scan-finished' && finished.result.status).toBe('completed');
    expect(application.listTracks().map((track) => path.basename(track.sourcePath)).sort()).toEqual(['a-full.mp3', 'b-unicode.flac', 'c-partial.mp3']);
    expect(application.getSummary().trackCount).toBe(3);
    expect(errors).toEqual([]);
    await application.dispose();
  });

  it('removes every unreadable row, not just the first, and leaves readable rows - and their identities - alone', async () => {
    const { healthyIds } = await seedLibrary();
    tamper(`UPDATE tracks SET id = ? WHERE source_path LIKE '%a-full.mp3'`, NOT_A_UUID);
    tamper(`UPDATE tracks SET id = ? WHERE source_path LIKE '%b-unicode.flac'`, 'not-a-uuid-at-all-but-36-chars-long');

    const diagnostics: LibraryServicesDiagnostic[] = [];
    const services = open((event) => diagnostics.push(event));
    expect(basenames(services)).toEqual(['c-partial.mp3']);
    expect(services.trackRepository.getById(healthyIds[1] as never)).toBeDefined(); // the untouched row kept its identity
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ kind: 'unreadable-tracks-removed' });
    expect((diagnostics[0] as unknown as { rows: unknown[] }).rows).toHaveLength(2);
  });

  it('removes a row whose other columns are invalid too (an unknown metadata source, an unknown artwork kind)', async () => {
    await seedLibrary();
    tamper(`UPDATE tracks SET title_source = 'guess' WHERE source_path LIKE '%a-full.mp3'`);
    tamper(`UPDATE tracks SET artwork_kind = 'remote', artwork_path = NULL WHERE source_path LIKE '%b-unicode.flac'`);

    const diagnostics: LibraryServicesDiagnostic[] = [];
    const services = open((event) => diagnostics.push(event));
    expect(basenames(services)).toEqual(['c-partial.mp3']);
    const first = diagnostics[0];
    expect(first).toMatchObject({ kind: 'unreadable-tracks-removed' });
    const reasons = (first as unknown as { rows: { reason: string }[] }).rows.map((row) => row.reason).join('\n');
    expect(reasons).toContain('title_source');
    expect(reasons).toContain('artwork_kind');
  });

  it('a healthy database produces no diagnostic and no deletion', async () => {
    await seedLibrary();
    const diagnostics: LibraryServicesDiagnostic[] = [];
    const services = open((event) => diagnostics.push(event));
    expect(diagnostics).toEqual([]);
    expect(basenames(services)).toEqual(['a-full.mp3', 'b-unicode.flac', 'c-partial.mp3']);
  });

  it('the repair is all-or-nothing: if deleting fails, nothing is deleted and the app still opens (reads stay loud)', async () => {
    await seedLibrary();
    tamper(`UPDATE tracks SET id = ? WHERE source_path LIKE '%a-full.mp3'`, NOT_A_UUID);
    // A trigger makes every DELETE on `tracks` fail, so the repair cannot succeed.
    tamper(`CREATE TRIGGER refuse_delete BEFORE DELETE ON tracks BEGIN SELECT RAISE(ABORT, 'delete refused'); END`);

    const diagnostics: LibraryServicesDiagnostic[] = [];
    const services = open((event) => diagnostics.push(event));
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ kind: 'repair-failed' });
    const raw = new Database(dbPath, { readonly: true });
    try {
      expect((raw.prepare('SELECT COUNT(*) AS n FROM tracks').get() as { n: number }).n).toBe(3); // untouched
    } finally {
      raw.close();
    }
    expect(services.databasePath).toBe(dbPath);
  });
});
