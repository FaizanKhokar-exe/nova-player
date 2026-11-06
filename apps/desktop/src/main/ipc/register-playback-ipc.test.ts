import {
  createPlaybackApplication,
  type PlaybackApplication,
  type PlaybackApplicationEvent,
} from '@nova/infrastructure';
import { IPC_INVOKE_CHANNELS, type IpcEventChannel, type IpcEventPayload, type IpcResult, type PlaybackIpcContract } from '@nova/shared';
import { selectGroup, sortTracks, type PersistedPlaybackSession, type Track } from '@nova/domain';
import { LibraryApplicationError, TrackSidecarError, type ArtworkResult, type AttachLyricsResult, type LyricsResult } from '@nova/infrastructure';
import { beforeEach, describe, expect, it } from 'vitest';
import { makeTrack } from '../../../../../packages/infrastructure/src/repositories/test-tracks.js';
import type { IpcRegistrar } from './register-library-ipc.js';
import { bridgePlaybackEvents, registerPlaybackIpc } from './register-playback-ipc.js';

type Handler = (event: unknown, request: unknown) => unknown;
const TRUSTED = { trusted: true };
const SECRET = '/home/someone/Private Music';

interface Harness {
  call(channel: keyof PlaybackIpcContract, request?: unknown, event?: unknown): Promise<IpcResult<unknown>>;
  tracks: Track[];
  library: Map<string, Track>;
  app: PlaybackApplication;
  logged: unknown[];
  denials: Map<string, string>;
  handlers: Map<string, Handler>;
  sidecarCalls: string[];
  sidecarState: { lyrics: LyricsResult | Error; artwork: ArtworkResult | Error; attach: AttachLyricsResult | Error; detach: boolean };
  /** What the fake file dialog returns next (`undefined` = the listener cancelled) and how often it was opened. */
  dialog: { next: string | undefined; opened: number };
  artworkChanged: { count: number };
  providerQueries: { title: string; artist: string }[];
  edits: { id: string; edit: unknown }[];
}

