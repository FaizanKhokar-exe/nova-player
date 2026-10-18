import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeMain, type FakeMain } from '../library/browse-test-support.js';
import { failure } from '../library/test-support.js';
import { flush, mediaUrlFor, track } from './test-support.js';

const T = Array.from({ length: 6 }, (_, i) => track(i + 1, { title: `Song ${i + 1}`, artist: 'Artist' }));

let m: FakeMain;
let disconnect: (() => void) | undefined;

beforeEach(async () => {
  m = createFakeMain(T);
  disconnect = m.playback.getState().connect();
  await flush();
});
afterEach(() => disconnect?.());

async function startAt(index: number): Promise<void> {
  await m.playback.getState().playTrack(T[index]!.id);
  m.fakes.audio.simStartPlayback(120);
  await flush();
}

describe('the queue window', () => {
  it('is not requested while the panel is closed, however much the queue changes', async () => {
    await startAt(0);
    await m.playback.getState().enqueue({ position: 'last', trackId: T[5]!.id });
    await m.playback.getState().setRepeatMode('all');
    expect(m.calls('playback:getQueue')).toEqual([]);
    expect(m.playback.getState().queue).toMatchObject({ open: false, status: 'idle', window: undefined });
  });

  it('opening loads a few tracks before the current one and the upcoming ones; closing forgets it', async () => {
    await startAt(4);
    m.playback.getState().setQueueOpen(true);
    await flush();
    expect(m.calls('playback:getQueue')).toEqual([{ offset: 0, limit: 200 + 4 + 1 }].map((r) => ({ offset: r.offset, limit: Math.min(1000, r.limit) })));
    expect(m.playback.getState().queue.window).toMatchObject({ total: 6, currentIndex: 4, offset: 0 });
    m.playback.getState().setQueueOpen(false);
    expect(m.playback.getState().queue).toMatchObject({ open: false, window: undefined, status: 'idle' });
  });

  it('is refreshed when main\'s revision moves, and only then (position ticks never re-read it)', async () => {
    await startAt(0);
    m.playback.getState().setQueueOpen(true);
    await flush();
    const loads = (): number => m.calls('playback:getQueue').length;
    const before = loads();
    for (let i = 0; i < 100; i += 1) m.fakes.audio.simTick(i / 4);
    await flush();
    expect(loads()).toBe(before);
    await m.playback.getState().setRepeatMode('one');
    await flush();
    expect(loads()).toBe(before + 1);
    await m.playback.getState().removeFromQueue(5, T[5]!.id);
    await flush();
    expect(loads()).toBe(before + 2);
    expect(m.playback.getState().queue.window?.total).toBe(5);
  });

  it('a duplicate state event with the SAME revision does not re-read the queue', async () => {
    await startAt(0);
    m.playback.getState().setQueueOpen(true);
    await flush();
    const before = m.calls('playback:getQueue').length;
    const state = m.playback.getState().session!;
    for (let i = 0; i < 5; i += 1) m.fakes.bridge.emit('playback:stateChanged', { reason: 'library-changed', state });
    await flush();
    expect(m.calls('playback:getQueue').length).toBe(before);
  });

  it('keeps showing the old window while it refreshes (no loading flash) and reports a failed read plainly', async () => {
    await startAt(0);
    m.playback.getState().setQueueOpen(true);
    await flush();
    const statuses: string[] = [];
    const unsubscribe = m.playback.subscribe((s) => statuses.push(s.queue.status));
    await m.playback.getState().enqueue({ position: 'last', trackId: T[5]!.id });
    await flush();
    unsubscribe();
    expect(statuses.every((s) => s === 'ready')).toBe(true);
    m.fakes.bridge.on('playback:getQueue', () => failure('internal', 'Something went wrong. The details were written to the application log.'));
    m.playback.getState().retryQueue();
    await flush();
    expect(m.playback.getState().queue).toMatchObject({ status: 'error', error: expect.stringContaining('Something went wrong') });
    expect(m.playback.getState().queue.window).toBeDefined(); // the last good window stays
  });
});

