import type { PlaybackApplicationEvent } from '@nova/infrastructure';
import { describe, expect, it, vi } from 'vitest';
import { createTrackNotifier, describeTrack, type NotificationPort } from './track-notifier.js';

type Listener = (event: PlaybackApplicationEvent) => void;

interface FakeTrack {
  id: string;
  title: string;
  artist: string;
  album?: string | undefined;
  filePath?: string;
}

const started = (track: FakeTrack | undefined): PlaybackApplicationEvent =>
  ({ type: 'track-started', state: { current: track === undefined ? undefined : { track, mediaUrl: 'nova-media://track/x' } } }) as unknown as PlaybackApplicationEvent;
const stateChanged = (track: FakeTrack): PlaybackApplicationEvent =>
  ({ type: 'state-changed', reason: 'library-changed', state: { current: { track, mediaUrl: 'x' } } }) as unknown as PlaybackApplicationEvent;

const A: FakeTrack = { id: 'a', title: 'Alpha', artist: 'Test Artist', album: 'First Album' };
const B: FakeTrack = { id: 'b', title: 'Bravo', artist: 'Test Artist', album: undefined };

function setup(options: { supported?: boolean; notify?: boolean; showThrows?: boolean } = {}) {
  const listeners = new Set<Listener>();
  const subscribe = vi.fn((listener: Listener) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  });
  const shown: Array<{ title: string; body: string }> = [];
  const clicks: Array<() => void> = [];
  const state = { supported: options.supported ?? true, notify: options.notify ?? true, showThrows: options.showThrows ?? false };
  const port: NotificationPort = {
    isSupported: () => state.supported,
    show: (content, onClick) => {
      if (state.showThrows) throw new Error('the OS refused');
      shown.push({ ...content });
      clicks.push(onClick);
    },
  };
  const onClick = vi.fn();
  const log = vi.fn();
  const notifier = createTrackNotifier({ subscribe, port, shouldNotify: () => state.notify, onClick, log });
  const emit = (event: PlaybackApplicationEvent): void => {
    for (const listener of [...listeners]) listener(event);
  };
  return { notifier, emit, shown, clicks, state, subscribe, listeners, onClick, log };
}

describe('describeTrack', () => {
  it('title, and "artist — album" as the body', () => {
    expect(describeTrack(A)).toEqual({ title: 'Alpha', body: 'Test Artist — First Album' });
  });

  it('missing album: just the artist; missing everything: "Unknown title" and an empty body', () => {
    expect(describeTrack(B)).toEqual({ title: 'Bravo', body: 'Test Artist' });
    expect(describeTrack({ title: '', artist: '', album: undefined })).toEqual({ title: 'Unknown title', body: '' });
    expect(describeTrack({})).toEqual({ title: 'Unknown title', body: '' });
    expect(describeTrack({ title: '   ', artist: undefined, album: 'Only Album' })).toEqual({ title: 'Unknown title', body: 'Only Album' });
  });

  it('control characters and line breaks in tags (untrusted) are flattened; long text is truncated', () => {
    expect(describeTrack({ title: 'Line1\nLine2\u0000\tEnd', artist: 'A\r\nB' }).title).toBe('Line1 Line2 End');
    expect(describeTrack({ title: 'x'.repeat(500), artist: 'y' }).title.length).toBeLessThanOrEqual(100);
    expect(describeTrack({ title: 't', artist: 'y'.repeat(900), album: 'z'.repeat(900) }).body.length).toBeLessThanOrEqual(200);
  });
});

describe('track notifier: when it shows', () => {
  it('shows one notification for a started track, with its title and artist - and nothing else about it', () => {
    const { notifier, emit, shown } = setup();
    notifier.start();
    emit(started({ ...A, filePath: '/home/me/Music/secret/Alpha.mp3' }));
    expect(shown).toEqual([{ title: 'Alpha', body: 'Test Artist — First Album' }]);
    expect(JSON.stringify(shown)).not.toMatch(/home|Music|secret|\.mp3|nova-media/);
    expect(notifier.history()).toEqual([{ content: shown[0], outcome: 'shown' }]);
  });

  it('is silent for every other event: state-changed, a started event with no current track', () => {
    const { notifier, emit, shown } = setup();
    notifier.start();
    emit(stateChanged(A));
    emit(started(undefined));
    expect(shown).toEqual([]);
  });

  it('announces each new track, in order', () => {
    const { notifier, emit, shown } = setup();
    notifier.start();
    emit(started(A));
    emit(started(B));
    emit(started(A));
    expect(shown.map((n) => n.title)).toEqual(['Alpha', 'Bravo', 'Alpha']);
  });

  it('while the window has focus nothing is shown - and the track is announced later once the window is not focused', () => {
    const { notifier, emit, shown, state } = setup({ notify: false });
    notifier.start();
    emit(started(A));
    expect(shown).toEqual([]);
    state.notify = true;
    emit(started(A));
    expect(shown.map((n) => n.title)).toEqual(['Alpha']);
  });
});

