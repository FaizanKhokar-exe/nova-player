import { EMPTY_QUEUE, PREVIOUS_RESTART_THRESHOLD_MS, createTrackId, fisherYatesShuffle, selectGroup, sortTracks, type PersistedPlaybackSession, type PlaybackSessionRepository, type RandomSource, type Track, type TrackId } from '@nova/domain';
import { beforeEach, describe, expect, it } from 'vitest';
import { IN_MEMORY_DATABASE, openDatabase, type NovaDatabase } from '../database/index.js';
import type { MediaDenial } from '../media/media-access.js';
import { SqlitePlaybackSessionRepository } from '../repositories/sqlite-playback-session-repository.js';
import { makeTrack } from '../repositories/test-tracks.js';
import { LibraryApplicationError } from './library-application.js';
import { createPlaybackApplication, PlaybackApplicationError, type PlaybackApplication, type PlaybackApplicationEvent } from './playback-application.js';

/** Scripted randomness: a fixed cycle of values, so shuffle is fully deterministic. */
function sequence(...values: number[]): RandomSource {
  let i = 0;
  return () => values[i++ % values.length]!;
}

interface Kit {
  app: PlaybackApplication;
  tracks: Track[];
  library: Map<TrackId, Track>;
  events: PlaybackApplicationEvent[];
  errors: unknown[];
  session: PlaybackSessionRepository & { saved: PersistedPlaybackSession | undefined; positionWrites: number[] };
  denials: Map<string, MediaDenial>;
  searchResults: Map<string, TrackId[]>;
  rebuild(): PlaybackApplication;
}

function memorySession(): Kit['session'] {
  const s = {
    saved: undefined as PersistedPlaybackSession | undefined,
    positionWrites: [] as number[],
    load: () => s.saved,
    save: (session: PersistedPlaybackSession) => void (s.saved = session),
    savePosition: (positionMs: number) => {
      s.positionWrites.push(positionMs);
      if (s.saved) s.saved = { ...s.saved, positionMs };
    },
    clear: () => void (s.saved = undefined),
  };
  return s;
}

function kit(count = 5, random: RandomSource = sequence(0.3, 0.7, 0.1, 0.9)): Kit {
  const tracks = Array.from({ length: count }, (_, i) => makeTrack({ title: `T${i}` }));
  const library = new Map(tracks.map((t) => [t.id, t]));
  const session = memorySession();
  const events: PlaybackApplicationEvent[] = [];
  const errors: unknown[] = [];
  const denials = new Map<string, MediaDenial>();
  const searchResults = new Map<string, TrackId[]>();

  const build = (): PlaybackApplication => {
    const app = createPlaybackApplication({
      trackRepository: {
        getById: (id) => library.get(id),
        listFileStates: () => [...library.values()].map((t) => ({ id: t.id, sourcePath: t.sourcePath, sizeBytes: 1, modifiedAtMs: 0 })),
      },
      playbackSessionRepository: session,
      library: {
        listTracks: (sort) => sortTracks([...library.values()], sort ?? { field: 'title', direction: 'asc' }),
        getGroup: (kind, key, sort) => {
          const selected = selectGroup([...library.values()], kind, key);
          if (selected === undefined) throw new LibraryApplicationError('group-not-found', 'gone');
          return { group: selected.group, tracks: sort === undefined ? selected.tracks : sortTracks(selected.tracks, sort) };
        },
        searchTracks: (q) => (searchResults.get(q) ?? []).flatMap((id) => (library.has(id) ? [{ track: library.get(id)!, match: { kind: 'words' as const } }] : [])),
      },
      mediaAccess: {
        resolveTrack: async (id) => {
          const denial = denials.get(id);
          return denial === undefined ? { ok: true, filePath: '/x.mp3' as never, contentType: 'audio/mpeg' } : { ok: false, denial };
        },
      },
      random,
      onInternalError: (e) => errors.push(e),
    });
    app.subscribe((e) => events.push(e));
    return app;
  };
  const k: Kit = { app: build(), tracks, library, events, errors, session, denials, searchResults, rebuild: () => (k.app = build()) };
  return k;
}

const ids = (k: Kit) => k.tracks.map((t) => t.id);
const currentTitle = (app: PlaybackApplication) => app.getState().current?.track.title;

describe('initial state', () => {
  it('is empty, stopped and has nothing to go next to', () => {
    const k = kit();
    expect(k.app.getState()).toEqual({
      revision: 0,
      current: undefined,
      positionMs: 0,
      repeatMode: 'off',
      shuffle: false,
      queueLength: 0,
      queueIndex: undefined,
      canNext: false,
    });
  });

  it('Next / Previous / trackFinished with nothing queued do nothing', () => {
    const k = kit();
    expect(k.app.next(0).outcome).toBe('none');
    expect(k.app.previous(0).outcome).toBe('none');
    expect(k.app.trackFinished(k.tracks[0]!.id).outcome).toBe('none');
    expect(k.app.getState().revision).toBe(0);
  });
});

