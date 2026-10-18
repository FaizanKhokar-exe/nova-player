import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLibraryStore, type LibraryStoreApi } from './library-store.js';
import { createFakeBridge, discoveringProgress, failure, flush, ID, progress, result, root, scanResult, track, type FakeBridge } from './test-support.js';

let bridge: FakeBridge;
let store: LibraryStoreApi;
let disconnect: (() => void) | undefined;

function setup(initial: Parameters<typeof createFakeBridge>[0] = {}, options: Parameters<typeof createLibraryStore>[1] = { searchDebounceMs: 0 }): void {
  bridge = createFakeBridge(initial);
  store = createLibraryStore(bridge, options);
}
async function connect(): Promise<void> {
  disconnect = store.getState().connect();
  await flush();
}
afterEach(() => {
  disconnect?.();
  disconnect = undefined;
  vi.useRealTimers();
});

describe('initial state and loading', () => {
  beforeEach(() => setup());

  it('starts disconnected and empty, and makes no requests until connected', () => {
    const s = store.getState();
    expect(s.connection).toBe('disconnected');
    expect(s.roots).toEqual([]);
    expect(s.tracks).toEqual([]);
    expect(s.tracksStatus).toBe('idle');
    expect(s.query).toBe('');
    expect(s.search).toMatchObject({ status: 'idle', results: [] });
    expect(s.scan).toMatchObject({ phase: 'idle', progress: undefined, last: undefined });
    expect(s.watcher).toMatchObject({ status: undefined, busy: false });
    expect(bridge.calls).toEqual([]);
    expect(bridge.subscriberCount()).toBe(0);
  });

  it('loads roots, tracks, scan state and watcher status on connect', async () => {
    bridge.backend.roots = [root(1, { trackCount: 2 })];
    bridge.backend.tracks = [track(1), track(2)];
    bridge.backend.watcher = { running: true, roots: [{ rootId: ID(1), path: '/m', state: 'watching' }] };
    const gate = bridge.hold('library:listTracks');
    disconnect = store.getState().connect();
    expect(store.getState()).toMatchObject({ connection: 'loading', tracksStatus: 'loading' });
    gate.release();
    await flush();

    const s = store.getState();
    expect(s.connection).toBe('ready');
    expect(s.roots).toEqual([root(1, { trackCount: 2 })]);
    expect(s.tracks).toHaveLength(2);
    expect(s.tracksStatus).toBe('ready');
    expect(s.watcher.status?.running).toBe(true);
    // Phase 5 adds the summary (the album/artist/genre counts) to the startup load.
    expect(bridge.calls.map((c) => c.channel).sort()).toEqual(['library:getScanState', 'library:getSummary', 'library:getWatcherStatus', 'library:listRoots', 'library:listTracks']);
  });

  it('recovers an in-progress scan and the last result after a reload of the window', async () => {
    bridge.backend.scanState = { active: { scanId: ID(900), startedAtMs: 5, progress: progress({ processed: 4, total: 10 }) }, last: scanResult({ scanId: ID(800) }) };
    await connect();
    expect(store.getState().scan).toMatchObject({ phase: 'running', scanId: ID(900), progress: { processed: 4 }, last: { scanId: ID(800) } });
  });

  it('a section that fails shows its own error while the rest still loads', async () => {
    bridge.on('library:listTracks', () => failure('internal', 'Something went wrong.', 'library:listTracks'));
    bridge.backend.roots = [root(1)];
    await connect();
    const s = store.getState();
    expect(s.connection).toBe('ready');
    expect(s.roots).toHaveLength(1);
    expect(s.tracksStatus).toBe('error');
    expect(s.tracksError).toMatchObject({ code: 'internal', message: 'Something went wrong.' });
  });

  it('is "failed" only when every request failed (the backend is unreachable)', async () => {
    for (const channel of ['listRoots', 'listTracks', 'getScanState', 'getWatcherStatus', 'getSummary']) {
      bridge.on(`library:${channel}`, () => {
        throw new Error('ipc down');
      });
    }
    await connect();
    expect(store.getState().connection).toBe('failed');
    expect(store.getState().connectionError).toMatchObject({ code: 'unavailable' });
    expect(JSON.stringify(store.getState().connectionError)).not.toContain('ipc down');
  });

  it('reload() tries again and recovers', async () => {
    let healthy = false;
    for (const channel of ['listRoots', 'listTracks', 'getScanState', 'getWatcherStatus', 'getSummary']) {
      const original = channel;
      bridge.on(
        `library:${original}`,
        () =>
          healthy
            ? original === 'listTracks'
              ? result({ total: 0, offset: 0, tracks: [] })
              : original === 'listRoots'
                ? result({ roots: [] })
                : original === 'getSummary'
                  ? result({ trackCount: 0, albumCount: 0, artistCount: 0, genreCount: 0 })
                  : result(original === 'getScanState' ? {} : { running: false, roots: [] })
            : failure('internal', 'down'),
      );
    }
    await connect();
    expect(store.getState().connection).toBe('failed');
    healthy = true;
    await store.getState().reload();
    expect(store.getState().connection).toBe('ready');
    expect(store.getState().tracksStatus).toBe('ready');
  });
});

