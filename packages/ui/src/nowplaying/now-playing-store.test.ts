import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeMain, type FakeMain } from '../library/browse-test-support.js';
import { failure, flush, track } from '../library/test-support.js';

const T = [
  track(1, { title: 'With lyrics', artwork: 'embedded' }),
  track(2, { title: 'Without', artwork: 'none' }),
  track(3, { title: 'Third', artwork: 'embedded' }),
];
const LINES = [
  { timeMs: 1000, text: 'one' },
  { timeMs: 2500, text: 'two' },
];

let m: FakeMain;
let disconnects: (() => void)[] = [];
beforeEach(async () => {
  m = createFakeMain(T);
  m.lyrics.set(T[0]!.id, { status: 'found', lines: LINES });
  m.artwork.set(T[0]!.id, { status: 'found', dataUrl: 'data:image/png;base64,AAAA' });
  m.artwork.set(T[2]!.id, { status: 'found', dataUrl: 'data:image/png;base64,CCCC' });
  disconnects = [m.playback.getState().connect(), m.nowPlaying.getState().connect()];
  await flush();
});
afterEach(() => disconnects.forEach((d) => d()));

const play = async (index: number): Promise<void> => {
  await m.playback.getState().playTrack(T[index]!.id);
  await flush();
};

describe('following the current track', () => {
  it('is idle with nothing playing and asks for nothing', () => {
    expect(m.nowPlaying.getState()).toMatchObject({ trackId: undefined, lyrics: { status: 'idle' }, artwork: { status: 'idle' } });
    expect(m.calls('track:getLyrics')).toEqual([]);
    expect(m.calls('track:getArtwork')).toEqual([]);
  });

  it('loads the lyrics and artwork of the track that starts, by id only', async () => {
    await play(0);
    const s = m.nowPlaying.getState();
    expect(s.trackId).toBe(T[0]!.id);
    expect(s.lyrics).toMatchObject({ status: 'ready', availability: 'found', lines: LINES });
    expect(s.artwork).toEqual({ status: 'found', dataUrl: 'data:image/png;base64,AAAA' });
    expect(m.calls('track:getLyrics')).toEqual([{ trackId: T[0]!.id }]);
    expect(m.calls('track:getArtwork')).toEqual([{ trackId: T[0]!.id }]);
  });

  it('a track with no artwork never asks main for it; lyrics "none" is a normal ready state', async () => {
    await play(1);
    const s = m.nowPlaying.getState();
    expect(s.artwork).toEqual({ status: 'none', dataUrl: undefined });
    expect(s.lyrics).toMatchObject({ status: 'ready', availability: 'none', lines: [] });
    expect(m.calls('track:getArtwork')).toEqual([]);
  });

  it('switching tracks drops the previous lyrics and artwork at once, then loads the new ones', async () => {
    await play(0);
    const hold = m.fakes.bridge.hold('track:getLyrics');
    const heldArtwork = m.fakes.bridge.hold('track:getArtwork');
    await m.playback.getState().playTrack(T[2]!.id);
    await flush();
    const mid = m.nowPlaying.getState();
    expect(mid.trackId).toBe(T[2]!.id);
    expect(mid.lyrics).toMatchObject({ status: 'loading', lines: [] }); // never the previous track's lines
    expect(mid.artwork).toEqual({ status: 'loading', dataUrl: undefined }); // never the previous cover
    hold.release();
    heldArtwork.release();
    await flush();
    expect(m.nowPlaying.getState().artwork.dataUrl).toBe('data:image/png;base64,CCCC');
  });

  it('a LATE answer for a previous track is dropped, not shown against the new one (lyrics)', async () => {
    let releaseFirst: () => void = () => undefined;
    let calls = 0;
    m.fakes.bridge.on('track:getLyrics', () => {
      calls += 1;
      if (calls === 1) return new Promise((resolve) => (releaseFirst = () => resolve({ ok: true, value: { status: 'found', lines: LINES } })));
      return { ok: true, value: { status: 'none', lines: [] } };
    });
    await m.playback.getState().playTrack(T[0]!.id); // its answer stays pending ...
    await flush();
    await m.playback.getState().playTrack(T[1]!.id); // ... the user moves on, and this one answers at once
    await flush();
    expect(m.nowPlaying.getState().lyrics).toMatchObject({ status: 'ready', availability: 'none' });
    releaseFirst(); // the old track's answer finally arrives
    await flush();
    const s = m.nowPlaying.getState();
    expect(s.trackId).toBe(T[1]!.id);
    expect(s.lyrics).toMatchObject({ status: 'ready', availability: 'none', lines: [] });
  });

  it('a LATE answer for a previous track is dropped (artwork): the new track never shows the old cover', async () => {
    let releaseFirst: () => void = () => undefined;
    let calls = 0;
    m.fakes.bridge.on('track:getArtwork', () => {
      calls += 1;
      if (calls === 1) return new Promise((resolve) => (releaseFirst = () => resolve({ ok: true, value: { status: 'found', dataUrl: 'data:image/png;base64,AAAA' } })));
      return { ok: true, value: { status: 'found', dataUrl: 'data:image/png;base64,CCCC' } };
    });
    await m.playback.getState().playTrack(T[0]!.id);
    await flush();
    await m.playback.getState().playTrack(T[2]!.id);
    await flush();
    expect(m.nowPlaying.getState().artwork.dataUrl).toBe('data:image/png;base64,CCCC');
    releaseFirst();
    await flush();
    expect(m.nowPlaying.getState().artwork).toEqual({ status: 'found', dataUrl: 'data:image/png;base64,CCCC' });
  });

  it('does not refetch when the SAME track is refreshed (metadata changes, play/pause, seeking)', async () => {
    await play(0);
    await m.playback.getState().setRepeatMode('all');
    await m.playback.getState().seekMs(0);
    m.fakes.bridge.emit('playback:stateChanged', { reason: 'library-changed', state: m.playback.getState().session! });
    await flush();
    expect(m.calls('track:getLyrics')).toHaveLength(1);
    expect(m.calls('track:getArtwork')).toHaveLength(1);
  });

  it('removing the current track from the queue resets to idle', async () => {
    await m.playback.getState().enqueue({ position: 'last', trackId: T[0]!.id });
    await flush();
    await m.playback.getState().removeFromQueue(0, T[0]!.id);
    await flush();
    expect(m.nowPlaying.getState()).toMatchObject({ trackId: undefined, lyrics: { status: 'idle' }, artwork: { status: 'idle' } });
  });
});

