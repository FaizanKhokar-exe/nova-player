import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPlaybackStore, type PlaybackStoreApi } from './playback-store.js';
import { command, createPlaybackFakes, failure, flush, mediaUrlFor, playbackState, result, track, type PlaybackFakes } from './test-support.js';

const A = track(1, { durationSeconds: 180 });
const B = track(2, { durationSeconds: 200 });
const C = track(3);

let fakes: PlaybackFakes;
let store: PlaybackStoreApi;
let disconnect: (() => void) | undefined;
let clock = 0;

function setup(initial = playbackState(), options: Parameters<typeof createPlaybackStore>[2] = {}) {
  fakes = createPlaybackFakes(initial);
  store = createPlaybackStore(fakes.bridge, fakes.audio, { now: () => clock, ...options });
}
async function connect(): Promise<void> {
  disconnect = store.getState().connect();
  await flush();
}
const state = () => store.getState();
const position = () => state().positionStore.getState().positionMs;

beforeEach(() => {
  clock = 0;
  setup();
});
afterEach(() => {
  disconnect?.();
  disconnect = undefined;
});

describe('flushPosition (the page is going away)', () => {
  it('saves the current position at once, even inside the checkpoint interval, and again as it moves', async () => {
    fakes.backend.state = playbackState({ current: A });
    await connect();
    await state().playTrack(A.id);
    fakes.audio.simStartPlayback();
    fakes.audio.simTick(1);
    fakes.audio.simTick(3.4); // inside the 5 s interval: the periodic save did not fire for this one
    fakes.bridge.calls.length = 0;
    state().flushPosition();
    expect(fakes.bridge.callsTo('playback:reportPosition')).toEqual([{ trackId: A.id, positionMs: 3_400 }]);
  });

  it('does nothing when no track is loaded', async () => {
    await connect();
    state().flushPosition();
    expect(fakes.bridge.callsTo('playback:reportPosition')).toEqual([]);
  });

  it('does not overwrite a restored position that has not been applied yet (the element still reports 0)', async () => {
    setup(playbackState({ current: A, positionMs: 31_000 }));
    await connect(); // source loaded, but `loadedmetadata` has not fired: the saved position is still pending
    fakes.bridge.calls.length = 0;
    state().flushPosition();
    expect(fakes.bridge.callsTo('playback:reportPosition')).toEqual([]);
  });
});

describe('connecting', () => {
  it('starts disconnected, empty and stopped', () => {
    expect(state()).toMatchObject({
      connection: 'disconnected',
      session: undefined,
      error: undefined,
      notice: undefined,
      engine: { loaded: false, playing: false, buffering: false, durationMs: undefined, volume: 1, muted: false },
    });
    expect(position()).toBe(0);
  });

  it('with nothing saved: ready, no source loaded, audio untouched', async () => {
    await connect();
    expect(state().connection).toBe('ready');
    expect(state().session?.current).toBeUndefined();
    expect(fakes.audio.srcHistory).toEqual([]);
    expect(fakes.audio.playCalls).toBe(0);
  });

  it('restores a saved session PAUSED at its saved position: loads the source, never autoplays', async () => {
    setup(playbackState({ current: A, positionMs: 31_000, queueLength: 5, queueIndex: 2, repeatMode: 'all', shuffle: true }));
    await connect();
    expect(state().session).toMatchObject({ repeatMode: 'all', shuffle: true, queueLength: 5, queueIndex: 2 });
    expect(fakes.audio.srcHistory).toEqual([mediaUrlFor(A)]);
    expect(fakes.audio.playCalls).toBe(0);
    expect(state().engine).toMatchObject({ playing: false, loaded: false, buffering: true, durationMs: 180_000 });
    expect(position()).toBe(31_000); // shown at once, before the metadata has even loaded

    fakes.audio.simLoadedMetadata(180.04);
    expect(fakes.audio.currentTime).toBe(31); // the browser is told, in seconds, once it can seek
    expect(state().engine).toMatchObject({ loaded: true, durationMs: 180_040 });
    expect(position()).toBe(31_000);
  });

  it('reports a failed initial load as a failed connection with a message', async () => {
    fakes.bridge.on('playback:getState', () => failure('internal', 'Something went wrong.'));
    await connect();
    expect(state()).toMatchObject({ connection: 'failed', error: { message: 'Something went wrong.' } });
    fakes.bridge.on('playback:getState', () => result(playbackState()));
    await state().reload();
    expect(state().connection).toBe('ready');
  });

  it('survives a bridge that rejects: folded into an "unavailable" failure', async () => {
    fakes.bridge.on('playback:getState', () => Promise.reject(new Error('dead')));
    await connect();
    expect(state()).toMatchObject({ connection: 'failed', error: { message: expect.stringContaining('Could not reach') } });
  });

  it('is reference-counted: Strict Mode mount/unmount/mount leaves ONE set of listeners and ONE source load', async () => {
    setup(playbackState({ current: A, positionMs: 1000 }));
    const first = state().connect();
    first(); // unmount
    const second = state().connect(); // mount again
    disconnect = second;
    await flush();
    expect(fakes.bridge.subscriberCount('playback:stateChanged')).toBe(1);
    const perEvent = fakes.audio.listenerCount();
    expect(perEvent).toBeGreaterThan(0);
    expect(fakes.audio.listenerCount('ended')).toBe(1);
    expect(fakes.audio.listenerCount('timeupdate')).toBe(1);
    expect(fakes.audio.srcHistory).toEqual([mediaUrlFor(A)]); // the discarded first load never touched the element
    second();
    disconnect = undefined;
    expect(fakes.audio.listenerCount()).toBe(0);
    expect(fakes.bridge.subscriberCount()).toBe(0);
  });

  it('two live connections share one set of listeners; the last disconnect removes them', async () => {
    const a = state().connect();
    const b = state().connect();
    await flush();
    expect(fakes.audio.listenerCount('ended')).toBe(1);
    a();
    expect(fakes.audio.listenerCount('ended')).toBe(1);
    b();
    expect(fakes.audio.listenerCount()).toBe(0);
    a(); // idempotent
    b();
  });

  it('listens to the minimum useful set of media events (no blanket subscription)', async () => {
    await connect();
    const used = ['loadedmetadata', 'durationchange', 'canplay', 'play', 'playing', 'waiting', 'pause', 'timeupdate', 'seeked', 'ended', 'error', 'volumechange'];
    for (const type of used) expect(fakes.audio.listenerCount(type), type).toBe(1);
    expect(fakes.audio.listenerCount()).toBe(used.length);
  });

  it('disconnecting pauses the audio and saves the position', async () => {
    fakes.backend.state = playbackState({ current: A });
    await connect();
    await state().playTrack(A.id);
    fakes.audio.simStartPlayback();
    fakes.audio.simTick(12.5);
    fakes.bridge.calls.length = 0;
    disconnect?.();
    disconnect = undefined;
    expect(fakes.audio.paused).toBe(true);
    expect(fakes.bridge.callsTo('playback:reportPosition')).toContainEqual({ trackId: A.id, positionMs: 12_500 });
  });
});