describe('playTrack', () => {
  it('queues the whole library in library order and starts the chosen track', () => {
    const k = kit();
    const result = k.app.playTrack({ trackId: k.tracks[2]!.id });
    expect(result.outcome).toBe('started');
    expect(result.state.current?.track.id).toBe(k.tracks[2]!.id);
    expect(result.state.queueLength).toBe(5);
    expect(result.state.queueIndex).toBe(2);
    expect(result.state.positionMs).toBe(0);
    expect(k.session.saved?.queue.tracks).toEqual(ids(k));
  });

  it('hands the renderer an opaque media URL built from the id alone', () => {
    const k = kit();
    const state = k.app.playTrack({ trackId: k.tracks[0]!.id }).state;
    expect(state.current?.mediaUrl).toBe(`nova-media://track/${k.tracks[0]!.id}`);
  });

  it('queues a SEARCH result list when played from search (the list the user sees)', () => {
    const k = kit();
    k.searchResults.set('t', [k.tracks[3]!.id, k.tracks[1]!.id, k.tracks[4]!.id]);
    const state = k.app.playTrack({ trackId: k.tracks[1]!.id, context: { kind: 'search', query: 't' } }).state;
    expect(state.queueLength).toBe(3);
    expect(state.queueIndex).toBe(1);
    expect(k.app.next(0).state.current?.track.id).toBe(k.tracks[4]!.id);
  });

  it('plays just that track if the list no longer contains it (the library changed under the user)', () => {
    const k = kit();
    k.searchResults.set('gone', [k.tracks[0]!.id]);
    const state = k.app.playTrack({ trackId: k.tracks[2]!.id, context: { kind: 'search', query: 'gone' } }).state;
    expect(state.queueLength).toBe(1);
    expect(state.current?.track.id).toBe(k.tracks[2]!.id);
  });

  it('refuses an unknown or malformed track id with a typed error, changing nothing', () => {
    const k = kit();
    for (const bad of [createTrackId(), 'nope', '../../etc/passwd']) {
      expect(() => k.app.playTrack({ trackId: bad })).toThrow(PlaybackApplicationError);
    }
    expect(k.app.getState().revision).toBe(0);
  });

  it('keeps the listener\'s repeat mode when a new list is played (replaceQueue resets it by definition)', () => {
    const k = kit();
    k.app.playTrack({ trackId: k.tracks[0]!.id });
    k.app.setRepeatMode('all');
    const state = k.app.playTrack({ trackId: k.tracks[3]!.id }).state;
    expect(state.repeatMode).toBe('all');
  });

  it('keeps shuffle on when a new list is played: current stays first, the rest are shuffled', () => {
    const k = kit(5, sequence(0.0));
    k.app.playTrack({ trackId: k.tracks[0]!.id });
    k.app.setShuffle(true);
    const state = k.app.playTrack({ trackId: k.tracks[3]!.id }).state;
    expect(state.shuffle).toBe(true);
    expect(state.current?.track.id).toBe(k.tracks[3]!.id);
    expect(state.queueIndex).toBe(0);
  });

  it('starting a track resets the saved position to 0', () => {
    const k = kit();
    k.app.playTrack({ trackId: k.tracks[0]!.id });
    k.app.reportPosition(k.tracks[0]!.id, 9_000);
    expect(k.app.playTrack({ trackId: k.tracks[1]!.id }).state.positionMs).toBe(0);
  });
});

describe('Next (domain: decideOnNextPressed)', () => {
  it('advances in queue order', () => {
    const k = kit();
    k.app.playTrack({ trackId: k.tracks[0]!.id });
    expect(k.app.next(0)).toMatchObject({ outcome: 'started' });
    expect(currentTitle(k.app)).toBe('T1');
    k.app.next(0);
    expect(currentTitle(k.app)).toBe('T2');
  });

  it('at the end with repeat OFF: does nothing and keeps playing the last track', () => {
    const k = kit(3);
    k.app.playTrack({ trackId: k.tracks[2]!.id });
    const before = k.app.getState();
    const result = k.app.next(0);
    expect(result.outcome).toBe('none');
    expect(result.state).toEqual(before);
    expect(before.canNext).toBe(false);
  });

  it('at the end with repeat ALL: wraps to the first track', () => {
    const k = kit(3);
    k.app.playTrack({ trackId: k.tracks[2]!.id });
    k.app.setRepeatMode('all');
    expect(k.app.next(0).outcome).toBe('started');
    expect(currentTitle(k.app)).toBe('T0');
  });

  it('repeat ONE does not trap an explicit Next (domain rule)', () => {
    const k = kit(3);
    k.app.playTrack({ trackId: k.tracks[0]!.id });
    k.app.setRepeatMode('one');
    expect(k.app.next(0).outcome).toBe('started');
    expect(currentTitle(k.app)).toBe('T1');
  });

  it('canNext follows the domain rule as the queue moves', () => {
    const k = kit(2);
    expect(k.app.playTrack({ trackId: k.tracks[0]!.id }).state.canNext).toBe(true);
    expect(k.app.next(0).state.canNext).toBe(false);
    expect(k.app.setRepeatMode('all').canNext).toBe(true);
  });
});

describe('Previous (domain: decideOnPreviousPressed, threshold ' + PREVIOUS_RESTART_THRESHOLD_MS + ' ms)', () => {
  it('past the threshold: restarts the current track instead of going back', () => {
    const k = kit();
    k.app.playTrack({ trackId: k.tracks[2]!.id });
    const result = k.app.previous(PREVIOUS_RESTART_THRESHOLD_MS);
    expect(result.outcome).toBe('restart');
    expect(currentTitle(k.app)).toBe('T2');
    expect(result.state.positionMs).toBe(0);
  });

  it('just under the threshold: goes to the previous track', () => {
    const k = kit();
    k.app.playTrack({ trackId: k.tracks[2]!.id });
    expect(k.app.previous(PREVIOUS_RESTART_THRESHOLD_MS - 1).outcome).toBe('started');
    expect(currentTitle(k.app)).toBe('T1');
  });

  it('on the first track under the threshold: restarts it (the domain says "no previous"; the app keeps the button useful)', () => {
    const k = kit();
    k.app.playTrack({ trackId: k.tracks[0]!.id });
    const result = k.app.previous(500);
    expect(result.outcome).toBe('restart');
    expect(currentTitle(k.app)).toBe('T0');
  });

  it('on the first track with repeat ALL: wraps to the last track', () => {
    const k = kit(3);
    k.app.playTrack({ trackId: k.tracks[0]!.id });
    k.app.setRepeatMode('all');
    expect(k.app.previous(0).outcome).toBe('started');
    expect(currentTitle(k.app)).toBe('T2');
  });

  it('is not simply "index minus one": it follows the ACTIVE (shuffled) order', () => {
    const k = kit(6, sequence(0.99, 0.5, 0.2, 0.8, 0.1));
    k.app.playTrack({ trackId: k.tracks[0]!.id });
    k.app.setShuffle(true);
    const order = k.app.next(0).state.current!.track.id;
    expect(order).not.toBe(k.tracks[1]!.id); // proves the queue really was reordered
    k.app.next(0);
    const back = k.app.previous(0);
    expect(back.state.current?.track.id).toBe(order);
  });

  it('treats an invalid position as 0 rather than failing', () => {
    const k = kit();
    k.app.playTrack({ trackId: k.tracks[2]!.id });
    expect(k.app.previous(Number.NaN).outcome).toBe('started');
  });
});