describe('queue edits and the audio element', () => {
  it('removing the PLAYING track makes the element follow main to the next track and keep playing', async () => {
    await startAt(1);
    const audio = m.fakes.audio;
    await m.playback.getState().removeFromQueue(1, T[1]!.id);
    expect(audio.src).toBe(mediaUrlFor(T[2]!));
    expect(m.playback.getState().session?.current?.track.id).toBe(T[2]!.id);
    expect(audio.paused).toBe(false); // it was playing; it continues
  });

  it('removing the playing track while PAUSED loads the next one paused (nothing starts by itself)', async () => {
    await startAt(1);
    m.playback.getState().pause();
    await flush();
    await m.playback.getState().removeFromQueue(1, T[1]!.id);
    expect(m.fakes.audio.src).toBe(mediaUrlFor(T[2]!));
    expect(m.fakes.audio.paused).toBe(true);
  });

  it('removing the last remaining track unloads the element', async () => {
    await m.playback.getState().enqueue({ position: 'last', trackId: T[0]!.id });
    await m.playback.getState().removeFromQueue(0, T[0]!.id);
    expect(m.playback.getState().session?.current).toBeUndefined();
    expect(m.fakes.audio.src).toBe('');
  });

  it('clear, move and removing another track leave the playing element untouched', async () => {
    await startAt(2);
    const audio = m.fakes.audio;
    const srcChanges = audio.srcHistory.length;
    const pauses = audio.pauseCalls;
    await m.playback.getState().moveQueueItem(5, T[5]!.id, 0);
    await m.playback.getState().removeFromQueue(0, T[5]!.id);
    await m.playback.getState().clearQueue();
    expect(audio.srcHistory).toHaveLength(srcChanges);
    expect(audio.pauseCalls).toBe(pauses);
    expect(audio.paused).toBe(false);
    expect(m.playback.getState().session).toMatchObject({ queueLength: 1, queueIndex: 0 });
  });

  it('playing a queue item starts that track', async () => {
    await startAt(0);
    await m.playback.getState().playQueueItem(3, T[3]!.id);
    expect(m.fakes.audio.src).toBe(mediaUrlFor(T[3]!));
  });

  it('a stale edit (the track is not where the view thought) changes nothing', async () => {
    await startAt(0);
    const revision = m.playback.getState().session?.revision;
    await m.playback.getState().removeFromQueue(3, T[5]!.id);
    expect(m.playback.getState().session?.queueLength).toBe(6);
    expect(m.playback.getState().session?.revision).toBe(revision);
  });

  it('every request names position AND track id; nothing else (no paths, no queue contents)', async () => {
    await startAt(0);
    await m.playback.getState().removeFromQueue(2, T[2]!.id);
    await m.playback.getState().moveQueueItem(3, T[4]!.id, 1);
    await m.playback.getState().playGroup({ kind: 'album', key: 'k' });
    await m.playback.getState().clearQueue();
    expect(m.calls('playback:removeFromQueue')).toEqual([{ index: 2, trackId: T[2]!.id }]);
    expect(m.calls('playback:moveQueueItem')).toEqual([{ index: 3, trackId: T[4]!.id, toIndex: 1 }]);
    expect(m.calls('playback:clearQueue')).toEqual([undefined]);
  });
});

describe('enqueue', () => {
  it('confirms in words with the label it was given, and a failure is an error, not a confirmation', async () => {
    await m.playback.getState().enqueue({ position: 'last', trackId: T[0]!.id }, '“Song 1”');
    expect(m.playback.getState().notice).toBe('“Song 1” added to the queue.');
    await m.playback.getState().enqueue({ position: 'next', trackId: T[1]!.id }, '“Song 2”');
    expect(m.playback.getState().notice).toBe('“Song 2” will play next.');
    m.playback.getState().dismissNotice();
    m.fakes.bridge.on('playback:enqueue', () => failure('track-not-found', 'That track is not in the library.'));
    await m.playback.getState().enqueue({ position: 'last', trackId: T[2]!.id });
    expect(m.playback.getState().notice).toBeUndefined();
    expect(m.playback.getState().error?.message).toBe('That track is not in the library.');
  });

  it('adding to an empty queue shows the track as current but starts nothing', async () => {
    await m.playback.getState().enqueue({ position: 'last', trackId: T[3]!.id });
    expect(m.playback.getState().session?.current?.track.id).toBe(T[3]!.id);
    expect(m.fakes.audio.paused).toBe(true);
    expect(m.fakes.audio.playCalls).toBe(0);
  });
});