describe('playTrack', () => {
  beforeEach(connect);

  it('asks main to play the track from the given list, then loads and plays the source it returns', async () => {
    fakes.backend.state = playbackState({ current: B, revision: 2, queueLength: 9, queueIndex: 4 });
    await state().playTrack(B.id, { kind: 'search', query: 'two' });
    expect(fakes.bridge.callsTo('playback:playTrack')).toEqual([{ trackId: B.id, context: { kind: 'search', query: 'two' } }]);
    expect(fakes.audio.srcHistory).toEqual([mediaUrlFor(B)]);
    expect(fakes.audio.playCalls).toBe(1);
    expect(state().session).toMatchObject({ queueLength: 9, queueIndex: 4 });
    expect(state().engine.buffering).toBe(true);
  });

  it('sends no context when none is given (main defaults to the library)', async () => {
    fakes.backend.state = playbackState({ current: A, revision: 2 });
    await state().playTrack(A.id);
    expect(fakes.bridge.callsTo('playback:playTrack')).toEqual([{ trackId: A.id }]);
  });

  it('follows the real media events: loading -> buffered -> playing', async () => {
    fakes.backend.state = playbackState({ current: A, revision: 2 });
    await state().playTrack(A.id);
    expect(state().engine).toMatchObject({ loaded: false, buffering: true });
    fakes.audio.simLoadedMetadata(181.5);
    expect(state().engine).toMatchObject({ loaded: true, durationMs: 181_500 });
    fakes.audio.simCanPlay();
    expect(state().engine.buffering).toBe(false);
    fakes.audio.simPlaying();
    expect(state().engine).toMatchObject({ playing: true, buffering: false });
  });

  it('falls back to the track\'s tag duration while the element has none (e.g. a VBR file with no header)', async () => {
    fakes.backend.state = playbackState({ current: A, revision: 2 });
    await state().playTrack(A.id);
    expect(state().engine.durationMs).toBe(180_000);
    fakes.audio.simLoadedMetadata(Number.POSITIVE_INFINITY);
    expect(state().engine.durationMs).toBe(180_000);
  });

  it('shows the stalled state with `waiting` and recovers with `playing`', async () => {
    fakes.backend.state = playbackState({ current: A, revision: 2 });
    await state().playTrack(A.id);
    fakes.audio.simStartPlayback();
    fakes.audio.simWaiting();
    expect(state().engine).toMatchObject({ playing: true, buffering: true });
    fakes.audio.simPlaying();
    expect(state().engine.buffering).toBe(false);
  });

  it('a track that cannot be queued reports main\'s message and leaves the audio alone', async () => {
    fakes.backend.state = playbackState({ current: A, revision: 2 });
    await state().playTrack(A.id);
    fakes.audio.simStartPlayback();
    fakes.bridge.on('playback:playTrack', () => failure('track-not-found', 'That track is not in the library.', 'playback:playTrack'));
    await state().playTrack(C.id);
    expect(state().error).toMatchObject({ message: 'That track is not in the library.', retryable: false });
    expect(fakes.audio.srcHistory).toEqual([mediaUrlFor(A)]);
    expect(fakes.audio.paused).toBe(false); // still playing A
  });

  it('starting another track clears the previous error: the library stays usable after a failure', async () => {
    fakes.backend.state = playbackState({ current: A, revision: 2 });
    await state().playTrack(A.id);
    fakes.audio.simFail(4);
    await flush();
    expect(state().error).toBeDefined();
    fakes.backend.state = playbackState({ current: B, revision: 3 });
    await state().playTrack(B.id);
    expect(state().error).toBeUndefined();
    expect(fakes.audio.srcHistory).toEqual([mediaUrlFor(A), mediaUrlFor(B)]);
  });

  it('playing the track that is already loaded starts it over, without reloading the source', async () => {
    fakes.backend.state = playbackState({ current: A, revision: 2 });
    await state().playTrack(A.id);
    fakes.audio.simStartPlayback();
    fakes.audio.simTick(40);
    fakes.backend.state = playbackState({ current: A, revision: 3 });
    await state().playTrack(A.id);
    expect(fakes.audio.srcHistory).toEqual([mediaUrlFor(A)]);
    expect(fakes.audio.currentTime).toBe(0);
    expect(position()).toBe(0);
    expect(fakes.audio.paused).toBe(false);
  });

  it('saves the position of the track being left before switching', async () => {
    fakes.backend.state = playbackState({ current: A, revision: 2 });
    await state().playTrack(A.id);
    fakes.audio.simStartPlayback();
    fakes.audio.simTick(61.2345);
    fakes.bridge.calls.length = 0;
    fakes.backend.state = playbackState({ current: B, revision: 3 });
    await state().playTrack(B.id);
    const calls = fakes.bridge.calls.map((c) => c.channel);
    expect(calls.indexOf('playback:reportPosition')).toBeLessThan(calls.indexOf('playback:playTrack'));
    expect(fakes.bridge.callsTo('playback:reportPosition')[0]).toEqual({ trackId: A.id, positionMs: 61_235 });
  });
});