describe('a track finishing on its own (domain: decideOnTrackFinished)', () => {
  it('repeat OFF: plays the next track', () => {
    const k = kit();
    k.app.playTrack({ trackId: k.tracks[0]!.id });
    const result = k.app.trackFinished(k.tracks[0]!.id);
    expect(result.outcome).toBe('started');
    expect(currentTitle(k.app)).toBe('T1');
  });

  it('repeat OFF, queue exhausted: stop - stay on the last track, at the start', () => {
    const k = kit(2);
    k.app.playTrack({ trackId: k.tracks[1]!.id });
    k.app.reportPosition(k.tracks[1]!.id, 200_000);
    const result = k.app.trackFinished(k.tracks[1]!.id);
    expect(result.outcome).toBe('stop');
    expect(currentTitle(k.app)).toBe('T1');
    expect(result.state.positionMs).toBe(0);
    expect(k.session.saved?.positionMs).toBe(0);
  });

  it('repeat ONE: restarts the same track, forever', () => {
    const k = kit(2);
    k.app.playTrack({ trackId: k.tracks[0]!.id });
    k.app.setRepeatMode('one');
    for (let i = 0; i < 3; i += 1) {
      expect(k.app.trackFinished(k.tracks[0]!.id).outcome).toBe('restart');
      expect(currentTitle(k.app)).toBe('T0');
    }
  });

  it('repeat ALL: wraps from the last track to the first', () => {
    const k = kit(2);
    k.app.playTrack({ trackId: k.tracks[1]!.id });
    k.app.setRepeatMode('all');
    expect(k.app.trackFinished(k.tracks[1]!.id).outcome).toBe('started');
    expect(currentTitle(k.app)).toBe('T0');
  });

  it('a one-track queue under repeat ALL restarts that track', () => {
    const k = kit(1);
    k.app.playTrack({ trackId: k.tracks[0]!.id });
    k.app.setRepeatMode('all');
    const result = k.app.trackFinished(k.tracks[0]!.id);
    expect(result.outcome).toBe('started'); // playIndex 0 -> same track, started again
    expect(result.state.current?.track.id).toBe(k.tracks[0]!.id);
  });

  it('ignores a report about a track that is no longer current (a stale "ended")', () => {
    const k = kit();
    k.app.playTrack({ trackId: k.tracks[0]!.id });
    k.app.next(0); // T1 is current now
    const before = k.app.getState();
    const stale = k.app.trackFinished(k.tracks[0]!.id);
    expect(stale.outcome).toBe('none');
    expect(stale.state).toEqual(before);
    expect(currentTitle(k.app)).toBe('T1');
  });

  it('walks a whole queue to exhaustion exactly once (repeat OFF)', () => {
    const k = kit(4);
    k.app.playTrack({ trackId: k.tracks[0]!.id });
    const outcomes: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const current = k.app.getState().current!.track.id;
      outcomes.push(k.app.trackFinished(current).outcome);
    }
    expect(outcomes).toEqual(['started', 'started', 'started', 'stop']);
    expect(currentTitle(k.app)).toBe('T3');
  });
});

describe('shuffle (domain: enableShuffle / disableShuffle, injected randomness)', () => {
  it('enabling keeps the current track current and reorders the rest by the domain algorithm', () => {
    const rnd = sequence(0.3, 0.7, 0.1, 0.9);
    const k = kit(5, rnd);
    k.app.playTrack({ trackId: k.tracks[1]!.id });
    const state = k.app.setShuffle(true);
    expect(state.shuffle).toBe(true);
    expect(state.current?.track.id).toBe(k.tracks[1]!.id);
    expect(state.queueIndex).toBe(0);
    // Reproduce the expected order with the same domain function and the same random sequence.
    const rest = [0, 2, 3, 4].map((i) => k.tracks[i]!.id);
    const expected = [k.tracks[1]!.id, ...fisherYatesShuffle(rest.map((_, i) => i), sequence(0.3, 0.7, 0.1, 0.9)).map((i) => rest[i]!)];
    expect(k.session.saved?.queue.tracks).toEqual(expected);
  });

  it('plays through the shuffled order and every track exactly once', () => {
    const k = kit(6, sequence(0.9, 0.2, 0.6, 0.4, 0.8));
    k.app.playTrack({ trackId: k.tracks[0]!.id });
    k.app.setShuffle(true);
    const seen = [k.app.getState().current!.track.id];
    for (let i = 0; i < 5; i += 1) seen.push(k.app.next(0).state.current!.track.id);
    expect(new Set(seen).size).toBe(6);
    expect(k.app.getState().canNext).toBe(false);
  });

  it('disabling restores the original order and keeps the current track current', () => {
    const k = kit(5, sequence(0.9, 0.1, 0.5));
    k.app.playTrack({ trackId: k.tracks[2]!.id });
    k.app.setShuffle(true);
    k.app.next(0);
    const nowPlaying = k.app.getState().current!.track.id;
    const state = k.app.setShuffle(false);
    expect(state.shuffle).toBe(false);
    expect(state.current?.track.id).toBe(nowPlaying);
    expect(k.session.saved?.queue.tracks).toEqual(ids(k));
    expect(state.queueIndex).toBe(ids(k).indexOf(nowPlaying));
  });

  it('re-enabling shuffle on an already shuffled queue keeps the TRUE original for restoring', () => {
    const k = kit(5, sequence(0.9, 0.1, 0.5, 0.3));
    k.app.playTrack({ trackId: k.tracks[0]!.id });
    k.app.setShuffle(true);
    k.app.setShuffle(true);
    k.app.setShuffle(false);
    expect(k.session.saved?.queue.tracks).toEqual(ids(k));
  });

  it('shuffle works with nothing queued (a mode, not an action)', () => {
    const k = kit();
    expect(k.app.setShuffle(true).shuffle).toBe(true);
    expect(k.app.setShuffle(false).shuffle).toBe(false);
  });
});