function harness(): Harness {
  const tracks = Array.from({ length: 4 }, (_, i) => makeTrack({ title: `Song ${i}`, sourcePath: `${SECRET}/s${i}.mp3` }));
  const library = new Map<string, Track>(tracks.map((t) => [t.id, t]));
  const denials = new Map<string, string>();
  let saved: PersistedPlaybackSession | undefined;
  const logged: unknown[] = [];
  const app = createPlaybackApplication({
    trackRepository: {
      getById: (id) => library.get(id),
      listFileStates: () => [...library.values()].map((t) => ({ id: t.id, sourcePath: t.sourcePath, sizeBytes: 1, modifiedAtMs: 0 })),
    },
    playbackSessionRepository: { load: () => saved, save: (s) => void (saved = s), savePosition: (p) => void (saved && (saved = { ...saved, positionMs: p })), clear: () => void (saved = undefined) },
    library: {
      listTracks: (sort) => sortTracks([...library.values()], sort ?? { field: 'title', direction: 'asc' }),
      searchTracks: () => [],
      getGroup: (kind, key, sort) => {
        const selected = selectGroup([...library.values()], kind, key);
        if (selected === undefined) throw new LibraryApplicationError('group-not-found', 'That album, artist or genre is no longer in the library.');
        return { group: selected.group, tracks: sort === undefined ? selected.tracks : sortTracks(selected.tracks, sort) };
      },
    },
    mediaAccess: { resolveTrack: async (id) => (denials.has(id) ? { ok: false, denial: denials.get(id) as never } : { ok: true, filePath: '/x.mp3' as never, contentType: 'audio/mpeg' }) },
    random: () => 0.5,
  });
  const handlers = new Map<string, Handler>();
  const registrar: IpcRegistrar = { handle: (channel, listener) => void handlers.set(channel, listener) };
  const sidecarCalls: string[] = [];
  const sidecarState: { lyrics: LyricsResult | Error; artwork: ArtworkResult | Error; attach: AttachLyricsResult | Error; detach: boolean } = {
    lyrics: { status: 'none', lines: [] },
    artwork: { status: 'none' },
    attach: { outcome: 'attached', lines: [{ timeMs: 500, text: 'hi' }] },
    detach: true,
  };
  const dialog = { next: '/picked/song.lrc' as string | undefined, opened: 0 };
  const sidecars = {
    getLyrics: async (id: string) => {
      sidecarCalls.push(`lyrics:${id}`);
      if (sidecarState.lyrics instanceof Error) throw sidecarState.lyrics;
      return sidecarState.lyrics;
    },
    getArtwork: async (id: string) => {
      sidecarCalls.push(`artwork:${id}`);
      if (sidecarState.artwork instanceof Error) throw sidecarState.artwork;
      return sidecarState.artwork;
    },
    attachLyricsFromFile: async (id: string, filePath: string) => {
      sidecarCalls.push(`attach:${id}:${filePath}`);
      if (sidecarState.attach instanceof Error) throw sidecarState.attach;
      return sidecarState.attach;
    },
    detachLyrics: async (id: string) => {
      sidecarCalls.push(`detach:${id}`);
      return sidecarState.detach;
    },
    attachArtworkFromFile: async (id: string, filePath: string) => {
      sidecarCalls.push(`attachArt:${id}:${filePath}`);
      return { outcome: 'attached' as const };
    },
    detachArtwork: async (id: string) => {
      sidecarCalls.push(`detachArt:${id}`);
      return true;
    },
    saveLrc: async (id: string, text: string) => {
      sidecarCalls.push(`saveLrc:${id}:${text.length}`);
      return { outcome: text.includes('[') ? ('saved-beside' as const) : ('invalid' as const) };
    },
  };
  const artworkChanged = { count: 0 };
  const providerQueries: { title: string; artist: string }[] = [];
  const edits: { id: string; edit: unknown }[] = [];
  registerPlaybackIpc({ registrar, application: app, sidecars, pickLyricsFile: async () => (dialog.opened++, dialog.next), pickArtworkFile: async () => (dialog.opened++, '/picked/cover.png'), onArtworkChanged: () => void (artworkChanged.count += 1), editTrackInfo: (id, edit) => (edits.push({ id, edit }), tracks.some((t) => t.id === id) ? (edit === undefined && edits.length > 3 ? 'nothing' : 'done') : 'unknown'), describeTrack: (id: string) => (tracks.some((t) => t.id === id) ? { title: 'Imagine', artist: 'John Lennon', durationSec: 183 } : undefined), lyricsProvider: { search: async (q) => { providerQueries.push(q); return { status: 'ok' as const, candidates: [] }; } }, isTrustedSender: (e) => (e as { trusted?: boolean }).trusted === true, log: (_m, e) => logged.push(e) });
  return {
    tracks,
    library,
    app,
    logged,
    denials,
    handlers,
    sidecarCalls,
    sidecarState,
    dialog,
    artworkChanged,
    providerQueries,
    edits,
    call: async (channel, request, event = TRUSTED) => (await handlers.get(channel)!(event, request)) as IpcResult<unknown>,
  };
}

let h: Harness;
beforeEach(() => {
  h = harness();
});

// Phase 11 deliberately moved these two to registerCollectionsIpc (they need the collections / thumbnail services); the pinned list here follows, the count stays 20.
const COLLECTIONS_OWNED: readonly string[] = ['playback:playList', 'track:getThumbnail'];
const PLAYBACK_CHANNELS = IPC_INVOKE_CHANNELS.filter((c) => (c.startsWith('playback:') || c.startsWith('track:') || c.startsWith('lyrics:')) && !COLLECTIONS_OWNED.includes(c));

describe('registration', () => {
  it('registers exactly the playback channels in the contract, once each', () => {
    expect([...h.handlers.keys()].sort()).toEqual([...PLAYBACK_CHANNELS].sort());
    expect(PLAYBACK_CHANNELS).toHaveLength(26); // 18 until Phase 10 added track:attachLyrics / detachLyrics; v0.11.3 added track:attachArtwork / detachArtwork; v0.12.0 lyrics:search / lyrics:save; v0.15.0 track:editInfo / resetInfo
  });

  it('refuses every channel for an untrusted sender, before validating or running anything', async () => {
    for (const channel of PLAYBACK_CHANNELS) {
      const result = await h.call(channel as keyof PlaybackIpcContract, 'garbage', { trusted: false });
      expect(result).toMatchObject({ ok: false, error: { code: 'forbidden', operation: channel } });
    }
    expect(h.app.getState().revision).toBe(0);
  });

  it('answers a malformed request with invalid-request and changes nothing', async () => {
    expect(await h.call('playback:playTrack', { trackId: 'nope' })).toMatchObject({ ok: false, error: { code: 'invalid-request' } });
    expect(await h.call('playback:next', { positionMs: -5 })).toMatchObject({ ok: false, error: { code: 'invalid-request' } });
    expect(await h.call('playback:getState', { extra: 1 })).toMatchObject({ ok: false, error: { code: 'invalid-request' } });
    expect(h.app.getState().revision).toBe(0);
  });
});