describe('rapid track changes: the newest command wins', () => {
  beforeEach(connect);

  it('a slow response for an older click can never overwrite a newer track', async () => {
    const slow = fakes.bridge.hold('playback:playTrack');
    fakes.bridge.on('playback:playTrack', (r) => command('started', playbackState({ current: (r as { trackId: string }).trackId === A.id ? A : B, revision: (r as { trackId: string }).trackId === A.id ? 2 : 3 })));
    const first = state().playTrack(A.id);
    const second = state().playTrack(B.id);
    slow.release();
    await Promise.all([first, second]);
    await flush();
    expect(fakes.audio.srcHistory).toEqual([mediaUrlFor(B)]);
    expect(state().session?.current?.track.id).toBe(B.id);
  });

  it('five quick clicks load only the last track', async () => {
    const tracks = [A, B, C, track(4), track(5)];
    fakes.bridge.on('playback:playTrack', (r) => {
      const index = tracks.findIndex((t) => t.id === (r as { trackId: string }).trackId);
      return command('started', playbackState({ current: tracks[index]!, revision: 10 + index }));
    });
    await Promise.all(tracks.map((t) => state().playTrack(t.id)));
    expect(fakes.audio.srcHistory).toEqual([mediaUrlFor(tracks[4]!)]);
  });

  it('a late play() rejection (AbortError from the interrupted load) is ignored, not shown as an error', async () => {
    fakes.backend.state = playbackState({ current: A, revision: 2 });
    fakes.audio.rejectNextPlayWith = 'AbortError';
    await state().playTrack(A.id);
    await flush();
    expect(state().error).toBeUndefined();
  });

  it('a blocked play() (NotAllowedError) asks the user to press Play', async () => {
    fakes.backend.state = playbackState({ current: A, revision: 2 });
    fakes.audio.rejectNextPlayWith = 'NotAllowedError';
    await state().playTrack(A.id);
    await flush();
    expect(state().error?.message).toContain('Press Play');
  });
});

describe('play / pause / toggle', () => {
  beforeEach(async () => {
    await connect();
    fakes.backend.state = playbackState({ current: A, revision: 2 });
    await state().playTrack(A.id);
    fakes.audio.simStartPlayback();
  });

  it('pauses and resumes the real element; the UI state follows its events', () => {
    expect(state().engine.playing).toBe(true);
    state().togglePlay();
    expect(fakes.audio.paused).toBe(true);
    expect(state().engine.playing).toBe(false);
    const plays = fakes.audio.playCalls;
    state().togglePlay();
    expect(fakes.audio.playCalls).toBe(plays + 1);
    expect(fakes.audio.paused).toBe(false);
    expect(state().engine.playing).toBe(true);
  });

  it('pause() is explicit and idempotent', () => {
    state().pause();
    state().pause();
    expect(fakes.audio.paused).toBe(true);
    expect(state().engine.playing).toBe(false);
  });

  it('reflects a pause that did not come from us (e.g. a media key or the OS)', () => {
    fakes.audio.pause();
    expect(state().engine.playing).toBe(false);
  });

  it('toggle with nothing loaded does nothing', async () => {
    setup();
    await connect();
    state().togglePlay();
    expect(fakes.audio.playCalls).toBe(0);
  });

  it('toggle on a restored (paused, not yet played) session starts the loaded track', async () => {
    setup(playbackState({ current: A, positionMs: 5000 }));
    await connect();
    fakes.audio.simLoadedMetadata(180);
    state().togglePlay();
    expect(fakes.audio.paused).toBe(false);
    expect(fakes.audio.srcHistory).toEqual([mediaUrlFor(A)]); // no reload
    expect(fakes.audio.currentTime).toBe(5);
  });
});