describe('repeat mode', () => {
  it.each(['off', 'all', 'one'] as const)('sets and reports %s', (mode) => {
    const k = kit();
    expect(k.app.setRepeatMode(mode).repeatMode).toBe(mode);
    expect(k.session.saved?.queue.repeatMode).toBe(mode);
  });
});

describe('position (milliseconds, the domain unit)', () => {
  it('reportPosition stores whole ms for the current track through savePosition, without bumping the revision', () => {
    const k = kit();
    k.app.playTrack({ trackId: k.tracks[0]!.id });
    const revision = k.app.getState().revision;
    expect(k.app.reportPosition(k.tracks[0]!.id, 12_345)).toEqual({ saved: true });
    expect(k.session.positionWrites).toEqual([12_345]);
    expect(k.app.getState()).toMatchObject({ positionMs: 12_345, revision });
  });

  it('ignores a report for a track that is not current (a late report from the previous track)', () => {
    const k = kit();
    k.app.playTrack({ trackId: k.tracks[0]!.id });
    k.app.next(0);
    expect(k.app.reportPosition(k.tracks[0]!.id, 50_000)).toEqual({ saved: false });
    expect(k.app.getState().positionMs).toBe(0);
    expect(k.session.positionWrites).toEqual([]);
  });

  it.each([[-1], [1.5], [Number.NaN], [Number.POSITIVE_INFINITY]])('rejects the position %s', (bad) => {
    const k = kit();
    k.app.playTrack({ trackId: k.tracks[0]!.id });
    expect(k.app.reportPosition(k.tracks[0]!.id, bad)).toEqual({ saved: false });
    expect(k.session.positionWrites).toEqual([]);
  });

  it('a failing save is contained: reported, not thrown, and the command still succeeds', () => {
    const k = kit();
    k.session.save = () => {
      throw new Error('disk full');
    };
    k.session.savePosition = () => {
      throw new Error('disk full');
    };
    expect(k.app.playTrack({ trackId: k.tracks[0]!.id }).outcome).toBe('started');
    expect(k.app.reportPosition(k.tracks[0]!.id, 10)).toEqual({ saved: false });
    expect(k.errors).toHaveLength(2);
  });
});

describe('persistence: restoring a session at startup', () => {
  it('restores queue, current track, modes, shuffle snapshot and position - paused (position only, no autoplay data)', () => {
    const k = kit(5, sequence(0.9, 0.1, 0.5));
    k.app.playTrack({ trackId: k.tracks[1]!.id });
    k.app.setShuffle(true);
    k.app.setRepeatMode('all');
    k.app.next(0);
    const current = k.app.getState().current!.track.id;
    k.app.reportPosition(current, 31_000);
    const before = k.app.getState();

    const restored = k.rebuild().getState();
    expect(restored.current?.track.id).toBe(current);
    expect(restored).toMatchObject({ positionMs: 31_000, repeatMode: 'all', shuffle: true, queueLength: before.queueLength, queueIndex: before.queueIndex, canNext: before.canNext });
    // Turning shuffle off after a restart still restores the true original order.
    k.rebuild();
    expect(k.app.setShuffle(false).current?.track.id).toBe(current);
    expect(k.session.saved?.queue.tracks).toEqual(ids(k));
  });

  it('drops tracks that left the library while the app was closed, and persists the pruned queue', () => {
    const k = kit(4);
    k.app.playTrack({ trackId: k.tracks[2]!.id });
    k.app.reportPosition(k.tracks[2]!.id, 8_000);
    k.library.delete(k.tracks[0]!.id);
    const restored = k.rebuild().getState();
    expect(restored.queueLength).toBe(3);
    expect(restored.current?.track.id).toBe(k.tracks[2]!.id);
    expect(restored.positionMs).toBe(8_000);
    expect(k.session.saved?.queue.tracks).toEqual([k.tracks[1]!.id, k.tracks[2]!.id, k.tracks[3]!.id]);
  });

  it('if the CURRENT track left the library, the next one becomes current and the position resets', () => {
    const k = kit(4);
    k.app.playTrack({ trackId: k.tracks[1]!.id });
    k.app.reportPosition(k.tracks[1]!.id, 8_000);
    k.library.delete(k.tracks[1]!.id);
    const restored = k.rebuild().getState();
    expect(restored.current?.track.id).toBe(k.tracks[2]!.id);
    expect(restored.positionMs).toBe(0);
  });

  it('if every queued track left the library, the session is empty', () => {
    const k = kit(2);
    k.app.playTrack({ trackId: k.tracks[0]!.id });
    k.library.clear();
    expect(k.rebuild().getState()).toMatchObject({ current: undefined, queueLength: 0, positionMs: 0 });
  });

  it('an unreadable saved session is reported, cleared, and the app starts empty', () => {
    const k = kit();
    k.session.load = () => {
      throw new Error('corrupt');
    };
    const state = k.rebuild().getState();
    expect(state.current).toBeUndefined();
    expect(k.errors).toHaveLength(1);
    expect(k.session.saved).toBeUndefined();
  });

  it('works end-to-end over the real SQLite repository', () => {
    const k = kit(4);
    const db: NovaDatabase = openDatabase({ filePath: IN_MEMORY_DATABASE });
    try {
      const real = new SqlitePlaybackSessionRepository(db);
      const make = () =>
        createPlaybackApplication({
          trackRepository: { getById: (id) => k.library.get(id), listFileStates: () => [...k.library.values()].map((t) => ({ id: t.id, sourcePath: t.sourcePath, sizeBytes: 1, modifiedAtMs: 0 })) },
          playbackSessionRepository: real,
          library: { listTracks: () => [...k.library.values()], searchTracks: () => [], getGroup: () => { throw new Error('unused'); } },
          mediaAccess: { resolveTrack: async () => ({ ok: false, denial: 'file-missing' }) },
        });
      const first = make();
      first.playTrack({ trackId: k.tracks[2]!.id });
      first.setRepeatMode('one');
      first.reportPosition(k.tracks[2]!.id, 4_242);
      const second = make().getState();
      expect(second).toMatchObject({ positionMs: 4_242, repeatMode: 'one', queueLength: 4, queueIndex: 2 });
      expect(second.current?.track.id).toBe(k.tracks[2]!.id);
    } finally {
      db.close();
    }
  });
});

