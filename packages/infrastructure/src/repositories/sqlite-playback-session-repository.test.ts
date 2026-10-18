import { EMPTY_QUEUE, createTrackId, type QueueState, type TrackId } from '@nova/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IN_MEMORY_DATABASE, MIGRATIONS, openDatabase, type NovaDatabase } from '../database/index.js';
import { makeTempDir, removeDir } from '../database/test-helpers.js';
import { PlaybackSessionCorruptError, SqlitePlaybackSessionRepository } from './sqlite-playback-session-repository.js';
import path from 'node:path';

let db: NovaDatabase;
let repo: SqlitePlaybackSessionRepository;
let clock = 1000;
beforeEach(() => {
  clock = 1000;
  db = openDatabase({ filePath: IN_MEMORY_DATABASE });
  repo = new SqlitePlaybackSessionRepository(db, { now: () => clock++ });
});
afterEach(() => db.close());

const ids = (n: number): TrackId[] => Array.from({ length: n }, () => createTrackId());
const queueOf = (tracks: TrackId[], overrides: Partial<QueueState> = {}): QueueState => ({
  tracks,
  currentIndex: 0,
  repeatMode: 'off',
  unshuffledTracks: undefined,
  ...overrides,
});
const raw = () => db.connection.prepare('SELECT * FROM playback_session').all() as Record<string, unknown>[];

describe('migration 4', () => {
  it('is applied, append-only after the Phase 3 migrations', () => {
    expect(MIGRATIONS.map((m) => m.name).slice(0, 3)).toEqual(['initial-schema', 'scan-state-and-path-key', 'library-roots']);
    expect(MIGRATIONS[3]?.name).toBe('playback-session');
    expect(db.getSchemaVersion()).toBe(MIGRATIONS.length);
  });

  it('upgrades a database that is at version 3, keeping its data', () => {
    const dir = makeTempDir();
    try {
      const file = path.join(dir, 'v3.db');
      const old = openDatabase({ filePath: file, migrations: MIGRATIONS.slice(0, 3) });
      old.connection.prepare("INSERT INTO library_roots (id, path, path_key, added_at_ms) VALUES ('123e4567-e89b-42d3-a456-426614174000', '/m', '/m', 1)").run();
      expect(old.getSchemaVersion()).toBe(3);
      old.close();

      const upgraded = openDatabase({ filePath: file });
      expect(upgraded.getSchemaVersion()).toBe(MIGRATIONS.length);
      expect(upgraded.connection.prepare('SELECT COUNT(*) AS n FROM library_roots').get()).toEqual({ n: 1 });
      expect(new SqlitePlaybackSessionRepository(upgraded).load()).toBeUndefined();
      upgraded.close();
    } finally {
      removeDir(dir);
    }
  });
});

describe('SqlitePlaybackSessionRepository', () => {
  it('has nothing saved at first', () => {
    expect(repo.load()).toBeUndefined();
  });

  it('round-trips a plain queue with its position', () => {
    const queue = queueOf(ids(4), { currentIndex: 2, repeatMode: 'all' });
    repo.save({ queue, positionMs: 12_345 });
    expect(repo.load()).toEqual({ queue, positionMs: 12_345 });
  });

  it('round-trips shuffle state: the active order AND the pre-shuffle snapshot', () => {
    const original = ids(5);
    const shuffled = [original[2]!, original[0]!, original[4]!, original[1]!, original[3]!];
    const queue = queueOf(shuffled, { currentIndex: 0, repeatMode: 'one', unshuffledTracks: original });
    repo.save({ queue, positionMs: 0 });
    const loaded = repo.load();
    expect(loaded?.queue).toEqual(queue);
    expect(loaded?.queue.unshuffledTracks).toEqual(original);
  });

  it('round-trips an empty queue (nothing current)', () => {
    repo.save({ queue: EMPTY_QUEUE, positionMs: 999 });
    expect(repo.load()).toEqual({ queue: EMPTY_QUEUE, positionMs: 0 }); // position is meaningless without a current track
  });

  it('keeps exactly ONE session: save replaces', () => {
    repo.save({ queue: queueOf(ids(3)), positionMs: 1 });
    const second = queueOf(ids(2), { currentIndex: 1 });
    repo.save({ queue: second, positionMs: 2 });
    expect(raw()).toHaveLength(1);
    expect(repo.load()).toEqual({ queue: second, positionMs: 2 });
  });

  it('savePosition updates only the position and does not touch the queue', () => {
    const queue = queueOf(ids(3), { currentIndex: 1 });
    repo.save({ queue, positionMs: 100 });
    const before = raw()[0] as { queue_json: string };
    repo.savePosition(4_000);
    const after = raw()[0] as { queue_json: string; position_ms: number };
    expect(after.queue_json).toBe(before.queue_json);
    expect(after.position_ms).toBe(4_000);
    expect(repo.load()).toEqual({ queue, positionMs: 4_000 });
  });

  it('savePosition with nothing saved is a harmless no-op', () => {
    repo.savePosition(500);
    expect(repo.load()).toBeUndefined();
    expect(raw()).toHaveLength(0);
  });

  it('clear forgets the session', () => {
    repo.save({ queue: queueOf(ids(2)), positionMs: 5 });
    repo.clear();
    expect(repo.load()).toBeUndefined();
    repo.clear(); // idempotent
  });

  it.each([[-1], [1.5], [Number.NaN], [Infinity], [2 ** 60]])('rejects the position %s (whole non-negative ms only)', (bad) => {
    expect(() => repo.save({ queue: queueOf(ids(1)), positionMs: bad })).toThrow(RangeError);
    expect(() => repo.savePosition(bad)).toThrow(RangeError);
  });

  it('persists across a real close and reopen of the database file', () => {
    const dir = makeTempDir();
    try {
      const file = path.join(dir, 'p.db');
      const first = openDatabase({ filePath: file });
      const queue = queueOf(ids(3), { currentIndex: 1, repeatMode: 'all' });
      new SqlitePlaybackSessionRepository(first).save({ queue, positionMs: 7_777 });
      first.close();
      const second = openDatabase({ filePath: file });
      expect(new SqlitePlaybackSessionRepository(second).load()).toEqual({ queue, positionMs: 7_777 });
      second.close();
    } finally {
      removeDir(dir);
    }
  });

  it('stamps updated_at_ms from the injected clock', () => {
    repo.save({ queue: queueOf(ids(1)), positionMs: 0 });
    expect((raw()[0] as { updated_at_ms: number }).updated_at_ms).toBe(1000);
    repo.savePosition(5);
    expect((raw()[0] as { updated_at_ms: number }).updated_at_ms).toBe(1001);
  });
});