describe('position: whole milliseconds, kept out of the main store', () => {
  beforeEach(async () => {
    await connect();
    fakes.backend.state = playbackState({ current: A, revision: 2 });
    await state().playTrack(A.id);
    fakes.audio.simStartPlayback();
  });

  it('converts the browser\'s fractional seconds to INTEGER milliseconds', () => {
    fakes.audio.simTick(1.23456);
    expect(position()).toBe(1235);
    expect(Number.isInteger(position())).toBe(true);
    fakes.audio.simTick(0.0004);
    expect(position()).toBe(0);
    fakes.audio.simTick(3599.9996);
    expect(position()).toBe(3_600_000);
  });

  it('treats a nonsensical currentTime (NaN, negative) as 0', () => {
    fakes.audio.simTick(Number.NaN);
    expect(position()).toBe(0);
    fakes.audio.simTick(-3);
    expect(position()).toBe(0);
  });

  it('a timeupdate does NOT notify subscribers of the main store (only the position store)', () => {
    const mainListener = vi.fn();
    const positionListener = vi.fn();
    const offMain = store.subscribe(mainListener);
    const offPos = state().positionStore.subscribe(positionListener);
    for (let t = 1; t <= 20; t += 0.25) fakes.audio.simTick(t);
    expect(mainListener).not.toHaveBeenCalled();
    expect(positionListener).toHaveBeenCalledTimes(77);
    offMain();
    offPos();
  });

  it('does not notify when the whole-ms value did not change', () => {
    fakes.audio.simTick(2);
    const listener = vi.fn();
    const off = state().positionStore.subscribe(listener);
    fakes.audio.simTick(2.0001);
    expect(listener).not.toHaveBeenCalled();
    off();
  });
});

describe('saving the position', () => {
  beforeEach(async () => {
    await connect();
    fakes.backend.state = playbackState({ current: A, revision: 2 });
    await state().playTrack(A.id);
    fakes.audio.simStartPlayback();
    fakes.bridge.calls.length = 0;
  });
  const saved = () => fakes.bridge.callsTo('playback:reportPosition');

  it('while playing, saves at most once per interval (default 5 s), as whole ms', () => {
    clock = 100_000;
    fakes.audio.simTick(1.1);
    expect(saved()).toEqual([{ trackId: A.id, positionMs: 1100 }]);
    clock = 102_000;
    fakes.audio.simTick(3.1);
    clock = 104_999;
    fakes.audio.simTick(5.0);
    expect(saved()).toHaveLength(1);
    clock = 105_000;
    fakes.audio.simTick(6.0);
    expect(saved()).toHaveLength(2);
    expect(saved()[1]).toEqual({ trackId: A.id, positionMs: 6000 });
  });

  it('pausing saves immediately, regardless of the throttle', () => {
    clock = 100_000;
    fakes.audio.simTick(1);
    clock = 100_010;
    fakes.audio.simTick(2);
    state().pause();
    expect(saved().at(-1)).toEqual({ trackId: A.id, positionMs: 2000 });
  });

  it('seeking saves immediately', async () => {
    state().seekMs(90_000);
    await flush();
    expect(saved().at(-1)).toEqual({ trackId: A.id, positionMs: 90_000 });
  });

  it('does not save from timeupdate events while paused', () => {
    state().pause();
    fakes.bridge.calls.length = 0;
    clock = 999_999;
    fakes.audio.simTick(9);
    expect(saved()).toEqual([]);
  });

  it('a save that fails is silent and never interrupts playback', async () => {
    fakes.bridge.on('playback:reportPosition', () => Promise.reject(new Error('gone')));
    clock = 500_000;
    fakes.audio.simTick(4);
    await flush();
    expect(state().error).toBeUndefined();
    expect(fakes.audio.paused).toBe(false);
  });

  it('honours a custom interval', async () => {
    setup(playbackState({ current: A, revision: 2 }), { positionSaveIntervalMs: 1000 });
    await connect();
    await state().playTrack(A.id);
    fakes.audio.simStartPlayback();
    fakes.bridge.calls.length = 0;
    clock = 10_000;
    fakes.audio.simTick(1);
    clock = 11_000;
    fakes.audio.simTick(2);
    expect(saved()).toHaveLength(2);
  });
});