describe('subscription lifecycle (React Strict Mode safe)', () => {
  beforeEach(() => setup());

  it('subscribes to exactly the four library events, once', async () => {
    await connect();
    for (const event of ['library:scanProgress', 'library:scanFinished', 'library:changed', 'library:watcherStatus'] as const) {
      expect(bridge.subscriberCount(event)).toBe(1);
    }
    expect(bridge.subscriberCount()).toBe(4);
  });

  it('mount / unmount / mount leaves 4 subscriptions and loads once', async () => {
    const first = store.getState().connect();
    first(); // Strict Mode's simulated unmount
    const second = store.getState().connect(); // ...and remount
    disconnect = second;
    await flush();
    expect(bridge.subscriberCount()).toBe(4);
    expect(bridge.callsTo('library:listRoots')).toHaveLength(1);
    expect(bridge.callsTo('library:listTracks')).toHaveLength(1);
  });

  it('disconnecting the last connection removes every subscription; double-disconnect is harmless', async () => {
    const off = store.getState().connect();
    const other = store.getState().connect();
    expect(bridge.subscriberCount()).toBe(4); // shared, not doubled
    off();
    off();
    expect(bridge.subscriberCount()).toBe(4); // one connection still holds them
    other();
    expect(bridge.subscriberCount()).toBe(0);
    await flush();
  });

  it('no event is handled after disconnect', async () => {
    await connect();
    disconnect?.();
    disconnect = undefined;
    bridge.emit('library:scanProgress', progress());
    expect(store.getState().scan.progress).toBeUndefined();
  });

  it('reconnecting after a full disconnect subscribes again and reloads', async () => {
    await connect();
    disconnect?.();
    disconnect = undefined;
    await flush();
    store.setState({ connection: 'disconnected' });
    await connect();
    expect(bridge.subscriberCount()).toBe(4);
    expect(bridge.callsTo('library:listRoots')).toHaveLength(2);
  });
});