describe('reconcileLibrary: playback follows the library', () => {
  let k: Kit;
  beforeEach(() => {
    k = kit(4);
    k.app.playTrack({ trackId: k.tracks[1]!.id });
    k.events.length = 0;
  });

  it('does nothing and emits nothing when nothing relevant changed', () => {
    const revision = k.app.getState().revision;
    k.app.reconcileLibrary();
    expect(k.events).toEqual([]);
    expect(k.app.getState().revision).toBe(revision);
  });

  it('a track elsewhere in the queue leaving: pruned, current unchanged, "library-changed"', () => {
    k.library.delete(k.tracks[3]!.id);
    k.app.reconcileLibrary();
    expect(k.events).toHaveLength(1);
    expect(k.events[0]).toMatchObject({ reason: 'library-changed' });
    expect(k.app.getState()).toMatchObject({ queueLength: 3, queueIndex: 1 });
    expect(currentTitle(k.app)).toBe('T1');
  });

  it('a track BEFORE the current one leaving shifts the index but keeps the same track current', () => {
    k.library.delete(k.tracks[0]!.id);
    k.app.reconcileLibrary();
    expect(currentTitle(k.app)).toBe('T1');
    expect(k.app.getState().queueIndex).toBe(0);
  });

  it('the CURRENT track leaving: "track-removed", the domain moves on, position resets, and the event tells the renderer', () => {
    k.app.reportPosition(k.tracks[1]!.id, 5_000);
    k.library.delete(k.tracks[1]!.id);
    k.app.reconcileLibrary();
    expect(k.events).toHaveLength(1);
    expect(k.events[0]).toMatchObject({ reason: 'track-removed' });
    const state = k.events[0]!.state;
    expect(state.current?.track.id).toBe(k.tracks[2]!.id);
    expect(state.positionMs).toBe(0);
    expect(k.session.saved?.queue.tracks).not.toContain(k.tracks[1]!.id);
  });

  it('the last remaining track leaving: nothing current, nothing playable', () => {
    for (const t of k.tracks) k.library.delete(t.id);
    k.app.reconcileLibrary();
    expect(k.events[0]).toMatchObject({ reason: 'track-removed' });
    expect(k.app.getState()).toMatchObject({ current: undefined, queueLength: 0 });
  });

  it('refreshed metadata for the current track is pushed ("library-changed") and keeps its identity', () => {
    const renamed = { ...k.tracks[1]!, title: 'Renamed Song', sourcePath: '/moved/elsewhere.mp3' };
    k.library.set(renamed.id, renamed);
    k.app.reconcileLibrary();
    expect(k.events).toHaveLength(1);
    expect(k.events[0]!.state.current?.track.id).toBe(k.tracks[1]!.id);
    expect(k.events[0]!.state.current?.track.title).toBe('Renamed Song');
    // Idempotent: reconciling again without changes emits nothing more.
    k.app.reconcileLibrary();
    expect(k.events).toHaveLength(1);
  });

  it('does not emit after dispose, and a throwing subscriber cannot break it', () => {
    k.app.subscribe(() => {
      throw new Error('bad subscriber');
    });
    k.library.delete(k.tracks[3]!.id);
    k.app.reconcileLibrary();
    expect(k.errors).toHaveLength(1);
    expect(k.events).toHaveLength(1);
    k.app.dispose();
    k.library.delete(k.tracks[2]!.id);
    k.app.reconcileLibrary();
    expect(k.events).toHaveLength(1);
  });

  it('revisions only ever increase', () => {
    const r0 = k.app.getState().revision;
    k.app.next(0);
    const r1 = k.app.getState().revision;
    k.library.delete(k.tracks[3]!.id);
    k.app.reconcileLibrary();
    const r2 = k.app.getState().revision;
    expect([r0 < r1, r1 < r2]).toEqual([true, true]);
  });
});

describe('media address versioning (a retry after a failure must be a fresh request)', () => {
  it('starts unversioned, and diagnosing a failure bumps the version in the current track\'s address', async () => {
    const k = kit();
    k.app.playTrack({ trackId: k.tracks[0]!.id });
    expect(k.app.getState().current?.mediaUrl).toBe(`nova-media://track/${k.tracks[0]!.id}`);
    k.denials.set(k.tracks[0]!.id, 'root-unavailable');
    await k.app.diagnoseSource(k.tracks[0]!.id);
    expect(k.app.getState().current?.mediaUrl).toBe(`nova-media://track/${k.tracks[0]!.id}?v=1`);
    await k.app.diagnoseSource(k.tracks[0]!.id);
    expect(k.app.getState().current?.mediaUrl).toBe(`nova-media://track/${k.tracks[0]!.id}?v=2`);
  });

  it('bumps even when main can open the file (a decoder failure is retried fresh too) and never changes the revision', async () => {
    const k = kit();
    k.app.playTrack({ trackId: k.tracks[0]!.id });
    const revision = k.app.getState().revision;
    expect(await k.app.diagnoseSource(k.tracks[0]!.id)).toBeUndefined();
    expect(k.app.getState().current?.mediaUrl).toMatch(/\?v=1$/);
    expect(k.app.getState().revision).toBe(revision);
  });
});

