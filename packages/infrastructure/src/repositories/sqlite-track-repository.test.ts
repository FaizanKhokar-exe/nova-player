import path from 'node:path';
import {
  computeDeduplicationKey,
  createTrackId,
  TrackRepositoryError,
  type TrackRepository,
  type TrackRepositoryErrorCode,
} from '@nova/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IN_MEMORY_DATABASE, openDatabase, type NovaDatabase } from '../database/index.js';
import { makeTempDir, removeDir } from '../database/test-helpers.js';
import { SqliteTrackRepository } from './sqlite-track-repository.js';
import { EXACT_PATH_KEYS, makeFullTrack, makeRecord, makeTrack } from './test-tracks.js';

let db: NovaDatabase;
let repo: TrackRepository; // typed as the domain PORT on purpose
beforeEach(() => {
  db = openDatabase({ filePath: IN_MEMORY_DATABASE });
  repo = new SqliteTrackRepository(db, EXACT_PATH_KEYS);
});
afterEach(() => {
  db.close();
});

function expectRepoError(fn: () => unknown, code: TrackRepositoryErrorCode): TrackRepositoryError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(TrackRepositoryError);
    expect((error as TrackRepositoryError).code).toBe(code);
    return error as TrackRepositoryError;
  }
  throw new Error(`expected a TrackRepositoryError (${code}) but nothing was thrown`);
}

const rowCount = (): number => (db.connection.prepare('SELECT COUNT(*) AS n FROM tracks').get() as { n: number }).n;