describe('library roots', () => {
  beforeEach(async () => {
    setup();
    await connect();
  });

  it('addRoot triggers the main-process picker with NO path from the renderer, and shows the new root', async () => {
    bridge.on('library:addRoot', () => result({ outcome: 'added' as const, root: root(1) }));
    const done = store.getState().addRoot();
    expect(store.getState().rootAction.busy).toBe(true);
    await done;
    expect(bridge.callsTo('library:addRoot')).toEqual([undefined]);
    expect(store.getState().roots).toEqual([root(1)]);
    expect(store.getState().rootAction).toEqual({ busy: false, error: undefined });
  });

  it('a cancelled picker changes nothing and is not an error', async () => {
    await store.getState().addRoot();
    expect(store.getState().roots).toEqual([]);
    expect(store.getState().rootAction.error).toBeUndefined();
  });

  it('addRoot failures (duplicate, overlap, ...) surface the backend message and can be dismissed', async () => {
    bridge.on('library:addRoot', () => failure('root-exists', 'That folder is already in the library.', 'library:addRoot'));
    await store.getState().addRoot();
    expect(store.getState().rootAction).toMatchObject({ busy: false, error: { code: 'root-exists', message: 'That folder is already in the library.' } });
    store.getState().dismissRootError();
    expect(store.getState().rootAction.error).toBeUndefined();
  });

  it('ignores a second add while one is in flight', async () => {
    const gate = bridge.hold('library:addRoot');
    const first = store.getState().addRoot();
    await store.getState().addRoot();
    gate.release();
    await first;
    expect(bridge.callsTo('library:addRoot')).toHaveLength(1);
  });

  it('removeRoot removes it from state and sends only the id', async () => {
    bridge.backend.roots = [root(1), root(2)];
    await store.getState().reload();
    await store.getState().removeRoot(ID(1));
    expect(bridge.callsTo('library:removeRoot')).toEqual([{ rootId: ID(1) }]);
    expect(store.getState().roots.map((r) => r.id)).toEqual([ID(2)]);
  });

  it('removeRoot refused by the backend (scan running) keeps the root and shows why', async () => {
    bridge.backend.roots = [root(1)];
    await store.getState().reload();
    bridge.on('library:removeRoot', () => failure('scan-running', 'A scan is running.', 'library:removeRoot'));
    await store.getState().removeRoot(ID(1));
    expect(store.getState().roots).toHaveLength(1);
    expect(store.getState().rootAction.error?.code).toBe('scan-running');
  });
});