describe('seek', () => {
  beforeEach(async () => {
    await connect();
    fakes.backend.state = playbackState({ current: A, revision: 2 });
    await state().playTrack(A.id);
  });

  it('is ignored until the source has loaded its metadata', () => {
    state().seekMs(30_000);
    expect(fakes.audio.currentTime).toBe(0);
  });

  it('sets the element\'s time in SECONDS from whole milliseconds, and updates the position at once', () => {
    fakes.audio.simStartPlayback(180);
    state().seekMs(30_500);
    expect(fakes.audio.currentTime).toBe(30.5);
    expect(position()).toBe(30_500);
  });

  it('clamps to the start and to the duration, and rounds to whole ms', () => {
    fakes.audio.simStartPlayback(180);
    state().seekMs(-5000);
    expect(fakes.audio.currentTime).toBe(0);
    state().seekMs(999_999_999);
    expect(fakes.audio.currentTime).toBe(180);
    state().seekMs(1234.6);
    expect(position()).toBe(1235);
  });

  it('keeps the play state: seeking while paused stays paused', () => {
    fakes.audio.simStartPlayback(180);
    state().pause();
    state().seekMs(10_000);
    expect(fakes.audio.paused).toBe(true);
  });
});

describe('volume and mute (the element is the source of truth)', () => {
  beforeEach(connect);

  it('setVolume drives the element; the store follows its volumechange event', () => {
    state().setVolume(0.4);
    expect(fakes.audio.volume).toBe(0.4);
    expect(state().engine.volume).toBe(1); // not assumed: only the event updates the store
    fakes.audio.simVolumeChanged();
    expect(state().engine.volume).toBe(0.4);
  });

  it('clamps out-of-range and invalid volumes', () => {
    state().setVolume(3);
    expect(fakes.audio.volume).toBe(1);
    state().setVolume(-1);
    expect(fakes.audio.volume).toBe(0);
    state().setVolume(Number.NaN);
    expect(fakes.audio.volume).toBe(1);
  });

  it('toggleMute flips the element and the store follows', () => {
    state().toggleMute();
    expect(fakes.audio.muted).toBe(true);
    fakes.audio.simVolumeChanged();
    expect(state().engine.muted).toBe(true);
    state().toggleMute();
    fakes.audio.simVolumeChanged();
    expect(state().engine.muted).toBe(false);
  });

  it('raising the volume while muted un-mutes', () => {
    state().toggleMute();
    state().setVolume(0.7);
    expect(fakes.audio.muted).toBe(false);
    expect(fakes.audio.volume).toBe(0.7);
  });

  it('picks up a volume change that did not come from the UI', () => {
    fakes.audio.volume = 0.25;
    fakes.audio.muted = true;
    fakes.audio.simVolumeChanged();
    expect(state().engine).toMatchObject({ volume: 0.25, muted: true });
  });
});

describe('a track ending: main decides what happens next (Phase 1 domain rules, via IPC)', () => {
  beforeEach(async () => {
    await connect();
    fakes.backend.state = playbackState({ current: A, revision: 2 });
    await state().playTrack(A.id);
    fakes.audio.simStartPlayback();
  });

  it('reports the finished track id to main - and nothing else decides the next track here', async () => {
    fakes.bridge.on('playback:trackFinished', () => command('started', playbackState({ current: B, revision: 3 })));
    fakes.audio.simEnded();
    await flush();
    expect(fakes.bridge.callsTo('playback:trackFinished')).toEqual([{ trackId: A.id }]);
    expect(fakes.audio.srcHistory).toEqual([mediaUrlFor(A), mediaUrlFor(B)]);
    expect(fakes.audio.paused).toBe(false);
    expect(state().session?.current?.track.id).toBe(B.id);
  });

  it('"started": the next track loads and plays from 0', async () => {
    fakes.bridge.on('playback:trackFinished', () => command('started', playbackState({ current: B, revision: 3 })));
    fakes.audio.simEnded();
    await flush();
    expect(position()).toBe(0);
    expect(state().engine).toMatchObject({ playing: true, buffering: true, loaded: false });
  });

  it('"restart" (repeat one): the SAME source plays again from 0, without reloading', async () => {
    fakes.bridge.on('playback:trackFinished', () => command('restart', playbackState({ current: A, revision: 3, repeatMode: 'one' })));
    fakes.audio.simTick(179.9);
    fakes.audio.simEnded();
    await flush();
    expect(fakes.audio.srcHistory).toEqual([mediaUrlFor(A)]);
    expect(fakes.audio.currentTime).toBe(0);
    expect(fakes.audio.paused).toBe(false);
    expect(position()).toBe(0);
  });

  it('"stop" (queue exhausted): stays on the last track, stopped, back at the start', async () => {
    fakes.bridge.on('playback:trackFinished', () => command('stop', playbackState({ current: A, revision: 3, canNext: false })));
    fakes.audio.simTick(179.9);
    fakes.audio.simEnded();
    await flush();
    expect(fakes.audio.paused).toBe(true);
    expect(fakes.audio.currentTime).toBe(0);
    expect(position()).toBe(0);
    expect(state().engine.playing).toBe(false);
    expect(state().session?.current?.track.id).toBe(A.id);
    expect(fakes.audio.srcHistory).toEqual([mediaUrlFor(A)]);
    // The user can press Play to hear it again.
    state().togglePlay();
    expect(fakes.audio.paused).toBe(false);
  });

  it('"none" (a stale report): changes nothing', async () => {
    fakes.bridge.on('playback:trackFinished', () => command('none', playbackState({ current: A, revision: 3 })));
    fakes.audio.simEnded();
    await flush();
    expect(fakes.audio.srcHistory).toEqual([mediaUrlFor(A)]);
  });

  it('if the user starts another track while main is deciding, the user wins', async () => {
    const hold = fakes.bridge.hold('playback:trackFinished');
    fakes.bridge.on('playback:trackFinished', () => command('started', playbackState({ current: B, revision: 3 })));
    fakes.audio.simEnded();
    fakes.bridge.on('playback:playTrack', () => command('started', playbackState({ current: C, revision: 4 })));
    await state().playTrack(C.id);
    hold.release();
    await flush();
    expect(fakes.audio.srcHistory).toEqual([mediaUrlFor(A), mediaUrlFor(C)]);
    expect(state().session?.current?.track.id).toBe(C.id);
  });

  it('a failed trackFinished reports main\'s message and leaves the player stopped', async () => {
    fakes.bridge.on('playback:trackFinished', () => failure('internal', 'Something went wrong.'));
    fakes.audio.simEnded();
    await flush();
    expect(state().error?.message).toBe('Something went wrong.');
    expect(state().engine.playing).toBe(false);
  });
});