describe('SqliteTrackRepository', () => {
  describe('insert + getById', () => {
    it('stores a track and returns an equal Track', () => {
      const record = makeRecord();
      repo.insert(record);
      expect(repo.getById(record.track.id)).toEqual(record.track);
    });

    it('returns undefined for a TrackId that is not stored', () => {
      expect(repo.getById(createTrackId())).toBeUndefined();
    });

    it('preserves every optional field', () => {
      const track = makeFullTrack();
      repo.insert({ track, sizeBytes: 10 });
      expect(repo.getById(track.id)).toEqual(track);
    });

    it('preserves absent optional fields as undefined', () => {
      const track = makeTrack({
        album: undefined, albumArtist: undefined, genre: undefined,
        trackNumber: undefined, discNumber: undefined, year: undefined, durationSeconds: undefined,
        artwork: { kind: 'none' },
      });
      repo.insert({ track, sizeBytes: 10 });
      const stored = repo.getById(track.id);
      expect(stored).toEqual(track);
      expect(stored?.album).toBeUndefined();
      expect(stored?.durationSeconds).toBeUndefined();
    });

    it.each([
      [{ kind: 'none' } as const],
      [{ kind: 'embedded' } as const],
      [{ kind: 'external', path: 'E:\\Art\\front.jpg' } as const],
    ])('preserves artwork %j', (artwork) => {
      const track = makeTrack({ artwork });
      repo.insert({ track, sizeBytes: 1 });
      expect(repo.getById(track.id)?.artwork).toEqual(artwork);
    });

    it('preserves title/artist sources and unicode text', () => {
      const track = makeTrack({
        title: '夜に駆ける – Ünïcödé 🎵', titleSource: 'filename',
        artist: 'YOASOBI', artistSource: 'unknown',
        sourcePath: 'C:\\音楽\\夜に駆ける.mp3',
      });
      repo.insert({ track, sizeBytes: 1 });
      expect(repo.getById(track.id)).toEqual(track);
    });

    it('preserves zero duration and full floating-point precision', () => {
      const zero = makeTrack({ durationSeconds: 0 });
      const precise = makeTrack({ durationSeconds: 215.123456789012 });
      repo.insert({ track: zero, sizeBytes: 1 });
      repo.insert({ track: precise, sizeBytes: 1 });
      expect(repo.getById(zero.id)?.durationSeconds).toBe(0);
      expect(repo.getById(precise.id)?.durationSeconds).toBe(215.123456789012);
    });

    it('allows a zero-byte file size', () => {
      expect(() => repo.insert(makeRecord({}, 0))).not.toThrow();
    });

    it('does not mutate the record it is given', () => {
      const record = makeRecord();
      const snapshot = structuredClone(record);
      repo.insert(record);
      expect(record).toEqual(snapshot);
    });
  });

  describe('list', () => {
    it('is empty for a new library', () => {
      expect(repo.list()).toEqual([]);
    });

    it('returns every stored track (order is not guaranteed)', () => {
      const tracks = [makeFullTrack(), makeTrack(), makeTrack({ artwork: { kind: 'embedded' } })];
      tracks.forEach((track) => repo.insert({ track, sizeBytes: 1 }));
      const listed = repo.list();
      expect(listed).toHaveLength(3);
      expect(listed).toEqual(expect.arrayContaining(tracks));
    });

    it('handles a few thousand tracks written in one transaction', () => {
      const tracks = Array.from({ length: 3000 }, () => makeTrack());
      db.connection.transaction(() => tracks.forEach((track) => repo.insert({ track, sizeBytes: 1 })))();
      expect(repo.list()).toHaveLength(3000);
      expect(repo.getById(tracks[1234]!.id)).toEqual(tracks[1234]);
    });
  });

  describe('update', () => {
    it('replaces all stored fields of the track with that id', () => {
      const original = makeFullTrack();
      repo.insert({ track: original, sizeBytes: 100 });

      const changed = makeTrack({
        id: original.id,
        sourcePath: 'D:\\Moved\\New Name.flac',
        title: 'New Title', titleSource: 'tag',
        artist: 'New Artist', artistSource: 'tag',
        album: undefined, genre: undefined, year: 2024, trackNumber: undefined,
        artwork: { kind: 'embedded' },
      });
      repo.update({ track: changed, sizeBytes: 200 });

      expect(repo.getById(original.id)).toEqual(changed);
      expect(rowCount()).toBe(1);
    });

    it('leaves other tracks untouched', () => {
      const a = makeTrack();
      const b = makeTrack();
      repo.insert({ track: a, sizeBytes: 1 });
      repo.insert({ track: b, sizeBytes: 1 });
      repo.update({ track: { ...a, title: 'Changed' }, sizeBytes: 1 });
      expect(repo.getById(b.id)).toEqual(b);
    });

    it('recomputes the deduplication key from the new title/artist/size', () => {
      const track = makeTrack({ title: 'Old', artist: 'Band' });
      repo.insert({ track, sizeBytes: 100 });
      const oldKey = computeDeduplicationKey({ title: 'Old', artist: 'Band', sizeBytes: 100 });

      repo.update({ track: { ...track, title: 'New' }, sizeBytes: 555 });

      expect(repo.findByDeduplicationKey(oldKey)).toEqual([]);
      const newKey = computeDeduplicationKey({ title: 'New', artist: 'Band', sizeBytes: 555 });
      expect(repo.findByDeduplicationKey(newKey).map((t) => t.id)).toEqual([track.id]);
    });

    it('keeps the TrackId when only the source path changes (a moved file)', () => {
      const track = makeTrack();
      repo.insert({ track, sizeBytes: 1 });
      repo.update({ track: { ...track, sourcePath: 'Z:\\elsewhere.mp3' }, sizeBytes: 1 });
      expect(repo.getById(track.id)?.sourcePath).toBe('Z:\\elsewhere.mp3');
    });

    it('throws track-not-found for an unknown id and stores nothing', () => {
      expectRepoError(() => repo.update(makeRecord()), 'track-not-found');
      expect(rowCount()).toBe(0);
    });

    it('throws duplicate-source-path when moving onto another track\'s path, changing nothing', () => {
      const a = makeTrack();
      const b = makeTrack();
      repo.insert({ track: a, sizeBytes: 1 });
      repo.insert({ track: b, sizeBytes: 1 });
      expectRepoError(() => repo.update({ track: { ...b, sourcePath: a.sourcePath, title: 'X' }, sizeBytes: 1 }), 'duplicate-source-path');
      expect(repo.getById(b.id)).toEqual(b);
    });

    it('throws constraint-violation for invalid data and keeps the old row', () => {
      const track = makeTrack();
      repo.insert({ track, sizeBytes: 1 });
      expectRepoError(() => repo.update({ track: { ...track, year: 42 }, sizeBytes: 1 }), 'constraint-violation');
      expect(repo.getById(track.id)).toEqual(track);
    });
  });

  describe('delete', () => {
    it('removes the track and reports true', () => {
      const track = makeTrack();
      repo.insert({ track, sizeBytes: 1 });
      expect(repo.delete(track.id)).toBe(true);
      expect(repo.getById(track.id)).toBeUndefined();
      expect(rowCount()).toBe(0);
    });

    it('reports false, without throwing, for a missing id (including a second delete)', () => {
      const track = makeTrack();
      expect(repo.delete(track.id)).toBe(false);
      repo.insert({ track, sizeBytes: 1 });
      repo.delete(track.id);
      expect(repo.delete(track.id)).toBe(false);
    });

    it('only removes the targeted track', () => {
      const a = makeTrack();
      const b = makeTrack();
      repo.insert({ track: a, sizeBytes: 1 });
      repo.insert({ track: b, sizeBytes: 1 });
      repo.delete(a.id);
      expect(repo.list()).toEqual([b]);
    });

    it('frees the source path for a new track', () => {
      const a = makeTrack();
      repo.insert({ track: a, sizeBytes: 1 });
      repo.delete(a.id);
      expect(() => repo.insert({ track: makeTrack({ sourcePath: a.sourcePath }), sizeBytes: 1 })).not.toThrow();
    });
  });

  describe('findByDeduplicationKey', () => {
    it('finds a track by the domain-computed key', () => {
      const track = makeTrack({ title: 'Song', artist: 'Artist' });
      repo.insert({ track, sizeBytes: 1234 });
      const key = computeDeduplicationKey({ title: 'Song', artist: 'Artist', sizeBytes: 1234 });
      expect(repo.findByDeduplicationKey(key)).toEqual([track]);
    });

    it('returns an empty array when nothing matches', () => {
      repo.insert(makeRecord());
      const key = computeDeduplicationKey({ title: 'Nope', artist: 'Nobody', sizeBytes: 1 });
      expect(repo.findByDeduplicationKey(key)).toEqual([]);
    });

    it('uses the domain normalisation, so case/whitespace variants of a title match', () => {
      const track = makeTrack({ title: 'Hello   World', artist: 'The Band' });
      repo.insert({ track, sizeBytes: 777 });
      const key = computeDeduplicationKey({ title: 'hello world', artist: 'the band', sizeBytes: 777 });
      expect(repo.findByDeduplicationKey(key).map((t) => t.id)).toEqual([track.id]);
    });

    it('does not match the same song at a different file size', () => {
      repo.insert({ track: makeTrack({ title: 'Song', artist: 'Artist' }), sizeBytes: 100 });
      const key = computeDeduplicationKey({ title: 'Song', artist: 'Artist', sizeBytes: 101 });
      expect(repo.findByDeduplicationKey(key)).toEqual([]);
    });

    it('returns every track sharing a key (duplicates are allowed, distinct TrackIds)', () => {
      const first = makeTrack({ title: 'Song', artist: 'Artist' });
      const copy = makeTrack({ title: 'Song', artist: 'Artist', sourcePath: 'D:\\Backup\\Song.mp3' });
      repo.insert({ track: first, sizeBytes: 500 });
      repo.insert({ track: copy, sizeBytes: 500 });
      const key = computeDeduplicationKey({ title: 'Song', artist: 'Artist', sizeBytes: 500 });
      const found = repo.findByDeduplicationKey(key);
      expect(found.map((t) => t.id).sort()).toEqual([first.id, copy.id].sort());
      expect(first.id).not.toBe(copy.id);
    });
  });

  describe('constraint failures are surfaced as TrackRepositoryError', () => {
    it('duplicate TrackId -> duplicate-track-id', () => {
      const track = makeTrack();
      repo.insert({ track, sizeBytes: 1 });
      const error = expectRepoError(
        () => repo.insert({ track: { ...track, sourcePath: 'C:\\different.mp3' }, sizeBytes: 1 }),
        'duplicate-track-id',
      );
      expect(error.cause).toBeInstanceOf(Error); // driver error kept for diagnostics only
    });

    it('duplicate source path -> duplicate-source-path (a path is not an identity)', () => {
      const first = makeTrack();
      repo.insert({ track: first, sizeBytes: 1 });
      expectRepoError(() => repo.insert(makeRecord({ sourcePath: first.sourcePath })), 'duplicate-source-path');
      expect(rowCount()).toBe(1);
    });

    it.each<[string, Parameters<typeof makeTrack>[0], number]>([
      ['empty title', { title: '' }, 1],
      ['empty artist', { artist: '' }, 1],
      ['track number 0', { trackNumber: 0 }, 1],
      ['non-integer track number', { trackNumber: 1.5 }, 1],
      ['year out of range', { year: 10_000 }, 1],
      ['negative duration', { durationSeconds: -1 }, 1],
      ['infinite duration', { durationSeconds: Infinity }, 1],
      ['external artwork with an empty path', { artwork: { kind: 'external', path: '' } }, 1],
      ['negative size', {}, -1],
      ['fractional size', {}, 1.5],
      ['NaN size', {}, Number.NaN],
    ])('%s -> constraint-violation, and nothing is stored', (_label, overrides, size) => {
      expectRepoError(() => repo.insert({ track: makeTrack(overrides), sizeBytes: size }), 'constraint-violation');
      expect(rowCount()).toBe(0);
    });

    it('a malformed TrackId is rejected by the schema, not stored', () => {
      const bad = { ...makeTrack(), id: 'not-a-uuid' as never };
      expectRepoError(() => repo.insert({ track: bad, sizeBytes: 1 }), 'constraint-violation');
    });

    it('does not disguise a non-constraint fault: a closed database throws the raw error', () => {
      const other = openDatabase({ filePath: IN_MEMORY_DATABASE });
      const otherRepo = new SqliteTrackRepository(other, EXACT_PATH_KEYS);
      other.close();
      try {
        otherRepo.insert(makeRecord());
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).not.toBeInstanceOf(TrackRepositoryError);
      }
    });
  });

  describe('reading corrupt stored data', () => {
    it('reports corrupt-record (not a crash or a silent skip) when a stored id is not a valid TrackId', () => {
      // Valid for the schema (36 chars) but not a v4 UUID, so the domain rejects it.
      db.connection
        .prepare(
          `INSERT INTO tracks (id, source_path, source_path_key, title, title_source, artist, artist_source, artwork_kind, size_bytes, dedup_key)
           VALUES ('00000000-0000-0000-0000-000000000000', 'C:\\x.mp3', 'C:\\x.mp3', 'T', 'tag', 'A', 'tag', 'none', 1, 'k')`,
        )
        .run();
      expectRepoError(() => repo.list(), 'corrupt-record');
    });
  });

  describe('lifecycle and ownership', () => {
    it('uses the database it is given: two repositories on one database see the same data', () => {
      const other = new SqliteTrackRepository(db, EXACT_PATH_KEYS);
      const track = makeTrack();
      repo.insert({ track, sizeBytes: 1 });
      expect(other.getById(track.id)).toEqual(track);
    });

    it('does not close the database it was given', () => {
      repo.insert(makeRecord());
      expect(db.isOpen).toBe(true);
    });

    it('cannot be constructed on a closed database', () => {
      const closed = openDatabase({ filePath: IN_MEMORY_DATABASE });
      closed.close();
      expect(() => new SqliteTrackRepository(closed, EXACT_PATH_KEYS)).toThrow();
    });

    it('persists tracks across closing and reopening the database file', () => {
      const dir = makeTempDir();
      try {
        const filePath = path.join(dir, 'nova.db');
        const tracks = [makeFullTrack(), makeTrack(), makeTrack({ artwork: { kind: 'embedded' } })];

        const first = openDatabase({ filePath });
        const firstRepo = new SqliteTrackRepository(first, EXACT_PATH_KEYS);
        tracks.forEach((track, index) => firstRepo.insert({ track, sizeBytes: 100 + index }));
        first.close();

        const second = openDatabase({ filePath });
        try {
          const secondRepo = new SqliteTrackRepository(second, EXACT_PATH_KEYS);
          expect(secondRepo.list()).toHaveLength(3);
          tracks.forEach((track) => expect(secondRepo.getById(track.id)).toEqual(track));
          // The dedup index survives too.
          const key = computeDeduplicationKey({ title: tracks[0]!.title, artist: tracks[0]!.artist, sizeBytes: 100 });
          expect(secondRepo.findByDeduplicationKey(key).map((t) => t.id)).toEqual([tracks[0]!.id]);
        } finally {
          second.close();
        }
      } finally {
        removeDir(dir);
      }
    });
  });
});

