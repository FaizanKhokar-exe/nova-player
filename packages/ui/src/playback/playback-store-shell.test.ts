import { afterEach, describe, expect, it } from 'vitest';
import { createPlaybackStore, type PlaybackStoreApi } from './playback-store.js';
import { command, createPlaybackFakes, flush, mediaUrlFor, playbackState, track, type PlaybackFakes } from './test-support.js';

/** Phase 7: tray / media-key commands arrive as `shell:command` and run through the SAME store actions as the buttons. */
const A = track(1, { durationSeconds: 180 });
const B = track(2, { durationSeconds: 200 });
const C = track(3);

let fakes: PlaybackFakes;
let store: PlaybackStoreApi;
let disconnect: (() => void) | undefined;

async function connectPlaying(): Promise<void> {
  fakes = createPlaybackFakes(playbackState());
  store = createPlaybackStore(fakes.bridge, fakes.audio, { now: () => 0 });
  disconnect = store.getState().connect();
  await flush();
  fakes.backend.state = playbackState({ current: B, revision: 2, queueIndex: 1 });
  await store.getState().playTrack(B.id);
  fakes.audio.simStartPlayback();
  fakes.audio.simTick(7.4321);
}

afterEach(() => {
  disconnect?.();
  disconnect = undefined;
});

describe('shell:command', () => {
  it('toggle-play pauses a playing track and plays a paused one (the on-screen button path)', async () => {
    await connectPlaying();
    expect(fakes.audio.paused).toBe(false);
    fakes.bridge.emit('shell:command', { command: 'toggle-play' });
    expect(fakes.audio.paused).toBe(true);
    fakes.bridge.emit('shell:command', { command: 'toggle-play' });
    expect(fakes.audio.paused).toBe(false);
  });

  it('next goes through playback:next with the real position, and loads what main starts', async () => {
    await connectPlaying();
    fakes.bridge.on('playback:next', () => command('started', playbackState({ current: C, revision: 3, queueIndex: 2 })));
    fakes.bridge.emit('shell:command', { command: 'next' });
    await flush();
    expect(fakes.bridge.callsTo('playback:next')).toEqual([{ positionMs: 7432 }]);
    expect(fakes.audio.srcHistory.at(-1)).toBe(mediaUrlFor(C));
  });

  it('previous goes through playback:previous with the real position (main applies the restart threshold)', async () => {
    await connectPlaying();
    fakes.bridge.on('playback:previous', () => command('started', playbackState({ current: A, revision: 3, queueIndex: 0 })));
    fakes.bridge.emit('shell:command', { command: 'previous' });
    await flush();
    expect(fakes.bridge.callsTo('playback:previous')).toEqual([{ positionMs: 7432 }]);
    expect(fakes.audio.srcHistory.at(-1)).toBe(mediaUrlFor(A));
  });

  it('with nothing loaded, commands do nothing and call nothing', async () => {
    fakes = createPlaybackFakes(playbackState());
    store = createPlaybackStore(fakes.bridge, fakes.audio, { now: () => 0 });
    disconnect = store.getState().connect();
    await flush();
    fakes.bridge.emit('shell:command', { command: 'next' });
    fakes.bridge.emit('shell:command', { command: 'previous' });
    fakes.bridge.emit('shell:command', { command: 'toggle-play' });
    await flush();
    expect(fakes.bridge.callsTo('playback:next')).toEqual([]);
    expect(fakes.bridge.callsTo('playback:previous')).toEqual([]);
    expect(fakes.audio.srcHistory).toEqual([]);
  });

  it('disconnecting stops listening: reconnecting never doubles the handler', async () => {
    await connectPlaying();
    disconnect?.();
    disconnect = store.getState().connect();
    await flush();
    fakes.bridge.on('playback:next', () => command('started', playbackState({ current: C, revision: 4, queueIndex: 2 })));
    fakes.bridge.emit('shell:command', { command: 'next' });
    await flush();
    expect(fakes.bridge.callsTo('playback:next')).toHaveLength(1);
  });
});