describe('scanning', () => {
  beforeEach(async () => {
    setup({ roots: [root(1)] });
    await connect();
  });

  it('start: idle -> starting -> running, calling the backend with no filter', async () => {
    const gate = bridge.hold('library:startScan');
    const started = store.getState().startScan();
    expect(store.getState().scan.phase).toBe('starting');
    gate.release();
    await started;
    expect(store.getState().scan).toMatchObject({ phase: 'running', scanId: ID(900) });
    expect(bridge.callsTo('library:startScan')).toEqual([{}]);
  });

  it('can scan a single root', async () => {
    await store.getState().startScan(ID(1));
    expect(bridge.callsTo('library:startScan')).toEqual([{ rootId: ID(1) }]);
  });

  it('prevents a duplicate scan: no second request while one is starting or running', async () => {
    const gate = bridge.hold('library:startScan');
    const first = store.getState().startScan();
    await store.getState().startScan();
    gate.release();
    await first;
    await store.getState().startScan();
    expect(bridge.callsTo('library:startScan')).toHaveLength(1);
  });

  it('a refused start (no roots / already running) returns to idle with the backend message', async () => {
    bridge.on('library:startScan', () => failure('no-roots', 'There are no library folders to scan. Add a folder first.', 'library:startScan'));
    await store.getState().startScan();
    expect(store.getState().scan).toMatchObject({ phase: 'idle', error: { code: 'no-roots' } });
    store.getState().dismissScanError();
    expect(store.getState().scan.error).toBeUndefined();
  });

  it('progress events update the real backend numbers (nothing is estimated)', async () => {
    await store.getState().startScan();
    bridge.emit('library:scanProgress', discoveringProgress(7));
    expect(store.getState().scan.progress).toMatchObject({ phase: 'discovering', discovered: 7 });
    expect(store.getState().scan.progress?.total).toBeUndefined();
    bridge.emit('library:scanProgress', progress({ phase: 'reading', processed: 3, total: 10, added: 3 }));
    expect(store.getState().scan).toMatchObject({ phase: 'running', progress: { processed: 3, total: 10, added: 3 } });
  });

  it('a progress event alone (e.g. a scan started by something else) puts the UI in running', () => {
    bridge.emit('library:scanProgress', progress());
    expect(store.getState().scan).toMatchObject({ phase: 'running', scanId: ID(900) });
  });

  it('events that overtake the start reply are not overwritten by it', async () => {
    const gate = bridge.hold('library:startScan');
    const started = store.getState().startScan();
    bridge.emit('library:scanFinished', scanResult());
    gate.release();
    await started;
    expect(store.getState().scan).toMatchObject({ phase: 'idle', last: { status: 'completed' } });
  });

  it('completion: back to idle, progress cleared, the result kept', async () => {
    await store.getState().startScan();
    bridge.emit('library:scanProgress', progress({ processed: 3 }));
    bridge.emit('library:scanFinished', scanResult());
    expect(store.getState().scan).toMatchObject({ phase: 'idle', progress: undefined, scanId: undefined, last: { status: 'completed' } });
  });

  it('failure is reported from the backend result, including per-root errors', async () => {
    await store.getState().startScan();
    bridge.emit(
      'library:scanFinished',
      scanResult({ status: 'failed', roots: [{ rootId: ID(1), rootPath: '/m', status: 'failed', failureCount: 0, failures: [], counts: { discovered: 0, skipped: 0, added: 0, updated: 0, removed: 0, failed: 0, possibleDuplicates: 0 }, error: { code: 'root-unavailable', message: 'gone' } }] }),
    );
    expect(store.getState().scan.last).toMatchObject({ status: 'failed', roots: [{ error: { code: 'root-unavailable' } }] });
    expect(store.getState().scan.phase).toBe('idle');
  });

  it('cancel: running -> cancelling, then the backend\'s "cancelled" result ends it', async () => {
    await store.getState().startScan();
    const gate = bridge.hold('library:cancelScan');
    const cancelling = store.getState().cancelScan();
    expect(store.getState().scan.phase).toBe('cancelling');
    bridge.emit('library:scanProgress', progress({ processed: 5 })); // still arriving
    expect(store.getState().scan.phase).toBe('cancelling');
    gate.release();
    await cancelling;
    bridge.emit('library:scanFinished', scanResult({ status: 'cancelled' }));
    expect(store.getState().scan).toMatchObject({ phase: 'idle', last: { status: 'cancelled' } });
  });

  it('cancel does nothing when no scan is running', async () => {
    await store.getState().cancelScan();
    expect(bridge.callsTo('library:cancelScan')).toEqual([]);
  });

  it('cancel that fails goes back to running and shows the error', async () => {
    await store.getState().startScan();
    bridge.on('library:cancelScan', () => failure('internal', 'Something went wrong.', 'library:cancelScan'));
    await store.getState().cancelScan();
    expect(store.getState().scan).toMatchObject({ phase: 'running', error: { code: 'internal' } });
  });

  it('cancel when main says nothing was running resyncs from the backend', async () => {
    await store.getState().startScan();
    bridge.on('library:cancelScan', () => result({ cancelled: false }));
    bridge.backend.scanState = { last: scanResult() };
    await store.getState().cancelScan();
    expect(store.getState().scan).toMatchObject({ phase: 'idle', last: { status: 'completed' } });
  });
});