describe('SqliteTrackRepository: scan support (Phase 2E)', () => {
  let scanDb: NovaDatabase;
  let scanRepo: TrackRepository;
  beforeEach(() => {
    scanDb = openDatabase({ filePath: IN_MEMORY_DATABASE });
    scanRepo = new SqliteTrackRepository(scanDb, EXACT_PATH_KEYS);
  });
  afterEach(() => {
    scanDb.close();
  });

  it('stores and lists file states (size + modification time) without loading full tracks', () => {
    const a = makeTrack();
    const b = makeTrack();
    scanRepo.insert({ track: a, sizeBytes: 111, modifiedAtMs: 1_700_000_000_123 });
    scanRepo.insert({ track: b, sizeBytes: 222 }); // no mtime supplied
    const states = scanRepo.listFileStates();
    expect(states).toHaveLength(2);
    expect(states).toEqual(
      expect.arrayContaining([
        { id: a.id, sourcePath: a.sourcePath, sizeBytes: 111, modifiedAtMs: 1_700_000_000_123 },
        { id: b.id, sourcePath: b.sourcePath, sizeBytes: 222, modifiedAtMs: 0 },
      ]),
    );
  });

  it('update refreshes the stored size and modification time', () => {
    const track = makeTrack();
    scanRepo.insert({ track, sizeBytes: 1, modifiedAtMs: 10 });
    scanRepo.update({ track, sizeBytes: 2, modifiedAtMs: 20 });
    expect(scanRepo.listFileStates()).toEqual([{ id: track.id, sourcePath: track.sourcePath, sizeBytes: 2, modifiedAtMs: 20 }]);
  });

  it('rejects a negative modification time', () => {
    try {
      scanRepo.insert({ track: makeTrack(), sizeBytes: 1, modifiedAtMs: -5 });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as TrackRepositoryError).code).toBe('constraint-violation');
    }
  });

  it('keys source paths with the injected function: paths with the same key collide', () => {
    const caseInsensitive = new SqliteTrackRepository(scanDb, { pathKey: (p) => p.toLowerCase() });
    caseInsensitive.insert(makeRecord({ sourcePath: 'C:\\Music\\A.mp3' }));
    expectRepoError(() => caseInsensitive.insert(makeRecord({ sourcePath: 'c:\\MUSIC\\a.MP3' })), 'duplicate-source-path');
  });

  it('defaults to the real platform path policy and rejects a path it cannot canonicalise', () => {
    const real = new SqliteTrackRepository(scanDb);
    expect(() => real.insert(makeRecord({ sourcePath: 'relative/not-absolute.mp3' }))).toThrow(/Invalid path/);
  });

  describe('runInTransaction', () => {
    it('commits everything when the work succeeds and returns its value', () => {
      const a = makeTrack();
      const b = makeTrack();
      const result = scanRepo.runInTransaction(() => {
        scanRepo.insert({ track: a, sizeBytes: 1 });
        scanRepo.insert({ track: b, sizeBytes: 1 });
        return 'done';
      });
      expect(result).toBe('done');
      expect(scanRepo.list()).toHaveLength(2);
    });

    it('rolls back every write and rethrows when the work throws', () => {
      const keep = makeTrack();
      scanRepo.insert({ track: keep, sizeBytes: 1 });
      expect(() =>
        scanRepo.runInTransaction(() => {
          scanRepo.insert(makeRecord());
          scanRepo.delete(keep.id);
          throw new Error('abort the batch');
        }),
      ).toThrow('abort the batch');
      expect(scanRepo.list()).toEqual([keep]);
    });

    it('a failed NESTED unit undoes only itself; the outer unit can catch it and commit the rest', () => {
      const good = makeTrack();
      const taken = makeTrack();
      scanRepo.insert({ track: taken, sizeBytes: 1 });
      scanRepo.runInTransaction(() => {
        scanRepo.insert({ track: good, sizeBytes: 1 });
        try {
          scanRepo.runInTransaction(() => {
            scanRepo.insert(makeRecord({ title: 'half written' }));
            scanRepo.insert({ track: makeTrack({ sourcePath: taken.sourcePath }), sizeBytes: 1 }); // duplicate path
          });
        } catch (error) {
          expect((error as TrackRepositoryError).code).toBe('duplicate-source-path');
        }
      });
      const titles = scanRepo.list().map((t) => t.id);
      expect(titles).toHaveLength(2);
      expect(titles).toEqual(expect.arrayContaining([good.id, taken.id]));
    });

    it('refuses async work instead of holding a transaction open', () => {
      expect(() => scanRepo.runInTransaction((() => Promise.resolve()) as never)).toThrow();
      expect(scanDb.connection.inTransaction).toBe(false);
    });
  });
});