describe('the handlers', () => {
  it('getState: the empty state', async () => {
    expect(await h.call('playback:getState')).toEqual({
      ok: true,
      value: { revision: 0, positionMs: 0, repeatMode: 'off', shuffle: false, queueLength: 0, canNext: false },
    });
  });

  it('playTrack: starts the track and returns the state with an opaque media URL', async () => {
    const result = await h.call('playback:playTrack', { trackId: h.tracks[1]!.id });
    expect(result).toMatchObject({ ok: true, value: { outcome: 'started', state: { queueLength: 4, queueIndex: 1, current: { mediaUrl: `nova-media://track/${h.tracks[1]!.id}` } } } });
  });

  it('playTrack: an unknown track is a typed track-not-found error, not a crash', async () => {
    const result = await h.call('playback:playTrack', { trackId: crypto.randomUUID() });
    expect(result).toEqual({ ok: false, error: { code: 'track-not-found', message: 'That track is not in the library.', operation: 'playback:playTrack' } });
    expect(h.logged).toEqual([]); // a rule violation, not an unexpected failure
  });

  it('next / previous / trackFinished drive the domain rules through IPC', async () => {
    await h.call('playback:playTrack', { trackId: h.tracks[0]!.id });
    expect(await h.call('playback:next', { positionMs: 10 })).toMatchObject({ value: { outcome: 'started', state: { queueIndex: 1 } } });
    expect(await h.call('playback:previous', { positionMs: 10_000 })).toMatchObject({ value: { outcome: 'restart', state: { queueIndex: 1 } } });
    expect(await h.call('playback:previous', { positionMs: 10 })).toMatchObject({ value: { outcome: 'started', state: { queueIndex: 0 } } });
    expect(await h.call('playback:trackFinished', { trackId: h.tracks[0]!.id })).toMatchObject({ value: { outcome: 'started', state: { queueIndex: 1 } } });
    // stale
    expect(await h.call('playback:trackFinished', { trackId: h.tracks[0]!.id })).toMatchObject({ value: { outcome: 'none', state: { queueIndex: 1 } } });
  });

  it('setRepeatMode / setShuffle return the new state', async () => {
    await h.call('playback:playTrack', { trackId: h.tracks[0]!.id });
    expect(await h.call('playback:setRepeatMode', { mode: 'one' })).toMatchObject({ ok: true, value: { repeatMode: 'one' } });
    expect(await h.call('playback:setShuffle', { enabled: true })).toMatchObject({ ok: true, value: { shuffle: true } });
    expect(await h.call('playback:setShuffle', { enabled: false })).toMatchObject({ ok: true, value: { shuffle: false } });
  });

  it('reportPosition: saved for the current track, not for another', async () => {
    await h.call('playback:playTrack', { trackId: h.tracks[0]!.id });
    expect(await h.call('playback:reportPosition', { trackId: h.tracks[0]!.id, positionMs: 4000 })).toEqual({ ok: true, value: { saved: true } });
    expect(await h.call('playback:reportPosition', { trackId: h.tracks[3]!.id, positionMs: 4000 })).toEqual({ ok: true, value: { saved: false } });
  });

  it('diagnoseSource: no problem when readable; a user-facing problem otherwise (no path, no raw denial)', async () => {
    expect(await h.call('playback:diagnoseSource', { trackId: h.tracks[0]!.id })).toEqual({ ok: true, value: {} });
    h.denials.set(h.tracks[0]!.id, 'file-missing');
    expect(await h.call('playback:diagnoseSource', { trackId: h.tracks[0]!.id })).toEqual({ ok: true, value: { problem: 'file-missing' } });
    h.denials.set(h.tracks[1]!.id, 'outside-root');
    expect(await h.call('playback:diagnoseSource', { trackId: h.tracks[1]!.id })).toEqual({ ok: true, value: { problem: 'file-inaccessible' } });
  });

  it('no response from any channel ever contains a track file path', async () => {
    const responses = [
      await h.call('playback:playTrack', { trackId: h.tracks[2]!.id }),
      await h.call('playback:next', { positionMs: 0 }),
      await h.call('playback:previous', { positionMs: 0 }),
      await h.call('playback:getState'),
      await h.call('playback:setShuffle', { enabled: true }),
      await h.call('playback:diagnoseSource', { trackId: h.tracks[2]!.id }),
    ];
    const json = JSON.stringify(responses);
    expect(json).not.toContain('Private Music');
    expect(json).not.toContain('/home/someone');
    expect(json).not.toMatch(/sourcePath|\.mp3/);
  });

  it('an unexpected failure becomes the generic internal error and is logged only in main', async () => {
    const original = h.app.getState;
    h.app.getState = () => {
      throw new Error('SQLITE_CORRUPT: /home/someone/secret.db');
    };
    const result = await h.call('playback:getState');
    h.app.getState = original;
    expect(result).toMatchObject({ ok: false, error: { code: 'internal' } });
    expect(JSON.stringify(result)).not.toContain('SQLITE');
    expect(h.logged).toHaveLength(1);
  });
});