describe('watcher', () => {
  beforeEach(async () => {
    setup({ roots: [root(1)] });
    await connect();
  });

  it('start and stop update the status from the backend reply', async () => {
    bridge.on('library:startWatching', () => result({ running: true, roots: [{ rootId: ID(1), path: '/m', state: 'watching' as const }] }));
    await store.getState().startWatching();
    expect(store.getState().watcher).toMatchObject({ busy: false, error: undefined, status: { running: true, roots: [{ state: 'watching' }] } });
    await store.getState().stopWatching();
    expect(store.getState().watcher.status?.running).toBe(false);
  });

  it('the library:watcherStatus event updates the status', () => {
    bridge.emit('library:watcherStatus', { running: true, roots: [{ rootId: ID(1), path: '/m', state: 'unavailable' }], lastError: { atMs: 1, message: 'folder went away' } });
    expect(store.getState().watcher.status).toMatchObject({ running: true, roots: [{ state: 'unavailable' }], lastError: { message: 'folder went away' } });
  });

  it('errors are surfaced and the previous status is kept', async () => {
    await store.getState().startWatching();
    bridge.on('library:stopWatching', () => failure('internal', 'Something went wrong.', 'library:stopWatching'));
    await store.getState().stopWatching();
    expect(store.getState().watcher).toMatchObject({ busy: false, error: { code: 'internal' }, status: { running: true } });
    store.getState().dismissWatcherError();
    expect(store.getState().watcher.error).toBeUndefined();
  });

  it('ignores a second start while one is in flight', async () => {
    const gate = bridge.hold('library:startWatching');
    const first = store.getState().startWatching();
    await store.getState().startWatching();
    gate.release();
    await first;
    expect(bridge.callsTo('library:startWatching')).toHaveLength(1);
  });
});