describe('diagnoseSource', () => {
  it('reports no problem when media access allows the track', async () => {
    const k = kit();
    expect(await k.app.diagnoseSource(k.tracks[0]!.id)).toBeUndefined();
  });

  it.each(['file-missing', 'root-unavailable', 'unsupported-format', 'outside-root'] as const)('passes the access denial %s through', async (denial) => {
    const k = kit();
    k.denials.set(k.tracks[0]!.id, denial);
    expect(await k.app.diagnoseSource(k.tracks[0]!.id)).toBe(denial);
  });
});

void EMPTY_QUEUE;

/* ------------------------------------------------------------------ *
 * Phase 5: library-aware playback, queue editing, and the queue policy
 * ------------------------------------------------------------------ */

function albumKit() {
  const k = kit(0);
  const mk = (title: string, artist: string, album: string | undefined, trackNumber: number | undefined, genre = 'Rock') =>
    makeTrack({ title, artist, album, trackNumber, genre, albumArtist: undefined });
  const a1 = mk('A one', 'Alpha', 'First', 1);
  const a2 = mk('A two', 'Alpha', 'First', 2);
  const a3 = mk('A three', 'Alpha', 'First', 3);
  const b1 = mk('B one', 'Beta', 'Other', 1, 'Jazz');
  const b2 = mk('B two', 'Beta', undefined, undefined, 'Jazz');
  const all = [a1, a2, a3, b1, b2];
  for (const track of all) k.library.set(track.id, track);
  const keyOf = (kind: 'album' | 'artist' | 'genre', name: string): string => {
    const found = selectKey(k, kind, name);
    if (found === undefined) throw new Error(`no ${kind} ${name}`);
    return found;
  };
  return { k, a1, a2, a3, b1, b2, keyOf };
}

import { groupTracks } from '@nova/domain';
function selectKey(k: Kit, kind: 'album' | 'artist' | 'genre', name: string): string | undefined {
  return groupTracks([...k.library.values()], kind).find((g) => g.name === name)?.key;
}

const queueTitles = (app: PlaybackApplication): string[] => app.getQueue({ limit: 1000 }).items.map((item) => item.track.title);

describe('playGroup: Play on an album / artist / genre', () => {
  it('queues the album in album order and starts its first track', () => {
    const { k, keyOf } = albumKit();
    const result = k.app.playGroup({ group: { kind: 'album', key: keyOf('album', 'First') } });
    expect(result.outcome).toBe('started');
    expect(result.state.queueLength).toBe(3);
    expect(result.state.current?.track.title).toBe('A one');
    expect(queueTitles(k.app)).toEqual(['A one', 'A two', 'A three']);
  });

  it('queues an artist album by album, and a genre across artists', () => {
    const { k, keyOf } = albumKit();
    k.app.playGroup({ group: { kind: 'artist', key: keyOf('artist', 'Beta') } });
    expect(queueTitles(k.app)).toEqual(['B one', 'B two']); // known album first, unknown album last
    k.app.playGroup({ group: { kind: 'genre', key: keyOf('genre', 'Rock') } });
    expect(queueTitles(k.app)).toEqual(['A one', 'A two', 'A three']);
  });

  it('honours the sort the user chose and keeps the repeat/shuffle modes', () => {
    const { k, keyOf } = albumKit();
    k.app.setRepeatMode('all');
    const result = k.app.playGroup({ group: { kind: 'album', key: keyOf('album', 'First') }, sort: { field: 'title', direction: 'desc' } });
    expect(queueTitles(k.app)).toEqual(['A two', 'A three', 'A one']);
    expect(result.state.repeatMode).toBe('all');
  });

  it('a group that no longer exists is a typed error that changes nothing', () => {
    const { k } = albumKit();
    expect(() => k.app.playGroup({ group: { kind: 'album', key: 'nope' } })).toThrow(LibraryApplicationError);
    expect(k.app.getState().queueLength).toBe(0);
  });

  it('playTrack from a group context queues that group with the chosen track current; library context honours sort', () => {
    const { k, a2, keyOf } = albumKit();
    const state = k.app.playTrack({ trackId: a2.id, context: { kind: 'group', group: { kind: 'album', key: keyOf('album', 'First') } } }).state;
    expect(state.queueIndex).toBe(1);
    expect(queueTitles(k.app)).toEqual(['A one', 'A two', 'A three']);
    k.app.playTrack({ trackId: a2.id, context: { kind: 'library', sort: { field: 'title', direction: 'desc' } } });
    expect(queueTitles(k.app)[0]).toBe('B two');
  });
});

describe('enqueue: add to queue / play next', () => {
  it('appends a track at the end and inserts "next" right after the current track', () => {
    const { k, a1, a2, a3, b1 } = albumKit();
    k.app.playTrack({ trackId: a1.id, context: { kind: 'search', query: 'x' } }); // not in list -> just a1
    k.app.enqueue({ position: 'last', trackId: a2.id });
    k.app.enqueue({ position: 'last', trackId: a3.id });
    k.app.enqueue({ position: 'next', trackId: b1.id });
    expect(queueTitles(k.app)).toEqual(['A one', 'B one', 'A two', 'A three']);
    expect(k.app.getState().queueIndex).toBe(0);
  });

  it('adds a whole group; never changes the current track or its position', () => {
    const { k, b1, keyOf } = albumKit();
    k.app.playTrack({ trackId: b1.id, context: { kind: 'search', query: 'x' } });
    k.app.reportPosition(b1.id, 7_000);
    const result = k.app.enqueue({ position: 'last', group: { kind: 'album', key: keyOf('album', 'First') } });
    expect(result.added).toBe(3);
    expect(result.outcome).toBe('none');
    expect(result.state.current?.track.id).toBe(b1.id);
    expect(result.state.positionMs).toBe(7_000);
  });

  it('adding to an empty queue makes the track current but does not start anything', () => {
    const { k, a1 } = albumKit();
    const result = k.app.enqueue({ position: 'last', trackId: a1.id });
    expect(result.outcome).toBe('none');
    expect(result.state.current?.track.id).toBe(a1.id);
    expect(result.state.queueLength).toBe(1);
  });

  it('refuses an unknown track or a vanished group with typed errors', () => {
    const { k } = albumKit();
    expect(() => k.app.enqueue({ position: 'last', trackId: createTrackId() })).toThrow(PlaybackApplicationError);
    expect(() => k.app.enqueue({ position: 'last', trackId: 'not-an-id' })).toThrow(PlaybackApplicationError);
    expect(() => k.app.enqueue({ position: 'last' })).toThrow(PlaybackApplicationError);
    expect(() => k.app.enqueue({ position: 'next', group: { kind: 'genre', key: 'n:none' } })).toThrow(LibraryApplicationError);
    expect(k.app.getState().queueLength).toBe(0);
  });
});