describe('bridgePlaybackEvents', () => {
  it('forwards state changes as DTOs on playback:stateChanged, and stops when unsubscribed', async () => {
    const sent: Array<{ channel: IpcEventChannel; payload: unknown }> = [];
    const off = bridgePlaybackEvents(h.app, (<E extends IpcEventChannel>(channel: E, payload: IpcEventPayload<E>) => void sent.push({ channel, payload })));
    await h.call('playback:playTrack', { trackId: h.tracks[1]!.id });
    h.library.delete(h.tracks[3]!.id);
    h.app.reconcileLibrary();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ channel: 'playback:stateChanged', payload: { reason: 'library-changed', state: { queueLength: 3 } } });
    expect(JSON.stringify(sent)).not.toContain('Private Music');
    off();
    h.library.delete(h.tracks[2]!.id);
    h.app.reconcileLibrary();
    expect(sent).toHaveLength(1);
    void (undefined as unknown as PlaybackApplicationEvent);
  });
});


describe('Phase 5: queue view, editing and group playback', () => {
  const key = async (kind: 'album' | 'artist' | 'genre'): Promise<string> => {
    // the group keys are produced by the domain; ask it the same way the application does
    const { groupTracks } = await import('@nova/domain');
    return groupTracks([...h.library.values()], kind)[0]!.key;
  };

  it('playGroup plays the group from its first track and honours a sort', async () => {
    const album = await key('artist');
    const result = await h.call('playback:playGroup', { group: { kind: 'artist', key: album }, sort: { field: 'title', direction: 'desc' } });
    expect(result).toMatchObject({ ok: true, value: { outcome: 'started', state: { queueLength: 1 } } });
  });

  it('playGroup / enqueue / getGroup-context: a vanished group is a typed group-not-found, never a crash', async () => {
    const gone = { kind: 'album', key: 'does-not-exist' };
    expect(await h.call('playback:playGroup', { group: gone })).toMatchObject({ ok: false, error: { code: 'group-not-found' } });
    expect(await h.call('playback:enqueue', { position: 'last', group: gone })).toMatchObject({ ok: false, error: { code: 'group-not-found' } });
    expect(await h.call('playback:playTrack', { trackId: h.tracks[0]!.id, context: { kind: 'group', group: gone } })).toMatchObject({ ok: false, error: { code: 'group-not-found' } });
    expect(h.logged).toEqual([]);
    expect(h.app.getState().revision).toBe(0);
  });

  it('enqueue: next / last for a track; exactly one of trackId and group', async () => {
    await h.call('playback:playTrack', { trackId: h.tracks[0]!.id });
    await h.call('playback:enqueue', { position: 'last', trackId: h.tracks[0]!.id });
    expect(h.app.getState().queueLength).toBe(5);
    await h.call('playback:enqueue', { position: 'next', trackId: h.tracks[3]!.id });
    expect(h.app.getQueue({ limit: 10 }).items[1]!.track.id).toBe(h.tracks[3]!.id);
    for (const bad of [{ position: 'last' }, { position: 'sideways', trackId: h.tracks[0]!.id }, { position: 'last', trackId: h.tracks[0]!.id, group: { kind: 'album', key: 'k' } }, { position: 'last', trackId: 'nope' }, { position: 'last', trackId: h.tracks[0]!.id, extra: 1 }]) {
      expect(await h.call('playback:enqueue', bad)).toMatchObject({ ok: false, error: { code: 'invalid-request' } });
    }
    expect(await h.call('playback:enqueue', { position: 'last', trackId: crypto.randomUUID() })).toMatchObject({ ok: false, error: { code: 'track-not-found' } });
  });

  it('getQueue returns a path-free window; limit and offset are validated', async () => {
    await h.call('playback:playTrack', { trackId: h.tracks[1]!.id });
    const result = (await h.call('playback:getQueue', { offset: 1, limit: 2 })) as { ok: true; value: { total: number; currentIndex: number; offset: number; items: { position: number; track: Record<string, unknown> }[] } };
    expect(result.ok).toBe(true);
    expect(result.value).toMatchObject({ total: 4, currentIndex: 1, offset: 1 });
    expect(result.value.items.map((i) => i.position)).toEqual([1, 2]);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(Object.keys(result.value.items[0]!.track)).not.toContain('sourcePath');
    expect((await h.call('playback:getQueue')).ok).toBe(true);
    for (const bad of [{ limit: 1_001 }, { limit: -1 }, { offset: 1.5 }, { extra: 1 }, 'x']) {
      expect(await h.call('playback:getQueue', bad)).toMatchObject({ ok: false, error: { code: 'invalid-request' } });
    }
  });

  it('queue edits: playQueueItem, removeFromQueue, moveQueueItem, clearQueue', async () => {
    await h.call('playback:playTrack', { trackId: h.tracks[0]!.id });
    const order = h.app.getQueue({ limit: 10 }).items.map((i) => i.track.id);
    expect(await h.call('playback:playQueueItem', { index: 2, trackId: order[2] })).toMatchObject({ value: { outcome: 'started', state: { queueIndex: 2 } } });
    expect(await h.call('playback:removeFromQueue', { index: 3, trackId: order[3] })).toMatchObject({ value: { state: { queueLength: 3 } } });
    expect(await h.call('playback:moveQueueItem', { index: 0, toIndex: 2, trackId: order[0] })).toMatchObject({ value: { outcome: 'none', state: { queueIndex: 1 } } });
    expect(await h.call('playback:clearQueue')).toMatchObject({ value: { state: { queueLength: 1, queueIndex: 0 } } });
  });

  it('a stale edit (wrong track at that index) changes nothing and is not an error', async () => {
    await h.call('playback:playTrack', { trackId: h.tracks[0]!.id });
    const revision = h.app.getState().revision;
    const other = h.app.getQueue({ limit: 10 }).items[1]!.track.id;
    expect(await h.call('playback:removeFromQueue', { index: 0, trackId: other })).toMatchObject({ ok: true, value: { outcome: 'none', state: { queueLength: 4 } } });
    expect(h.app.getState().revision).toBe(revision);
  });

  it('every new channel rejects bad indexes, bad ids and unknown keys, and no-argument channels take nothing', async () => {
    const id = h.tracks[0]!.id;
    for (const [channel, bad] of [
      ['playback:playQueueItem', { index: -1, trackId: id }],
      ['playback:playQueueItem', { index: 1.5, trackId: id }],
      ['playback:playQueueItem', { index: 0, trackId: '../../etc/passwd' }],
      ['playback:removeFromQueue', { index: 0 }],
      ['playback:removeFromQueue', { index: 0, trackId: id, extra: true }],
      ['playback:moveQueueItem', { index: 0, trackId: id }],
      ['playback:moveQueueItem', { index: 0, toIndex: -3, trackId: id }],
      ['playback:clearQueue', {}],
      ['playback:playGroup', {}],
      ['playback:playGroup', { group: { kind: 'album' } }],
      ['playback:playTrack', { trackId: id, context: { kind: 'group', group: { kind: 'album', key: 'k' }, extra: 1 } }],
      ['playback:playTrack', { trackId: id, context: { kind: 'library', sort: { field: 'path', direction: 'asc' } } }],
    ] as const) {
      expect(await h.call(channel, bad), `${channel} ${JSON.stringify(bad)}`).toMatchObject({ ok: false, error: { code: 'invalid-request' } });
    }
    expect(h.app.getState().revision).toBe(0);
  });
});