describe('Phase 8: removeUnreadableRecords', () => {
  it('removes only rows that cannot be read, reports id and reason, and keeps readable rows untouched; a second call finds nothing', async () => {
    const { openDatabase, IN_MEMORY_DATABASE } = await import('../database/index.js');
    const { SqliteTrackRepository } = await import('./sqlite-track-repository.js');
    const { makeTrack } = await import('./test-tracks.js');
    const database = openDatabase({ filePath: IN_MEMORY_DATABASE });
    try {
      const repository = new SqliteTrackRepository(database);
      const good = makeTrack({ sourcePath: '/music/good.mp3' });
      const bad = makeTrack({ sourcePath: '/music/bad.mp3' });
      repository.insert({ track: good, sizeBytes: 1 });
      repository.insert({ track: bad, sizeBytes: 1 });
      database.connection.pragma('ignore_check_constraints = ON'); // damage the table's CHECKs would normally refuse
      database.connection.prepare("UPDATE tracks SET artist_source = 'guess' WHERE id = ?").run(bad.id);

      expect(() => repository.list()).toThrow(/artist_source/); // reads stay strict
      const removed = repository.removeUnreadableRecords();
      expect(removed).toEqual([{ id: bad.id, reason: expect.stringContaining('artist_source') }]);
      expect(repository.list().map((track) => track.id)).toEqual([good.id]);
      expect(repository.removeUnreadableRecords()).toEqual([]);
    } finally {
      database.close();
    }
  });
});