describe('next / previous: the position goes to main, which applies the domain rules', () => {
  beforeEach(async () => {
    await connect();
    fakes.backend.state = playbackState({ current: B, revision: 2, queueIndex: 1 });
    await state().playTrack(B.id);
    fakes.audio.simStartPlayback();
    fakes.audio.simTick(7.4321);
  });

  it('next sends the current position in whole ms and loads what main starts', async () => {
    fakes.bridge.on('playback:next', () => command('started', playbackState({ current: C, revision: 3, queueIndex: 2 })));
    await state().next();
    expect(fakes.bridge.callsTo('playback:next')).toEqual([{ positionMs: 7432 }]);
    expect(fakes.audio.srcHistory.at(-1)).toBe(mediaUrlFor(C));
    expect(fakes.audio.paused).toBe(false);
  });

  it('previous sends the position; "restart" re-plays the same source from 0', async () => {
    fakes.bridge.on('playback:previous', () => command('restart', playbackState({ current: B, revision: 3, queueIndex: 1 })));
    await state().previous();
    expect(fakes.bridge.callsTo('playback:previous')).toEqual([{ positionMs: 7432 }]);
    expect(fakes.audio.srcHistory).toEqual([mediaUrlFor(B)]);
    expect(fakes.audio.currentTime).toBe(0);
    expect(fakes.audio.paused).toBe(false);
  });

  it('previous "started": loads the earlier track', async () => {
    fakes.bridge.on('playback:previous', () => command('started', playbackState({ current: A, revision: 3, queueIndex: 0 })));
    await state().previous();
    expect(fakes.audio.srcHistory.at(-1)).toBe(mediaUrlFor(A));
  });

  it('"none" (no next track): the track keeps playing, untouched', async () => {
    fakes.bridge.on('playback:next', () => command('none', playbackState({ current: B, revision: 3, canNext: false, queueIndex: 1 })));
    await state().next();
    expect(fakes.audio.srcHistory).toEqual([mediaUrlFor(B)]);
    expect(fakes.audio.paused).toBe(false);
    expect(state().session?.canNext).toBe(false);
  });

  it('two quick Next presses that main answered "started" then "none" still end on the right track (self-healing)', async () => {
    const first = fakes.bridge.hold('playback:next');
    let call = 0;
    fakes.bridge.on('playback:next', () => (++call === 1 ? command('started', playbackState({ current: C, revision: 3 })) : command('none', playbackState({ current: C, revision: 4, canNext: false }))));
    const p1 = state().next();
    const p2 = state().next();
    first.release();
    await Promise.all([p1, p2]);
    await flush();
    expect(state().session?.current?.track.id).toBe(C.id);
    expect(fakes.audio.srcHistory.at(-1)).toBe(mediaUrlFor(C)); // the element followed main even though the last outcome was "none"
    expect(fakes.audio.paused).toBe(false);
  });

  it('do nothing with nothing loaded', async () => {
    setup();
    await connect();
    await state().next();
    await state().previous();
    expect(fakes.bridge.callsTo('playback:next')).toEqual([]);
    expect(fakes.bridge.callsTo('playback:previous')).toEqual([]);
  });

  it('a refused command surfaces main\'s message', async () => {
    fakes.bridge.on('playback:next', () => failure('forbidden', 'This request did not come from the application window.'));
    await state().next();
    expect(state().error?.message).toContain('did not come');
  });
});

