import { sortTracks, type PersistedPlaybackSession, type Track, type TrackId } from '@nova/domain';
import { beforeEach, describe, expect, it } from 'vitest';
import { makeTrack } from '../repositories/test-tracks.js';
import { CollectionsApplicationError, type ListSource } from './collections-application.js';
import { createHistoryRecorder } from './history-recorder.js';
import { createPlaybackApplication, PlaybackApplicationError, type PlaybackActivityEvent, type PlaybackApplication } from './playback-application.js';

interface Kit {
  app: PlaybackApplication;
  tracks: Track[];
  lists: Map<string, TrackId[]>;
}

function kit(random: () => number = () => 0.5): Kit {
  const tracks = Array.from({ length: 5 }, (_, i) => makeTrack({ title: `T${i}` }));
  const byId = new Map(tracks.map((t) => [t.id, t]));
  const lists = new Map<string, TrackId[]>();
  let saved: PersistedPlaybackSession | undefined;
  const app = createPlaybackApplication({
    trackRepository: { getById: (id) => byId.get(id), listFileStates: () => tracks.map((t) => ({ id: t.id, sourcePath: t.sourcePath, sizeBytes: 1, modifiedAtMs: 0 })) },
    playbackSessionRepository: { load: () => saved, save: (s) => void (saved = s), savePosition: () => undefined, clear: () => void (saved = undefined) },
    library: {
      listTracks: (sort) => sortTracks(tracks, sort ?? { field: 'title', direction: 'asc' }),
      getGroup: () => {
        throw new Error('unused');
      },
      searchTracks: () => [],
    },
    mediaAccess: { resolveTrack: async () => ({ ok: true, filePath: '/x.mp3' as never, contentType: 'audio/mpeg' }) },
    collections: {
      listSourceTrackIds: (source: ListSource) => {
        const key = source.kind === 'playlist' ? `playlist:${source.playlistId}` : source.kind;
        const ids = lists.get(key);
        if (ids === undefined) throw new CollectionsApplicationError('playlist-not-found', 'gone');
        return ids;
      },
    },
    random,
  });
  return { app, tracks, lists };
}

const queueIds = (app: PlaybackApplication): string[] => app.getQueue({ limit: 100 }).items.map((i) => i.track.id);

describe('list contexts', () => {
  let k: Kit;
  beforeEach(() => {
    k = kit();
    k.lists.set('favorites', [k.tracks[3]!.id, k.tracks[1]!.id, k.tracks[4]!.id]);
  });

  it('playTrack with a list context queues the list in ITS order and starts the chosen track', () => {
    const result = k.app.playTrack({ trackId: k.tracks[1]!.id, context: { kind: 'list', source: { kind: 'favorites' } } });
    expect(result.outcome).toBe('started');
    expect(queueIds(k.app)).toEqual([k.tracks[3]!.id, k.tracks[1]!.id, k.tracks[4]!.id]);
    expect(result.state.queueIndex).toBe(1);
  });

  it('a track not in the list plays alone (the list changed under the listener)', () => {
    k.app.playTrack({ trackId: k.tracks[0]!.id, context: { kind: 'list', source: { kind: 'favorites' } } });
    expect(queueIds(k.app)).toEqual([k.tracks[0]!.id]);
  });

  it('an unknown playlist is refused with playlist-not-found and the queue is untouched', () => {
    k.app.playTrack({ trackId: k.tracks[0]!.id });
    expect(() => k.app.playTrack({ trackId: k.tracks[0]!.id, context: { kind: 'list', source: { kind: 'playlist', playlistId: 'x' } } })).toThrow(CollectionsApplicationError);
    expect(k.app.getState().queueLength).toBe(5);
  });

  it('a duplicate in a playlist is queued twice', () => {
    k.lists.set('playlist:p', [k.tracks[0]!.id, k.tracks[1]!.id, k.tracks[0]!.id]);
    k.app.playTrack({ trackId: k.tracks[1]!.id, context: { kind: 'list', source: { kind: 'playlist', playlistId: 'p' } } });
    expect(queueIds(k.app)).toEqual([k.tracks[0]!.id, k.tracks[1]!.id, k.tracks[0]!.id]);
  });
});

describe('playList', () => {
  it('starts at the first track by default, keeps the listener\'s modes', () => {
    const k = kit();
    k.lists.set('history', [k.tracks[2]!.id, k.tracks[0]!.id]);
    k.app.setRepeatMode('all');
    const result = k.app.playList({ source: { kind: 'history' } });
    expect(result.outcome).toBe('started');
    expect(result.state.current?.track.id).toBe(k.tracks[2]!.id);
    expect(result.state.repeatMode).toBe('all');
    expect(result.state.shuffle).toBe(false);
  });

  it('starts at startTrackId, and refuses one that is not in the list', () => {
    const k = kit();
    k.lists.set('history', [k.tracks[2]!.id, k.tracks[0]!.id]);
    expect(k.app.playList({ source: { kind: 'history' }, startTrackId: k.tracks[0]!.id }).state.queueIndex).toBe(1);
    expect(() => k.app.playList({ source: { kind: 'history' }, startTrackId: k.tracks[4]!.id })).toThrow(PlaybackApplicationError);
  });

  it('shuffle turns shuffle on and starts at a random track', () => {
    const k = kit(() => 0.99);
    k.lists.set('history', [k.tracks[0]!.id, k.tracks[1]!.id, k.tracks[2]!.id]);
    const result = k.app.playList({ source: { kind: 'history' }, shuffle: true });
    expect(result.state.shuffle).toBe(true);
    expect(result.state.current?.track.id).toBe(k.tracks[2]!.id);
    expect(result.state.queueLength).toBe(3);
  });

  it('shuffle with a start track starts exactly there', () => {
    const k = kit();
    k.lists.set('history', [k.tracks[0]!.id, k.tracks[1]!.id, k.tracks[2]!.id]);
    expect(k.app.playList({ source: { kind: 'history' }, shuffle: true, startTrackId: k.tracks[1]!.id }).state.current?.track.id).toBe(k.tracks[1]!.id);
  });

  it('an empty list is refused', () => {
    const k = kit();
    k.lists.set('favorites', []);
    expect(() => k.app.playList({ source: { kind: 'favorites' } })).toThrow(PlaybackApplicationError);
  });
});