describe('names corrected by the listener (v0.15.0)', () => {
  it('lays an edit over the tags in every read, survives a rescan, and can be reset', () => {
    const record = makeRecord();
    repo.insert(record);
    const real = repo as SqliteTrackRepository;
    expect(real.hasEdit(record.track.id)).toBe(false);
    expect(real.setEdit(record.track.id, { title: 'Right Title', artist: 'Right Artist', album: 'Right Album' })).toBe(true);
    for (const track of [repo.getById(record.track.id), repo.list()[0], repo.findByDeduplicationKey(computeDeduplicationKey({ title: record.track.title, artist: record.track.artist, sizeBytes: record.sizeBytes }))[0]]) {
      expect(track).toMatchObject({ title: 'Right Title', artist: 'Right Artist', album: 'Right Album', titleSource: 'tag', artistSource: 'tag' });
    }
    // the scanner rewrites the tag columns when the file changes - the edit stays
    repo.update({ ...record, track: { ...record.track, title: 'Scanned again' } });
    expect(repo.getById(record.track.id)?.title).toBe('Right Title');
    // changing it again replaces it (no album = no album)
    real.setEdit(record.track.id, { title: 'T2', artist: 'A2' });
    expect(repo.getById(record.track.id)).toMatchObject({ title: 'T2', artist: 'A2', album: undefined });
    expect(real.clearEdit(record.track.id)).toBe(true);
    expect(repo.getById(record.track.id)?.title).toBe('Scanned again');
    expect(real.clearEdit(record.track.id)).toBe(false);
  });
  it('refuses an unknown track and goes away with its track', () => {
    const real = repo as SqliteTrackRepository;
    const record = makeRecord();
    expect(real.setEdit(record.track.id, { title: 'x', artist: 'y' })).toBe(false);
    repo.insert(record);
    real.setEdit(record.track.id, { title: 'x', artist: 'y' });
    repo.delete(record.track.id);
    expect((db.connection.prepare('SELECT COUNT(*) AS n FROM track_edits').get() as { n: number }).n).toBe(0);
  });
});
