import type { ArtworkDto, AttachLyricsResultDto, GroupKindDto, LyricsDto, PlaybackStateDto, TrackDto, TrackSortDto } from '@nova/shared';
import { createLibraryStore, type LibraryStoreApi } from './library-store.js';
import { createNowPlayingStore, type NowPlayingStoreApi } from '../nowplaying/now-playing-store.js';
import { createPlaybackStore, type PlaybackStoreApi } from '../playback/playback-store.js';
import { command, createPlaybackFakes, mediaUrlFor, playbackState, type PlaybackFakes } from '../playback/test-support.js';
import { compareTracksBy, failure, fakeGroupMembers, fakeGroups, result, root } from './test-support.js';

/* Test-only: a scripted "main process" that holds a REAL queue array and answers every
 * library:* and playback:* channel the Phase 5 UI uses. It is deliberately naive - the real
 * rules (grouping, sorting, queue semantics) are tested in the domain and the application layer;
 * these tests prove the UI sends the right requests and shows what main answers. */

const compareBy = (sort: TrackSortDto | undefined) => compareTracksBy(sort);

export interface FakeMain {
  readonly fakes: PlaybackFakes;
  library: LibraryStoreApi;
  playback: PlaybackStoreApi;
  nowPlaying: NowPlayingStoreApi;
  /** What `track:getLyrics` / `track:getArtwork` answer per track id (default: no lyrics, no artwork). */
  lyrics: Map<string, LyricsDto>;
  artwork: Map<string, ArtworkDto>;
  /** What `track:attachLyrics` answers next (an `attached` answer is remembered as that track's lyrics); `'fail'` answers with an IPC error. */
  attachAnswer: AttachLyricsResultDto | 'fail';
  queue: TrackDto[];
  index: number | undefined;
  tracks: TrackDto[];
  /** Pushes the current playback state to the renderer like main's `playback:stateChanged` event. */
  state(): PlaybackStateDto;
  calls(channel: string): unknown[];
}