describe('Phase 6: track:getLyrics and track:getArtwork', () => {
  const id = (): string => h.tracks[0]!.id;

  it('returns the lyric lines as plain DTOs (ms + text only)', async () => {
    h.sidecarState.lyrics = { status: 'found', lines: [{ timeMs: 1500, text: 'one' }, { timeMs: 3000, text: '' }] };
    expect(await h.call('track:getLyrics', { trackId: id() })).toEqual({
      ok: true,
      value: { status: 'found', lines: [{ timeMs: 1500, text: 'one' }, { timeMs: 3000, text: '' }] },
    });
    expect(h.sidecarCalls).toEqual([`lyrics:${id()}`]);
  });

  it.each(['none', 'empty', 'unavailable', 'unreadable'] as const)('"%s" lyrics are a normal answer with no lines', async (status) => {
    h.sidecarState.lyrics = { status, lines: [] };
    expect(await h.call('track:getLyrics', { trackId: id() })).toEqual({ ok: true, value: { status, lines: [] } });
  });

  it('artwork: found becomes a data URL; none/unavailable carry no data', async () => {
    h.sidecarState.artwork = { status: 'found', mimeType: 'image/png', bytes: Buffer.from([1, 2, 3]) };
    expect(await h.call('track:getArtwork', { trackId: id() })).toEqual({ ok: true, value: { status: 'found', dataUrl: 'data:image/png;base64,AQID' } });
    h.sidecarState.artwork = { status: 'none' };
    expect(await h.call('track:getArtwork', { trackId: id() })).toEqual({ ok: true, value: { status: 'none' } });
    h.sidecarState.artwork = { status: 'unavailable' };
    expect(await h.call('track:getArtwork', { trackId: id() })).toEqual({ ok: true, value: { status: 'unavailable' } });
  });

  it('the data URL carries the real media type of the image', async () => {
    h.sidecarState.artwork = { status: 'found', mimeType: 'image/jpeg', bytes: Buffer.from([255, 216, 255]) };
    expect(await h.call('track:getArtwork', { trackId: id() })).toEqual({ ok: true, value: { status: 'found', dataUrl: 'data:image/jpeg;base64,/9j/' } });
  });

  it('lyric lines are copied field by field: anything extra on an internal line never crosses the boundary', async () => {
    h.sidecarState.lyrics = { status: 'found', lines: [{ timeMs: 10, text: 'x', sourcePath: SECRET, internal: { a: 1 } } as never] };
    const response = await h.call('track:getLyrics', { trackId: id() });
    expect(response).toEqual({ ok: true, value: { status: 'found', lines: [{ timeMs: 10, text: 'x' }] } });
    expect(JSON.stringify(response)).not.toContain(SECRET);
  });

  it('validates the request: exact shape, valid id, no unknown keys - and calls nothing when invalid', async () => {
    for (const channel of ['track:getLyrics', 'track:getArtwork'] as const) {
      for (const bad of [undefined, null, 'x', {}, { trackId: 5 }, { trackId: '../../etc/passwd' }, { trackId: 'not-a-uuid' }, { trackId: id(), path: '/etc' }, { trackId: id(), extra: 1 }, [id()]]) {
        expect(await h.call(channel, bad), `${channel} ${JSON.stringify(bad)}`).toMatchObject({ ok: false, error: { code: 'invalid-request' } });
      }
    }
    expect(h.sidecarCalls).toEqual([]);
  });

  it('refuses an untrusted sender before doing anything', async () => {
    for (const channel of ['track:getLyrics', 'track:getArtwork'] as const) {
      expect(await h.call(channel, { trackId: id() }, { trusted: false })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    }
    expect(h.sidecarCalls).toEqual([]);
  });

  it('maps a missing track to the stable track-not-found error (not logged), and unexpected failures to a generic internal error', async () => {
    h.sidecarState.lyrics = new TrackSidecarError('track-not-found', 'That track is not in the library.');
    expect(await h.call('track:getLyrics', { trackId: id() })).toEqual({ ok: false, error: { code: 'track-not-found', message: 'That track is not in the library.', operation: 'track:getLyrics' } });
    expect(h.logged).toEqual([]);
    h.sidecarState.artwork = new Error('EACCES /home/me/secret/path.mp3');
    const failed = await h.call('track:getArtwork', { trackId: id() });
    expect(failed).toMatchObject({ ok: false, error: { code: 'internal' } });
    expect(JSON.stringify(failed)).not.toContain('/home/me');
    expect(h.logged).toHaveLength(1);
  });

  it('never puts a path into a response', async () => {
    h.sidecarState.lyrics = { status: 'found', lines: [{ timeMs: 0, text: 'hello' }] };
    expect(JSON.stringify(await h.call('track:getLyrics', { trackId: id() }))).not.toContain(SECRET);
  });
});

describe('Phase 10: track:attachLyrics and track:detachLyrics', () => {
  const id = (): string => h.tracks[0]!.id;

  it('attach: the track is checked, then main opens the dialog, then the chosen file is attached and the new lyrics returned', async () => {
    const result = await h.call('track:attachLyrics', { trackId: id() });
    expect(result).toEqual({ ok: true, value: { outcome: 'attached', lyrics: { status: 'found', lines: [{ timeMs: 500, text: 'hi' }], attached: true } } });
    expect(h.dialog.opened).toBe(1);
    expect(h.sidecarCalls).toEqual([`lyrics:${id()}`, `attach:${id()}:/picked/song.lrc`]);
  });

  it('attach: cancelling the dialog attaches nothing', async () => {
    h.dialog.next = undefined;
    expect(await h.call('track:attachLyrics', { trackId: id() })).toEqual({ ok: true, value: { outcome: 'cancelled' } });
    expect(h.sidecarCalls).toEqual([`lyrics:${id()}`]);
  });

  it.each(['empty', 'unreadable', 'too-large', 'unavailable'] as const)('attach: "%s" is a normal outcome, never an error', async (outcome) => {
    h.sidecarState.attach = { outcome };
    expect(await h.call('track:attachLyrics', { trackId: id() })).toEqual({ ok: true, value: { outcome } });
  });

  it('attach: an unreachable track folder answers "unavailable" WITHOUT opening the dialog', async () => {
    h.sidecarState.lyrics = { status: 'unavailable', lines: [] };
    expect(await h.call('track:attachLyrics', { trackId: id() })).toEqual({ ok: true, value: { outcome: 'unavailable' } });
    expect(h.dialog.opened).toBe(0);
  });

  it('attach: an unknown track is refused before any dialog opens', async () => {
    h.sidecarState.lyrics = new TrackSidecarError('track-not-found', 'That track is not in the library.');
    expect(await h.call('track:attachLyrics', { trackId: id() })).toMatchObject({ ok: false, error: { code: 'track-not-found' } });
    expect(h.dialog.opened).toBe(0);
  });

  it('attach and detach validate the request (exact shape, a path is never accepted) and refuse an untrusted sender, calling nothing', async () => {
    for (const channel of ['track:attachLyrics', 'track:detachLyrics'] as const) {
      for (const bad of [undefined, null, {}, { trackId: 'nope' }, { trackId: id(), path: '/etc/passwd' }, { trackId: id(), filePath: '/x.lrc' }]) {
        expect(await h.call(channel, bad), `${channel} ${JSON.stringify(bad)}`).toMatchObject({ ok: false, error: { code: 'invalid-request' } });
      }
      expect(await h.call(channel, { trackId: id() }, { trusted: false })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    }
    expect(h.sidecarCalls).toEqual([]);
    expect(h.dialog.opened).toBe(0);
  });

  it('the chosen file path never appears in a response', async () => {
    h.dialog.next = `${SECRET}/lyrics.lrc`;
    expect(JSON.stringify(await h.call('track:attachLyrics', { trackId: id() }))).not.toContain(SECRET);
  });

  it('detach: reports whether something was removed', async () => {
    expect(await h.call('track:detachLyrics', { trackId: id() })).toEqual({ ok: true, value: { removed: true } });
    h.sidecarState.detach = false;
    expect(await h.call('track:detachLyrics', { trackId: id() })).toEqual({ ok: true, value: { removed: false } });
  });

  it('getLyrics marks attached lyrics (and only those) with attached: true', async () => {
    h.sidecarState.lyrics = { status: 'found', lines: [{ timeMs: 1, text: 'a' }], attached: true };
    expect(await h.call('track:getLyrics', { trackId: id() })).toEqual({ ok: true, value: { status: 'found', lines: [{ timeMs: 1, text: 'a' }], attached: true } });
  });
});

describe('v0.11.3: track:attachArtwork and track:detachArtwork', () => {
  const id = () => '123e4567-e89b-42d3-a456-426614174000';
  it('shows main\'s own dialog, attaches the chosen picture, and tells the thumbnail cache', async () => {
    expect(await h.call('track:attachArtwork', { trackId: id() })).toEqual({ ok: true, value: { outcome: 'attached' } });
    expect(h.dialog.opened).toBe(1);
    expect(h.sidecarCalls).toContain(`attachArt:${id()}:/picked/cover.png`);
    expect(h.artworkChanged.count).toBe(1);
  });
  it('refuses an untrusted sender and a malformed request before any dialog opens', async () => {
    for (const channel of ['track:attachArtwork', 'track:detachArtwork'] as const) {
      expect(await h.call(channel, { trackId: id() }, { trusted: false })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
      expect(await h.call(channel, { trackId: 5 })).toMatchObject({ ok: false });
    }
    expect(h.dialog.opened).toBe(0);
  });
  it('an unavailable folder never opens the dialog; removal reports and refreshes', async () => {
    h.sidecarState.artwork = { status: 'unavailable' };
    expect(await h.call('track:attachArtwork', { trackId: id() })).toEqual({ ok: true, value: { outcome: 'unavailable' } });
    expect(h.dialog.opened).toBe(0);
    expect(await h.call('track:detachArtwork', { trackId: id() })).toEqual({ ok: true, value: { removed: true } });
    expect(h.artworkChanged.count).toBe(1);
  });
});

describe('v0.12.0: lyrics:search and lyrics:save', () => {
  it('searches by the track\'s own tags, or by the listener\'s correction, and returns what was asked', async () => {
    const trackId = h.tracks[0]!.id;
    expect(await h.call('lyrics:search', { trackId })).toEqual({ ok: true, value: { status: 'ok', title: 'Imagine', artist: 'John Lennon', candidates: [] } });
    expect(await h.call('lyrics:search', { trackId, title: ' Jealous Guy ', artist: '' })).toMatchObject({ ok: true, value: { title: 'Jealous Guy', artist: '' } });
    expect(h.providerQueries).toMatchObject([{ title: 'Imagine', artist: 'John Lennon' }, { title: 'Jealous Guy', artist: '' }]);
  });
  it('refuses untrusted senders, extra fields, over-long text and unknown tracks without searching', async () => {
    const trackId = h.tracks[0]!.id;
    expect(await h.call('lyrics:search', { trackId }, { trusted: false })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(await h.call('lyrics:search', { trackId, url: 'https://evil.example' })).toMatchObject({ ok: false });
    expect(await h.call('lyrics:search', { trackId, title: 'x'.repeat(201) })).toMatchObject({ ok: false });
    expect(await h.call('lyrics:search', { trackId: '123e4567-e89b-42d3-a456-426614174000' })).toMatchObject({ ok: true, value: { status: 'error', candidates: [] } });
    expect(h.providerQueries).toHaveLength(0);
  });
  it('saves through the sidecars and validates the request', async () => {
    const trackId = h.tracks[0]!.id;
    expect(await h.call('lyrics:save', { trackId, lrc: '[00:01.00]hi' })).toEqual({ ok: true, value: { outcome: 'saved-beside' } });
    expect(await h.call('lyrics:save', { trackId, lrc: 'no times' })).toEqual({ ok: true, value: { outcome: 'invalid' } });
    expect(await h.call('lyrics:save', { trackId, lrc: 5 })).toMatchObject({ ok: false });
    expect(await h.call('lyrics:save', { trackId, lrc: '[00:01.00]hi' }, { trusted: false })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
  });
});

describe('v0.15.0: track:editInfo and track:resetInfo', () => {
  it('cleans the names, stores them, and refuses empty titles, extra fields and strangers', async () => {
    const trackId = h.tracks[0]!.id;
    expect(await h.call('track:editInfo', { trackId, title: '  Right   Title ', artist: ' Right Artist', album: '  ' })).toEqual({ ok: true, value: { outcome: 'saved' } });
    expect(h.edits[0]).toEqual({ id: trackId, edit: { title: 'Right Title', artist: 'Right Artist' } });
    expect(await h.call('track:editInfo', { trackId, title: 'T', artist: 'A', album: 'Alb' })).toEqual({ ok: true, value: { outcome: 'saved' } });
    expect(h.edits[1]?.edit).toEqual({ title: 'T', artist: 'A', album: 'Alb' });
    expect(await h.call('track:editInfo', { trackId, title: '   ', artist: 'A' })).toEqual({ ok: true, value: { outcome: 'invalid' } });
    expect(await h.call('track:editInfo', { trackId, title: 'T', artist: 'A', path: 'C:/x' })).toMatchObject({ ok: false });
    expect(await h.call('track:editInfo', { trackId, title: 5, artist: 'A' })).toMatchObject({ ok: false });
    expect(await h.call('track:editInfo', { trackId, title: 'T', artist: 'A' }, { trusted: false })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(await h.call('track:editInfo', { trackId: '123e4567-e89b-42d3-a456-426614174000', title: 'T', artist: 'A' })).toEqual({ ok: true, value: { outcome: 'unknown' } });
  });
  it('resets to the tags', async () => {
    const trackId = h.tracks[0]!.id;
    expect(await h.call('track:resetInfo', { trackId })).toEqual({ ok: true, value: { outcome: 'reset' } });
    expect(h.edits[0]).toEqual({ id: trackId, edit: undefined });
    expect(await h.call('track:resetInfo', { trackId: '123e4567-e89b-42d3-a456-426614174000' })).toEqual({ ok: true, value: { outcome: 'unknown' } });
  });
});