describe('repeat and shuffle (modes live in main; the store mirrors them)', () => {
  beforeEach(async () => {
    await connect();
    fakes.backend.state = playbackState({ current: A, revision: 2 });
    await state().playTrack(A.id);
    fakes.audio.simStartPlayback();
  });

  it('cycles off -> all -> one -> off through main, mirroring each answer', async () => {
    const seen: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      await state().cycleRepeatMode();
      seen.push(state().session!.repeatMode);
    }
    expect(seen).toEqual(['all', 'one', 'off', 'all']);
    expect(fakes.bridge.callsTo('playback:setRepeatMode')).toEqual([{ mode: 'all' }, { mode: 'one' }, { mode: 'off' }, { mode: 'all' }]);
  });

  it('sets a specific repeat mode', async () => {
    await state().setRepeatMode('one');
    expect(state().session?.repeatMode).toBe('one');
  });

  it('toggles shuffle through main', async () => {
    await state().setShuffle(true);
    expect(state().session?.shuffle).toBe(true);
    await state().setShuffle(false);
    expect(state().session?.shuffle).toBe(false);
    expect(fakes.bridge.callsTo('playback:setShuffle')).toEqual([{ enabled: true }, { enabled: false }]);
  });

  it('changing a mode never interrupts the audio', async () => {
    const before = [fakes.audio.playCalls, fakes.audio.pauseCalls, fakes.audio.srcHistory.length];
    await state().setShuffle(true);
    await state().cycleRepeatMode();
    expect([fakes.audio.playCalls, fakes.audio.pauseCalls, fakes.audio.srcHistory.length]).toEqual(before);
    expect(fakes.audio.paused).toBe(false);
  });

  it('a refused mode change is reported and the mirrored mode is unchanged', async () => {
    fakes.bridge.on('playback:setShuffle', () => failure('internal', 'Something went wrong.'));
    await state().setShuffle(true);
    expect(state().error?.message).toBe('Something went wrong.');
    expect(state().session?.shuffle).toBe(false);
  });
});

describe('playback errors', () => {
  beforeEach(async () => {
    await connect();
    fakes.backend.state = playbackState({ current: A, revision: 2 });
    await state().playTrack(A.id);
  });

  it.each([
    ['file-missing', "This file can't be found. It may have been moved or deleted."],
    ['folder-unavailable', "The folder this track is in isn't available right now. Is the drive connected?"],
    ['file-inaccessible', "Nova Player can't open this file."],
    ['not-in-library', 'This track is no longer in your library.'],
    ['unsupported-format', "This type of file can't be played."],
    ['invalid-source', "This track can't be played."],
  ])('when main says the problem is %s, the user reads: %s', async (problem, message) => {
    fakes.backend.diagnosis = { problem };
    fakes.audio.simFail(4);
    await flush();
    expect(state().error).toEqual({ message, trackId: A.id, retryable: true });
    expect(state().engine).toMatchObject({ playing: false, buffering: false });
  });

  it.each([
    [4, "This audio format isn't supported by the player."],
    [3, 'This file looks damaged and could not be decoded.'],
    [2, 'This file could not be read.'],
    [99, "This track can't be played."],
  ])('when main can open the file but the decoder fails (code %i): %s', async (code, message) => {
    fakes.backend.diagnosis = {};
    fakes.audio.simFail(code);
    await flush();
    expect(state().error?.message).toBe(message);
  });

  it('still explains a decoder failure when the diagnosis itself cannot be fetched', async () => {
    fakes.backend.diagnosis = 'fail';
    fakes.audio.simFail(3);
    await flush();
    expect(state().error?.message).toBe('This file looks damaged and could not be decoded.');
  });

  it('ignores MEDIA_ERR_ABORTED: that is us replacing the source', async () => {
    fakes.audio.simFail(1);
    await flush();
    expect(state().error).toBeUndefined();
    expect(fakes.bridge.callsTo('playback:diagnoseSource')).toEqual([]);
  });

  it('the message never contains a file path, an errno, or an internal denial', async () => {
    for (const problem of ['file-missing', 'file-inaccessible', 'folder-unavailable']) {
      fakes.backend.diagnosis = { problem };
      fakes.audio.simFail(4);
      await flush();
      expect(state().error?.message).not.toMatch(/[\\/]|ENOENT|EACCES|root|outside|Error:|sqlite/i);
    }
  });

  it('a diagnosis for a track that is no longer loaded is discarded (no stale error on the new track)', async () => {
    const hold = fakes.bridge.hold('playback:diagnoseSource');
    fakes.backend.diagnosis = { problem: 'file-missing' };
    fakes.audio.simFail(4);
    fakes.backend.state = playbackState({ current: B, revision: 3 });
    await state().playTrack(B.id);
    hold.release();
    await flush();
    expect(state().error).toBeUndefined();
  });

  it('Play after an error retries the source from where it was (retryable)', async () => {
    fakes.audio.simStartPlayback();
    fakes.audio.simTick(42);
    fakes.audio.simFail(2);
    await flush();
    expect(state().error?.retryable).toBe(true);
    state().togglePlay();
    await flush();
    expect(fakes.audio.srcHistory).toEqual([mediaUrlFor(A), mediaUrlFor(A)]);
    expect(state().error).toBeUndefined();
    expect(fakes.audio.paused).toBe(false);
    fakes.audio.simLoadedMetadata(180);
    expect(fakes.audio.currentTime).toBe(42);
  });

  it('a retry first asks main for the track\'s current address and loads THAT (a failed address is not reused)', async () => {
    fakes.audio.simFail(4);
    await flush();
    // After diagnosing the failure, main now hands out the same track under a fresh address.
    const retried = { ...A };
    fakes.backend.state = { ...playbackState({ current: retried, revision: 2 }), current: { track: retried, mediaUrl: `${mediaUrlFor(A)}?v=1` } };
    fakes.bridge.calls.length = 0;
    state().togglePlay();
    await flush();
    expect(fakes.bridge.callsTo('playback:getState')).toHaveLength(1);
    expect(fakes.audio.srcHistory.at(-1)).toBe(`${mediaUrlFor(A)}?v=1`);
    expect(fakes.audio.paused).toBe(false);
  });

  it('a retry that races with the user starting another track does not load the old one', async () => {
    fakes.audio.simFail(4);
    await flush();
    const hold = fakes.bridge.hold('playback:getState');
    state().togglePlay();
    fakes.backend.state = playbackState({ current: B, revision: 3 });
    fakes.bridge.on('playback:playTrack', () => command('started', playbackState({ current: B, revision: 3 })));
    await state().playTrack(B.id);
    hold.release();
    await flush();
    expect(fakes.audio.srcHistory).toEqual([mediaUrlFor(A), mediaUrlFor(B)]);
  });

  it('can be dismissed', async () => {
    fakes.audio.simFail(4);
    await flush();
    state().dismissError();
    expect(state().error).toBeUndefined();
  });
});