describe('getQueue', () => {
  it('returns a window with absolute positions, the total and the current index', () => {
    const k = kit(10);
    k.app.playTrack({ trackId: k.tracks[4]!.id });
    const window = k.app.getQueue({ offset: 3, limit: 4 });
    expect(window.total).toBe(10);
    expect(window.currentIndex).toBe(4);
    expect(window.offset).toBe(3);
    expect(window.items.map((i) => i.position)).toEqual([3, 4, 5, 6]);
    expect(window.revision).toBe(k.app.getState().revision);
  });

  it('clamps a window past the end and defaults sensibly; an empty queue is an empty window', () => {
    const k = kit(3);
    expect(k.app.getQueue().items).toEqual([]);
    k.app.playTrack({ trackId: k.tracks[0]!.id });
    expect(k.app.getQueue({ offset: 99 })).toMatchObject({ offset: 3, items: [] });
    expect(k.app.getQueue({ limit: 0 }).items).toEqual([]);
    expect(k.app.getQueue().items).toHaveLength(3);
  });
});

describe('queue editing', () => {
  let k: Kit;
  beforeEach(() => {
    k = kit(5);
    k.app.playTrack({ trackId: k.tracks[1]!.id });
    k.events.length = 0;
  });
  const tid = (i: number) => k.tracks[i]!.id;

  it('playQueueItem jumps to a queued track and starts it', () => {
    const result = k.app.playQueueItem(3, tid(3));
    expect(result.outcome).toBe('started');
    expect(result.state.queueIndex).toBe(3);
    expect(currentTitle(k.app)).toBe('T3');
    expect(result.state.positionMs).toBe(0);
  });

  it('removing an upcoming track keeps the current one playing; removing an earlier one shifts the index only', () => {
    const afterUpcoming = k.app.removeFromQueue(3, tid(3));
    expect(afterUpcoming.state.current?.track.id).toBe(tid(1));
    expect(queueTitles(k.app)).toEqual(['T0', 'T1', 'T2', 'T4']);
    const afterEarlier = k.app.removeFromQueue(0, tid(0));
    expect(afterEarlier.state.queueIndex).toBe(0);
    expect(currentTitle(k.app)).toBe('T1');
  });

  it('removing the CURRENT track moves on to what would have played next, from the start', () => {
    k.app.reportPosition(tid(1), 9_000);
    const result = k.app.removeFromQueue(1, tid(1));
    expect(result.outcome).toBe('none'); // the renderer follows main's current track, keeping play/pause
    expect(result.state.current?.track.id).toBe(tid(2));
    expect(result.state.positionMs).toBe(0);
    expect(k.session.saved?.queue.tracks).not.toContain(tid(1));
  });

  it('removing the only track leaves nothing current', () => {
    const solo = kit(1);
    solo.app.playTrack({ trackId: solo.tracks[0]!.id });
    const result = solo.app.removeFromQueue(0, solo.tracks[0]!.id);
    expect(result.state).toMatchObject({ current: undefined, queueLength: 0 });
  });

  it('removal leaves repeat and shuffle modes untouched', () => {
    k.app.setRepeatMode('one');
    k.app.setShuffle(true);
    const queue = k.app.getQueue({ limit: 10 }).items;
    const victim = queue.find((item) => item.position !== k.app.getState().queueIndex)!;
    const state = k.app.removeFromQueue(victim.position, victim.track.id).state;
    expect(state).toMatchObject({ repeatMode: 'one', shuffle: true, queueLength: 4 });
  });

  it('moveQueueItem reorders without changing which track is current', () => {
    const result = k.app.moveQueueItem(4, tid(4), 0);
    expect(queueTitles(k.app)).toEqual(['T4', 'T0', 'T1', 'T2', 'T3']);
    expect(result.state.current?.track.id).toBe(tid(1));
    expect(result.state.queueIndex).toBe(2);
    k.app.moveQueueItem(2, tid(1), 4); // moving the current track itself keeps it current
    expect(currentTitle(k.app)).toBe('T1');
    expect(k.app.getState().queueIndex).toBe(4);
  });

  it('clearQueue keeps only the current track, which keeps its position and modes', () => {
    k.app.reportPosition(tid(1), 5_500);
    k.app.setRepeatMode('all');
    const result = k.app.clearQueue();
    expect(result.outcome).toBe('none');
    expect(queueTitles(k.app)).toEqual(['T1']);
    expect(result.state).toMatchObject({ queueLength: 1, queueIndex: 0, positionMs: 5_500, repeatMode: 'all', canNext: true });
  });

  it('clearing an already-minimal or empty queue changes nothing (no revision bump)', () => {
    k.app.clearQueue();
    const revision = k.app.getState().revision;
    expect(k.app.clearQueue().outcome).toBe('none');
    expect(k.app.getState().revision).toBe(revision);
    expect(kit(0).app.clearQueue().state.revision).toBe(0);
  });

  it('a STALE edit (the track is no longer at that index) does nothing at all', () => {
    const revision = k.app.getState().revision;
    expect(k.app.removeFromQueue(3, tid(0)).state.queueLength).toBe(5);
    expect(k.app.moveQueueItem(3, tid(0), 0).state.queueLength).toBe(5);
    expect(k.app.playQueueItem(3, tid(0)).outcome).toBe('none');
    expect(k.app.playQueueItem(99, tid(0)).outcome).toBe('none');
    expect(k.app.removeFromQueue(-1, tid(0)).state.queueLength).toBe(5);
    expect(k.app.getState().revision).toBe(revision);
    expect(k.app.getState().queueIndex).toBe(1);
  });

  it('rejects invalid move targets', () => {
    const revision = k.app.getState().revision;
    for (const to of [-1, 5, 1.5, Number.NaN, 3]) {
      if (to === 3) continue; // a valid target is covered above
      expect(k.app.moveQueueItem(3, tid(3), to).state.revision).toBe(revision);
    }
    expect(k.app.moveQueueItem(3, tid(3), 3).state.revision).toBe(revision);
  });

  it('edits are persisted so they survive a restart', () => {
    k.app.removeFromQueue(0, tid(0));
    k.app.moveQueueItem(3, tid(4), 0);
    const restored = k.rebuild();
    expect(queueTitles(restored)).toEqual(['T4', 'T1', 'T2', 'T3']);
    expect(restored.getState().current?.track.id).toBe(tid(1));
  });
});