describe('corrupt stored data fails loudly with a typed error (never a half-valid queue)', () => {
  const put = (columns: Partial<Record<string, unknown>>) =>
    db.connection
      .prepare(
        `INSERT INTO playback_session (id, queue_json, unshuffled_json, current_index, repeat_mode, position_ms, updated_at_ms)
         VALUES (1, @queue_json, @unshuffled_json, @current_index, @repeat_mode, @position_ms, 0)`,
      )
      .run({ queue_json: '[]', unshuffled_json: null, current_index: null, repeat_mode: 'off', position_ms: 0, ...columns });

  it.each([
    ['queue is not JSON', { queue_json: '{nope' }],
    ['queue is not a list', { queue_json: '{"a":1}' }],
    ['queue holds a non-id', { queue_json: '["not-an-id"]' }],
    ['queue holds a non-string', { queue_json: '[42]' }],
    ['current index is outside the queue', { queue_json: JSON.stringify(ids(2)), current_index: 5 }],
    ['pre-shuffle list has a different length', { queue_json: JSON.stringify(ids(2)), unshuffled_json: JSON.stringify(ids(3)), current_index: 0 }],
    ['pre-shuffle list is garbage', { queue_json: JSON.stringify(ids(1)), unshuffled_json: 'x', current_index: 0 }],
  ])('%s', (_name, columns) => {
    put(columns);
    expect(() => repo.load()).toThrow(PlaybackSessionCorruptError);
  });

  it('the schema itself rejects an invalid repeat mode, a second row and a negative position', () => {
    expect(() => put({ repeat_mode: 'sideways' })).toThrow();
    expect(() => put({ position_ms: -1 })).toThrow();
    put({});
    expect(() => db.connection.prepare("INSERT INTO playback_session VALUES (2, '[]', NULL, NULL, 'off', 0, 0)").run()).toThrow();
  });
});

describe('Phase 8: a damaged position does not cost the saved queue', () => {
  it('loads the queue with position 0 when the stored position is not a whole safe number', async () => {
    const { openDatabase, IN_MEMORY_DATABASE } = await import('../database/index.js');
    const { SqlitePlaybackSessionRepository } = await import('./sqlite-playback-session-repository.js');
    const database = openDatabase({ filePath: IN_MEMORY_DATABASE });
    try {
      const id = '123e4567-e89b-42d3-a456-426614174000';
      database.connection.pragma('ignore_check_constraints = ON');
      database.connection
        .prepare("INSERT INTO playback_session (id, queue_json, unshuffled_json, current_index, repeat_mode, position_ms, updated_at_ms) VALUES (1, ?, NULL, 0, 'off', 9007199254740993, 1)")
        .run(JSON.stringify([id]));
      const loaded = new SqlitePlaybackSessionRepository(database).load();
      expect(loaded?.queue.tracks).toEqual([id]);
      expect(loaded?.positionMs).toBe(0);
    } finally {
      database.close();
    }
  });
});