describe('the library changing under playback (main pushes playback:stateChanged)', () => {
  beforeEach(async () => {
    await connect();
    fakes.backend.state = playbackState({ current: A, revision: 2 });
    await state().playTrack(A.id);
    fakes.audio.simStartPlayback();
  });

  it('refreshed metadata for the current track updates the display and leaves the audio alone', () => {
    const renamed = { ...A, title: 'Renamed' };
    fakes.bridge.emit('playback:stateChanged', { reason: 'library-changed', state: playbackState({ current: renamed, revision: 3 }) });
    expect(state().session?.current?.track.title).toBe('Renamed');
    expect(fakes.audio.srcHistory).toEqual([mediaUrlFor(A)]);
    expect(fakes.audio.paused).toBe(false);
  });

  it('the current track leaving: playback stops, the next track is loaded PAUSED, and the user is told', () => {
    fakes.bridge.emit('playback:stateChanged', { reason: 'track-removed', state: playbackState({ current: B, revision: 3 }) });
    expect(fakes.audio.paused).toBe(true);
    expect(state().engine.playing).toBe(false);
    expect(state().session?.current?.track.id).toBe(B.id);
    expect(fakes.audio.srcHistory).toEqual([mediaUrlFor(A), mediaUrlFor(B)]);
    expect(state().notice).toContain('no longer in your library');
    expect(position()).toBe(0);
  });

  it('the LAST track leaving: the source is unloaded - the UI cannot claim anything is playing', () => {
    fakes.bridge.emit('playback:stateChanged', { reason: 'track-removed', state: playbackState({ revision: 3 }) });
    expect(state().session?.current).toBeUndefined();
    expect(state().engine).toMatchObject({ playing: false, loaded: false, durationMs: undefined });
    expect(fakes.audio.src).toBe('');
    expect(fakes.audio.paused).toBe(true);
    expect(state().notice).toBeDefined();
  });

  it('an older snapshot arriving late is ignored', () => {
    fakes.bridge.emit('playback:stateChanged', { reason: 'library-changed', state: playbackState({ current: { ...A, title: 'Newer' }, revision: 9 }) });
    fakes.bridge.emit('playback:stateChanged', { reason: 'library-changed', state: playbackState({ current: { ...A, title: 'Older' }, revision: 4 }) });
    expect(state().session?.current?.track.title).toBe('Newer');
  });

  it('the notice can be dismissed, and starting a track clears it', async () => {
    fakes.bridge.emit('playback:stateChanged', { reason: 'track-removed', state: playbackState({ current: B, revision: 3 }) });
    state().dismissNotice();
    expect(state().notice).toBeUndefined();
    fakes.bridge.emit('playback:stateChanged', { reason: 'track-removed', state: playbackState({ current: C, revision: 4 }) });
    fakes.backend.state = playbackState({ current: B, revision: 5 });
    await state().playTrack(B.id);
    expect(state().notice).toBeUndefined();
  });
});