describe('the queue policy when the library changes (a deliberate snapshot)', () => {
  it('tracks added to the library afterwards are NOT appended to the queue', () => {
    const k = kit(3);
    k.app.playTrack({ trackId: k.tracks[0]!.id });
    const before = queueTitles(k.app);
    const added = makeTrack({ title: 'Newly scanned' });
    k.library.set(added.id, added);
    k.app.reconcileLibrary();
    expect(queueTitles(k.app)).toEqual(before);
    expect(k.app.getState().queueLength).toBe(3);
    expect(k.events.filter((e) => e.type === 'state-changed')).toEqual([]); // nothing visible changed, nothing is pushed
    // ... yet the track is in the library, so the NEXT list played from it includes it.
    k.app.playTrack({ trackId: added.id });
    expect(queueTitles(k.app)).toContain('Newly scanned');
  });

  it('removed tracks are pruned; user edits survive a reconcile', () => {
    const k = kit(4);
    k.app.playTrack({ trackId: k.tracks[0]!.id });
    k.app.moveQueueItem(3, k.tracks[3]!.id, 1);
    k.library.delete(k.tracks[2]!.id);
    k.app.reconcileLibrary();
    expect(queueTitles(k.app)).toEqual(['T0', 'T3', 'T1']);
  });
});

describe('Phase 7: the track-started event (what the desktop shell notifies on)', () => {
  const started = (k: Kit) => k.events.filter((e) => e.type === 'track-started');
  const titleOf = (event: PlaybackApplicationEvent | undefined) => (event?.type === 'track-started' ? event.state.current?.track.title : undefined);

  it('playTrack emits exactly one track-started carrying the new current track', () => {
    const k = kit(3);
    k.app.playTrack({ trackId: k.tracks[1]!.id });
    expect(started(k)).toHaveLength(1);
    expect(titleOf(started(k)[0])).toBe(k.tracks[1]!.title);
  });

  it('playGroup, playQueueItem, next, previous and a track ending into the next one each emit one', () => {
    const k = kit(4);
    k.app.playTrack({ trackId: k.tracks[0]!.id });
    k.events.length = 0;
    k.app.next(0);
    k.app.next(0);
    expect(started(k).map(titleOf)).toEqual([k.tracks[1]!.title, k.tracks[2]!.title]);
    k.events.length = 0;
    k.app.previous(0); // early in the track: goes back
    expect(started(k).map(titleOf)).toEqual([k.tracks[1]!.title]);
    k.events.length = 0;
    k.app.trackFinished(k.tracks[1]!.id);
    expect(started(k).map(titleOf)).toEqual([k.tracks[2]!.title]);
    k.events.length = 0;
    k.app.playQueueItem(0, k.tracks[0]!.id);
    expect(started(k).map(titleOf)).toEqual([k.tracks[0]!.title]);
  });

  it('emits NO track-started for a restart of the same track (Previous past the threshold, repeat one)', () => {
    const k = kit(3);
    k.app.playTrack({ trackId: k.tracks[0]!.id });
    k.app.next(0);
    k.events.length = 0;
    expect(k.app.previous(10_000).outcome).toBe('restart');
    k.app.setRepeatMode('one');
    expect(k.app.trackFinished(k.tracks[1]!.id).outcome).toBe('restart');
    expect(started(k)).toEqual([]);
  });

  it('emits nothing for commands that start nothing: stop at the end, a stale queue click, queue edits, modes, position', () => {
    const k = kit(3);
    k.app.playTrack({ trackId: k.tracks[2]!.id });
    k.events.length = 0;
    expect(k.app.trackFinished(k.tracks[2]!.id).outcome).toBe('stop');
    expect(k.app.next(0).outcome).toBe('none');
    k.app.playQueueItem(0, 'not-the-track-at-0');
    k.app.moveQueueItem(0, k.tracks[0]!.id, 1);
    k.app.setShuffle(true);
    k.app.setRepeatMode('all');
    k.app.reportPosition(k.tracks[2]!.id, 1000);
    expect(started(k)).toEqual([]);
  });

  it('a restored session at launch emits nothing (the app starts paused and silent)', () => {
    const k = kit(3);
    k.app.playTrack({ trackId: k.tracks[1]!.id });
    k.events.length = 0;
    k.rebuild(); // a new service restoring the saved session
    expect(started(k)).toEqual([]);
  });

  it('a subscriber that throws cannot break the command, and is reported', () => {
    const k = kit(2);
    k.app.subscribe((e) => {
      if (e.type === 'track-started') throw new Error('notifier exploded');
    });
    expect(k.app.playTrack({ trackId: k.tracks[0]!.id }).outcome).toBe('started');
    expect(k.errors).toHaveLength(1);
  });

  it('no event after dispose', () => {
    const k = kit(2);
    k.app.dispose();
    k.events.length = 0;
    try {
      k.app.playTrack({ trackId: k.tracks[0]!.id });
    } catch {
      /* a disposed service may refuse; either way nothing is emitted */
    }
    expect(started(k)).toEqual([]);
  });
});