describe('search', () => {
  const hit = (n: number) => ({ track: track(n, { title: `Hello ${n}` }), match: { kind: 'field' as const, field: 'title' as const, quality: 'prefix' as const } });

  beforeEach(async () => {
    setup({ tracks: [track(1), track(2)] });
    bridge.backend.search = (q) => (q.toLowerCase().includes('hello') ? [hit(1), hit(2)] : []);
    await connect();
  });

  it('sends the typed query (and a limit) to the backend and stores the backend results', async () => {
    store.getState().setQuery('hello');
    await flush();
    expect(bridge.callsTo('library:search')).toEqual([{ query: 'hello', limit: 500 }]);
    expect(store.getState().search).toMatchObject({ status: 'ready', query: 'hello', total: 2 });
    expect(store.getState().search.results.map((r) => r.track.title)).toEqual(['Hello 1', 'Hello 2']);
  });

  it('no results is a normal ready state with an empty list', async () => {
    store.getState().setQuery('zzz');
    await flush();
    expect(store.getState().search).toMatchObject({ status: 'ready', total: 0, results: [] });
  });

  it('shows loading while the backend works', async () => {
    const gate = bridge.hold('library:search');
    store.getState().setQuery('hello');
    await flush();
    expect(store.getState().search.status).toBe('loading');
    gate.release();
    await flush();
    expect(store.getState().search.status).toBe('ready');
  });

  it('a failed search is an error state, not stale results', async () => {
    store.getState().setQuery('hello');
    await flush();
    bridge.on('library:search', () => failure('invalid-request', 'Bad query.', 'library:search'));
    store.getState().setQuery('hello!');
    await flush();
    expect(store.getState().search).toMatchObject({ status: 'error', results: [], error: { code: 'invalid-request' } });
  });

  it('a bridge rejection during search is reported as unavailable', async () => {
    bridge.on('library:search', () => {
      throw new Error('boom');
    });
    store.getState().setQuery('hello');
    await flush();
    expect(store.getState().search.error).toMatchObject({ code: 'unavailable' });
  });

  it('an empty or blank query clears the search without calling the backend', async () => {
    store.getState().setQuery('hello');
    await flush();
    store.getState().setQuery('   ');
    await flush();
    expect(store.getState().search).toMatchObject({ status: 'idle', results: [] });
    expect(bridge.callsTo('library:search')).toHaveLength(1);
    expect(store.getState().query).toBe('   ');
  });

  it('a slow older response never overwrites a newer one', async () => {
    const slow = bridge.hold('library:search');
    store.getState().setQuery('hello');
    await flush(); // first search is now waiting on the gate
    bridge.on('library:search', (r) => result({ query: (r as { query: string }).query, total: 1, results: [hit(9)] }));
    store.getState().setQuery('hello again');
    await flush();
    slow.release();
    await flush();
    expect(store.getState().search.query).toBe('hello again');
    expect(store.getState().search.results[0]?.track.title).toBe('Hello 9');
  });

  it('clearing the box while a search is in flight discards its result', async () => {
    const gate = bridge.hold('library:search');
    store.getState().setQuery('hello');
    await flush();
    store.getState().setQuery('');
    gate.release();
    await flush();
    expect(store.getState().search).toMatchObject({ status: 'idle', results: [] });
  });

  it('is debounced: only the last keystroke in a burst searches', async () => {
    vi.useFakeTimers();
    setup({ tracks: [track(1)] }, { searchDebounceMs: 200 });
    bridge.backend.search = () => [hit(1)];
    disconnect = store.getState().connect();
    await vi.advanceTimersByTimeAsync(0);
    for (const q of ['h', 'he', 'hel', 'hell', 'hello']) {
      store.getState().setQuery(q);
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(bridge.callsTo('library:search')).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(bridge.callsTo('library:search')).toEqual([{ query: 'hello', limit: 500 }]);
  });
});

describe('library:changed refresh', () => {
  beforeEach(async () => {
    setup({ roots: [root(1)], tracks: [track(1)] });
    await connect();
  });

  it('re-reads roots and tracks (keeping the list on screen, no loading flash)', async () => {
    bridge.backend.roots = [root(1, { trackCount: 2 })];
    bridge.backend.tracks = [track(1), track(2)];
    const states: string[] = [];
    const unsubscribe = store.subscribe((s) => states.push(s.tracksStatus));
    bridge.emit('library:changed', { reason: 'scan' });
    await flush();
    unsubscribe();
    expect(store.getState().tracks).toHaveLength(2);
    expect(store.getState().roots[0]?.trackCount).toBe(2);
    expect(states).not.toContain('loading');
  });

  it('also refreshes an active search so results never go stale', async () => {
    bridge.backend.search = (q) => (q === 'song' ? bridge.backend.tracks.map((t) => ({ track: t, match: { kind: 'words' as const } })) : []);
    store.getState().setQuery('song');
    await flush();
    expect(store.getState().search.total).toBe(1);
    bridge.backend.tracks = [track(1), track(2), track(3)];
    bridge.emit('library:changed', { reason: 'watcher' });
    await flush();
    expect(store.getState().search.total).toBe(3);
  });

  it('a burst of change events is coalesced: at most one refresh in flight plus one follow-up', async () => {
    const gate = bridge.hold('library:listTracks');
    for (let i = 0; i < 10; i += 1) bridge.emit('library:changed', { reason: 'watcher' });
    await flush();
    gate.release();
    await flush();
    await flush();
    expect(bridge.callsTo('library:listTracks').length).toBeLessThanOrEqual(3); // initial load + <= 2 refreshes, never 10
  });

  it('a failed refresh keeps the last good tracks but records the error', async () => {
    bridge.on('library:listTracks', () => failure('internal', 'Something went wrong.', 'library:listTracks'));
    bridge.emit('library:changed', { reason: 'scan' });
    await flush();
    expect(store.getState().tracks).toHaveLength(1);
    expect(store.getState().tracksStatus).toBe('error');
  });
});

describe('security-relevant behaviour of the renderer state', () => {
  it('never sends a filesystem path to the backend for any action', async () => {
    setup({ roots: [root(1)], tracks: [track(1)] });
    bridge.on('library:addRoot', () => result({ outcome: 'added' as const, root: root(2) }));
    await connect();
    await store.getState().addRoot();
    await store.getState().removeRoot(ID(1));
    await store.getState().startScan();
    await store.getState().cancelScan();
    await store.getState().startWatching();
    await store.getState().stopWatching();
    store.getState().setQuery('abc');
    await flush();
    const sent = JSON.stringify(bridge.calls.map((c) => c.request ?? null));
    expect(sent).not.toMatch(/\/music|[A-Za-z]:\\|path/);
  });
});