describe('failures never touch playback', () => {
  it('a failed lyrics lookup is an error slice with a plain message, and Try again recovers', async () => {
    let healthy = false;
    m.fakes.bridge.on('track:getLyrics', () => (healthy ? { ok: true, value: { status: 'found', lines: LINES } } : failure('internal', 'Something went wrong. The details were written to the application log.')));
    await play(0);
    expect(m.nowPlaying.getState().lyrics).toMatchObject({ status: 'error', error: expect.stringContaining('Something went wrong') });
    expect(m.playback.getState().session?.current?.track.id).toBe(T[0]!.id); // playback is untouched
    expect(m.playback.getState().error).toBeUndefined();
    healthy = true;
    m.nowPlaying.getState().retryLyrics();
    await flush();
    expect(m.nowPlaying.getState().lyrics).toMatchObject({ status: 'ready', availability: 'found' });
  });

  it('an unreachable bridge gives the generic message (never raw text) for lyrics and a quiet error for artwork', async () => {
    m.fakes.bridge.on('track:getLyrics', () => {
      throw new Error('ECONNRESET /home/me/Music/secret.lrc');
    });
    m.fakes.bridge.on('track:getArtwork', () => {
      throw new Error('boom');
    });
    await play(0);
    const s = m.nowPlaying.getState();
    expect(s.lyrics.status).toBe('error');
    expect(s.lyrics.error).toBe('Could not reach the application. Try restarting Nova Player.');
    expect(JSON.stringify(s)).not.toContain('/home/me');
    expect(s.artwork).toEqual({ status: 'error', dataUrl: undefined });
  });

  it('retrying with nothing playing does nothing', async () => {
    m.nowPlaying.getState().retryLyrics();
    await flush();
    expect(m.calls('track:getLyrics')).toEqual([]);
  });
});

describe('connection lifecycle', () => {
  it('is reference-counted: a second connect adds no subscription, the last disconnect resets and stops following', async () => {
    const extra = m.nowPlaying.getState().connect();
    await play(0);
    expect(m.calls('track:getLyrics')).toHaveLength(1);
    extra();
    expect(m.nowPlaying.getState().trackId).toBe(T[0]!.id); // still one connection left
    disconnects[1]!();
    expect(m.nowPlaying.getState()).toMatchObject({ trackId: undefined, lyrics: { status: 'idle' } });
    await play(2);
    expect(m.calls('track:getLyrics')).toHaveLength(1); // no longer following
  });

  it('starting while a track is already current loads it', async () => {
    disconnects[1]!();
    await play(0);
    const again = m.nowPlaying.getState().connect();
    await flush();
    expect(m.nowPlaying.getState().lyrics.availability).toBe('found');
    again();
  });
});