export function createFakeMain(initialTracks: TrackDto[], options: { roots?: boolean } = {}): FakeMain {
  const fakes = createPlaybackFakes(playbackState(), { tracks: initialTracks, roots: options.roots === false ? [] : [root(1)] });
  const { bridge } = fakes;
  let revision = 1;
  let repeat: PlaybackStateDto['repeatMode'] = 'off';
  let shuffle = false;
  const main: FakeMain = {
    fakes,
    library: undefined as never,
    playback: undefined as never,
    nowPlaying: undefined as never,
    lyrics: new Map(),
    artwork: new Map(),
    attachAnswer: { outcome: 'cancelled' },
    queue: [],
    index: undefined,
    tracks: initialTracks,
    state: () => {
      const current = main.index === undefined ? undefined : main.queue[main.index];
      return {
        revision,
        ...(current !== undefined && { current: { track: current, mediaUrl: mediaUrlFor(current) } }),
        positionMs: 0,
        repeatMode: repeat,
        shuffle,
        queueLength: main.queue.length,
        ...(main.index !== undefined && { queueIndex: main.index }),
        canNext: main.index !== undefined && main.index < main.queue.length - 1,
      };
    },
    calls: (channel) => bridge.callsTo(channel),
  };
  const done = (outcome: 'started' | 'none') => {
    revision += 1;
    return command(outcome, main.state());
  };
  const live = (): TrackDto[] => fakes.bridge.backend.tracks;

  bridge.on('library:listTracks', (r) => {
    const sort = (r as { sort?: TrackSortDto }).sort;
    const all = [...live()].sort(compareBy(sort));
    return result({ total: all.length, offset: 0, tracks: all });
  });
  bridge.on('library:getGroup', (r) => {
    const { kind, key, sort } = r as { kind: GroupKindDto; key: string; sort?: TrackSortDto };
    const group = fakeGroups(live(), kind).find((g) => g.key === key);
    if (group === undefined) return failure('group-not-found', 'That album, artist or genre is no longer in the library.', 'library:getGroup');
    return result({ group, tracks: fakeGroupMembers(live(), kind, key).sort(compareBy(sort)) });
  });

  bridge.on('playback:getState', () => result(main.state()));
  bridge.on('playback:playTrack', (r) => {
    const { trackId, context } = r as { trackId: string; context?: { kind: string; query?: string; group?: { kind: GroupKindDto; key: string }; sort?: TrackSortDto } };
    let list = [...live()].sort(compareBy(context?.kind === 'library' ? context.sort : undefined));
    if (context?.kind === 'search') list = fakes.bridge.backend.search(context.query ?? '').map((x) => x.track);
    if (context?.kind === 'group' && context.group) list = fakeGroupMembers(live(), context.group.kind, context.group.key).sort(compareBy(context.sort));
    main.queue = list;
    main.index = Math.max(0, list.findIndex((t) => t.id === trackId));
    return done('started');
  });
  bridge.on('playback:playGroup', (r) => {
    const { group, sort } = r as { group: { kind: GroupKindDto; key: string }; sort?: TrackSortDto };
    main.queue = fakeGroupMembers(live(), group.kind, group.key).sort(compareBy(sort));
    main.index = 0;
    return done('started');
  });
  bridge.on('playback:enqueue', (r) => {
    const req = r as { position: 'next' | 'last'; trackId?: string; group?: { kind: GroupKindDto; key: string } };
    const added = req.trackId !== undefined ? live().filter((t) => t.id === req.trackId) : fakeGroupMembers(live(), req.group!.kind, req.group!.key);
    if (req.position === 'next' && main.index !== undefined) main.queue.splice(main.index + 1, 0, ...added);
    else main.queue.push(...added);
    if (main.index === undefined && main.queue.length > 0) main.index = 0;
    return done('none');
  });
  bridge.on('playback:getQueue', (r) => {
    const { offset = 0, limit = 200 } = r as { offset?: number; limit?: number };
    const items = main.queue.slice(offset, offset + limit).map((track, i) => ({ position: offset + i, track }));
    return result({ revision, total: main.queue.length, ...(main.index !== undefined && { currentIndex: main.index }), offset, items });
  });
  bridge.on('playback:playQueueItem', (r) => {
    const { index, trackId } = r as { index: number; trackId: string };
    if (main.queue[index]?.id !== trackId) return command('none', main.state());
    main.index = index;
    return done('started');
  });
  bridge.on('playback:removeFromQueue', (r) => {
    const { index, trackId } = r as { index: number; trackId: string };
    if (main.queue[index]?.id !== trackId) return command('none', main.state());
    main.queue.splice(index, 1);
    if (main.index !== undefined) {
      if (main.queue.length === 0) main.index = undefined;
      else if (index < main.index) main.index -= 1;
      else if (index === main.index) main.index = Math.min(main.index, main.queue.length - 1);
    }
    return done('none');
  });
  bridge.on('playback:moveQueueItem', (r) => {
    const { index, trackId, toIndex } = r as { index: number; trackId: string; toIndex: number };
    if (main.queue[index]?.id !== trackId) return command('none', main.state());
    const currentId = main.index === undefined ? undefined : main.queue[main.index]?.id;
    const [moved] = main.queue.splice(index, 1);
    main.queue.splice(toIndex, 0, moved!);
    if (currentId !== undefined) main.index = main.queue.findIndex((t) => t.id === currentId);
    return done('none');
  });
  bridge.on('playback:clearQueue', () => {
    const current = main.index === undefined ? undefined : main.queue[main.index];
    main.queue = current === undefined ? [] : [current];
    main.index = current === undefined ? undefined : 0;
    return done('none');
  });
  bridge.on('playback:setRepeatMode', (r) => {
    repeat = (r as { mode: PlaybackStateDto['repeatMode'] }).mode;
    revision += 1;
    return result(main.state());
  });
  bridge.on('playback:setShuffle', (r) => {
    shuffle = (r as { enabled: boolean }).enabled;
    revision += 1;
    return result(main.state());
  });

  bridge.on('track:getLyrics', (r) => result(main.lyrics.get((r as { trackId: string }).trackId) ?? { status: 'none', lines: [] }));
  bridge.on('track:getArtwork', (r) => result(main.artwork.get((r as { trackId: string }).trackId) ?? { status: 'none' }));

  bridge.on('track:attachLyrics', (r) => {
    const trackId = (r as { trackId: string }).trackId;
    const answer = main.attachAnswer;
    if (answer === 'fail') return failure('internal', 'boom');
    if (answer.outcome === 'attached') main.lyrics.set(trackId, answer.lyrics);
    return result(answer);
  });
  bridge.on('track:detachLyrics', (r) => {
    const trackId = (r as { trackId: string }).trackId;
    const had = main.lyrics.get(trackId)?.attached === true;
    if (had) main.lyrics.set(trackId, { status: 'none', lines: [] });
    return result({ removed: had });
  });

  main.library = createLibraryStore(bridge, { searchDebounceMs: 0 });
  main.playback = createPlaybackStore(bridge, fakes.audio, { now: () => 0 });
  main.nowPlaying = createNowPlayingStore(bridge, main.playback);
  return main;
}