describe('enqueue with a source', () => {
  it('appends or inserts the whole list, in list order', () => {
    const k = kit();
    k.lists.set('favorites', [k.tracks[4]!.id, k.tracks[3]!.id]);
    k.app.playTrack({ trackId: k.tracks[0]!.id, context: { kind: 'search', query: 'none' } });
    expect(k.app.enqueue({ position: 'last', source: { kind: 'favorites' } }).added).toBe(2);
    expect(queueIds(k.app)).toEqual([k.tracks[0]!.id, k.tracks[4]!.id, k.tracks[3]!.id]);
    k.app.enqueue({ position: 'next', source: { kind: 'favorites' } });
    expect(queueIds(k.app)).toEqual([k.tracks[0]!.id, k.tracks[4]!.id, k.tracks[3]!.id, k.tracks[4]!.id, k.tracks[3]!.id]);
  });
});

describe('activity events + history recorder', () => {
  it('emits started, position (only for the current track) and finished', () => {
    const k = kit();
    const events: PlaybackActivityEvent[] = [];
    k.app.subscribeActivity((e) => events.push(e));
    k.app.playTrack({ trackId: k.tracks[0]!.id });
    k.app.reportPosition(k.tracks[0]!.id, 1000);
    k.app.reportPosition(k.tracks[1]!.id, 1000); // not current: ignored
    k.app.trackFinished(k.tracks[1]!.id); // not current: ignored
    k.app.trackFinished(k.tracks[0]!.id);
    expect(events.map((e) => e.type)).toEqual(['track-started', 'position-reported', 'track-finished', 'track-started']);
  });

  function recorded(): { k: Kit; plays: string[]; stop: () => void } {
    const k = kit();
    const plays: string[] = [];
    const stop = createHistoryRecorder({ playback: k.app, record: (id) => plays.push(id) });
    return { k, plays, stop };
  }

  it('records after 5 s of reported position, once per play', () => {
    const { k, plays } = recorded();
    const id = k.tracks[0]!.id;
    k.app.playTrack({ trackId: id });
    k.app.reportPosition(id, 4_999);
    expect(plays).toEqual([]);
    k.app.reportPosition(id, 5_000);
    k.app.reportPosition(id, 9_000);
    k.app.reportPosition(id, 1_000); // seek back, listen again: same play
    k.app.reportPosition(id, 7_000);
    expect(plays).toEqual([id]);
  });

  it('a track skipped before 5 s is never recorded', () => {
    const { k, plays } = recorded();
    k.app.playTrack({ trackId: k.tracks[0]!.id });
    k.app.reportPosition(k.tracks[0]!.id, 3_000);
    k.app.next(3_000);
    k.app.reportPosition(k.tracks[1]!.id, 1_000);
    expect(plays).toEqual([]);
  });

  it('a very short track is recorded when it finishes; repeat-one counts every play', () => {
    const { k, plays } = recorded();
    const id = k.tracks[0]!.id;
    k.app.playTrack({ trackId: id });
    k.app.setRepeatMode('one');
    k.app.trackFinished(id);
    k.app.trackFinished(id);
    expect(plays).toEqual([id, id]);
  });

  it('playing the same track again from the list counts as a new play', () => {
    const { k, plays } = recorded();
    const id = k.tracks[0]!.id;
    k.app.playTrack({ trackId: id });
    k.app.reportPosition(id, 6_000);
    k.app.playTrack({ trackId: id });
    k.app.reportPosition(id, 6_000);
    expect(plays).toEqual([id, id]);
  });

  it('a resumed session (no start event) records once its position passes the threshold; a failing store does not break playback', () => {
    const k = kit();
    k.app.playTrack({ trackId: k.tracks[0]!.id });
    const errors: unknown[] = [];
    createHistoryRecorder({
      playback: k.app,
      record: () => {
        throw new Error('db closed');
      },
      onError: (e) => errors.push(e),
    });
    expect(k.app.reportPosition(k.tracks[0]!.id, 8_000)).toEqual({ saved: true });
    k.app.reportPosition(k.tracks[0]!.id, 9_000);
    expect(errors).toHaveLength(1); // recorded (attempted) once
  });

  it('stops listening when unsubscribed', () => {
    const { k, plays, stop } = recorded();
    stop();
    k.app.playTrack({ trackId: k.tracks[0]!.id });
    k.app.reportPosition(k.tracks[0]!.id, 8_000);
    expect(plays).toEqual([]);
  });
});