describe('track notifier: duplicate prevention', () => {
  it('the same track repeated back-to-back (repeated events, a one-track repeat-all loop) is announced once', () => {
    const { notifier, emit, shown } = setup();
    notifier.start();
    emit(started(A));
    emit(started(A));
    emit(started(A));
    expect(shown).toHaveLength(1);
  });

  it('start() subscribes exactly once however often it is called (no stacked subscriptions)', () => {
    const { notifier, emit, shown, subscribe, listeners } = setup();
    notifier.start();
    notifier.start();
    notifier.start();
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(1);
    emit(started(A));
    expect(shown).toHaveLength(1);
  });

  it('window restoration does not matter: only playback events notify (nothing here reads the window)', () => {
    const { notifier, shown, state } = setup();
    notifier.start();
    state.notify = true; // a window being shown / restored / hidden changes only this flag, never the event stream
    state.notify = false;
    state.notify = true;
    expect(shown).toEqual([]);
  });

  it('dispose() unsubscribes, is idempotent, and nothing is shown afterwards or after a late start()', () => {
    const { notifier, emit, shown, listeners } = setup();
    notifier.start();
    notifier.dispose();
    notifier.dispose();
    expect(listeners.size).toBe(0);
    emit(started(A));
    notifier.start();
    expect(listeners.size).toBe(0);
    expect(shown).toEqual([]);
  });
});

describe('track notifier: unsupported environments and failures', () => {
  it('an environment without notifications shows nothing, throws nothing, and logs nothing noisy', () => {
    const { notifier, emit, shown, log } = setup({ supported: false });
    notifier.start();
    expect(() => emit(started(A))).not.toThrow();
    expect(shown).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });

  it('support appearing later is honoured (the track was not marked as announced)', () => {
    const { notifier, emit, shown, state } = setup({ supported: false });
    notifier.start();
    emit(started(A));
    state.supported = true;
    emit(started(A));
    expect(shown).toHaveLength(1);
  });

  it('a notification the OS refuses is contained and logged, recorded as failed, and the next track still works', () => {
    const { notifier, emit, shown, state, log } = setup({ showThrows: true });
    notifier.start();
    expect(() => emit(started(A))).not.toThrow();
    expect(log).toHaveBeenCalledTimes(1);
    expect(notifier.history()).toEqual([{ content: { title: 'Alpha', body: 'Test Artist — First Album' }, outcome: 'failed' }]);
    state.showThrows = false;
    emit(started(A)); // not marked as announced: it can be retried
    emit(started(B));
    expect(shown.map((n) => n.title)).toEqual(['Alpha', 'Bravo']);
  });

  it('a focus check that throws is contained and logged', () => {
    const listeners: Listener[] = [];
    const log = vi.fn();
    const notifier = createTrackNotifier({
      subscribe: (l) => { listeners.push(l); return () => undefined; },
      port: { isSupported: () => true, show: vi.fn() },
      shouldNotify: () => { throw new Error('window gone'); },
      onClick: vi.fn(),
      log,
    });
    notifier.start();
    expect(() => listeners[0]!(started(A))).not.toThrow();
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('clicking the notification calls the click handler (bring the window forward)', () => {
    const { notifier, emit, clicks, onClick } = setup();
    notifier.start();
    emit(started(A));
    clicks[0]!();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('history is bounded to the 20 most recent notifications', () => {
    const { notifier, emit } = setup();
    notifier.start();
    for (let i = 0; i < 30; i += 1) emit(started({ id: `t${i}`, title: `T${i}`, artist: 'x' }));
    expect(notifier.history()).toHaveLength(20);
    expect(notifier.history()[0]!.content.title).toBe('T10');
  });
});
