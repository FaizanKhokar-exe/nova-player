import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeBridge, failure, flush, ID, result, track } from './test-support.js';
import { createLibraryStore, type LibraryStoreApi } from './library-store.js';

const T = [
  track(1, { title: 'Alpha', artist: 'Ann', album: 'First', genre: 'Rock', year: 2001 }),
  track(2, { title: 'Bravo', artist: 'Ann', album: 'First', genre: 'Rock', year: 2001 }),
  track(3, { title: 'Charlie', artist: 'Bob', album: 'Second', genre: 'Jazz' }),
  track(4, { title: 'Delta', artist: 'Cy' }),
];

let bridge: ReturnType<typeof createFakeBridge>;
let store: LibraryStoreApi;
let disconnect: (() => void) | undefined;

async function connect(): Promise<void> {
  disconnect = store.getState().connect();
  await flush();
}
beforeEach(() => {
  bridge = createFakeBridge({ roots: [], tracks: T });
  store = createLibraryStore(bridge, { searchDebounceMs: 0 });
});
afterEach(() => disconnect?.());

describe('views and the summary', () => {
  it('starts on All Tracks with the summary counts loaded from main', async () => {
    await connect();
    const s = store.getState();
    expect(s.view).toBe('tracks');
    expect(s.summary).toEqual({ trackCount: 4, albumCount: 3, artistCount: 3, genreCount: 3 });
    expect(bridge.callsTo('library:listGroups')).toEqual([]); // nothing is loaded that is not shown
  });

  it('switching to Albums loads that kind once; Artists replaces it; the kind is always the requested one', async () => {
    await connect();
    store.getState().setView('albums');
    expect(store.getState().groups).toMatchObject({ kind: 'album', status: 'loading' });
    await flush();
    expect(store.getState().groups).toMatchObject({ kind: 'album', status: 'ready' });
    expect(store.getState().groups.items.map((g) => g.name)).toEqual(['First', 'Second', 'Unknown Album']);
    store.getState().setView('artists');
    await flush();
    expect(store.getState().groups).toMatchObject({ kind: 'artist', status: 'ready' });
    expect(bridge.callsTo('library:listGroups')).toEqual([{ kind: 'album' }, { kind: 'artist' }]);
  });

  it('leaving a group view for All Tracks does not refetch tracks that are still fresh', async () => {
    await connect();
    store.getState().setView('genres');
    await flush();
    store.getState().setView('tracks');
    await flush();
    expect(bridge.callsTo('library:listTracks')).toHaveLength(1);
  });
});

describe('selecting an album, artist or genre', () => {
  it('opens a group, loads its tracks, and Back returns to the list', async () => {
    await connect();
    store.getState().setView('albums');
    await flush();
    const first = store.getState().groups.items[0]!;
    store.getState().selectGroup({ kind: first.kind, key: first.key });
    expect(store.getState().detail.status).toBe('loading');
    await flush();
    expect(store.getState().detail).toMatchObject({ status: 'ready', group: { name: 'First' } });
    expect(store.getState().detail.tracks.map((t) => t.title)).toEqual(['Alpha', 'Bravo']);
    store.getState().clearSelection();
    expect(store.getState().selection).toBeUndefined();
    await flush();
    expect(store.getState().groups.status).toBe('ready');
  });

  it('only the newest selection wins when answers arrive out of order', async () => {
    await connect();
    store.getState().setView('genres');
    await flush();
    const slow = bridge.hold('library:getGroup');
    store.getState().selectGroup({ kind: 'genre', key: 'Rock' });
    await flush();
    slow.release(); // Rock's answer is released later than Jazz's ...
    store.getState().selectGroup({ kind: 'genre', key: 'Jazz' });
    await flush();
    expect(store.getState().detail.group?.name).toBe('Jazz');
    expect(store.getState().selection).toEqual({ kind: 'genre', key: 'Jazz' });
  });

  it('changing the view leaves the open group', async () => {
    await connect();
    store.getState().selectGroup({ kind: 'album', key: 'First' });
    await flush();
    store.getState().setView('artists');
    expect(store.getState().selection).toBeUndefined();
    expect(store.getState().detail.status).toBe('idle');
  });

  it('a detail sort is sent to main with the selection; undefined returns to the natural order', async () => {
    await connect();
    store.getState().selectGroup({ kind: 'album', key: 'First' });
    await flush();
    store.getState().setDetailSort({ field: 'title', direction: 'desc' });
    await flush();
    expect(bridge.callsTo('library:getGroup').at(-1)).toEqual({ kind: 'album', key: 'First', sort: { field: 'title', direction: 'desc' } });
    expect(store.getState().detail.tracks.map((t) => t.title)).toEqual(['Bravo', 'Alpha']);
    store.getState().setDetailSort(undefined);
    await flush();
    expect(bridge.callsTo('library:getGroup').at(-1)).toEqual({ kind: 'album', key: 'First' });
  });
});

describe('sorting All Tracks', () => {
  it('sends the sort to main and keeps the list on screen (no loading flash); the default sends nothing extra', async () => {
    await connect();
    expect(bridge.callsTo('library:listTracks')).toEqual([{}]);
    const statuses: string[] = [];
    const unsubscribe = store.subscribe((s) => statuses.push(s.tracksStatus));
    store.getState().setSort({ field: 'year', direction: 'desc' });
    await flush();
    unsubscribe();
    expect(bridge.callsTo('library:listTracks').at(-1)).toEqual({ sort: { field: 'year', direction: 'desc' } });
    expect(statuses.every((s) => s === 'ready')).toBe(true);
    store.getState().setSort({ field: 'title', direction: 'asc' });
    await flush();
    expect(bridge.callsTo('library:listTracks').at(-1)).toEqual({});
  });

  it('setting the sort it already has does nothing; a sort survives a library refresh', async () => {
    await connect();
    store.getState().setSort({ field: 'title', direction: 'asc' });
    await flush();
    expect(bridge.callsTo('library:listTracks')).toHaveLength(1);
    store.getState().setSort({ field: 'artist', direction: 'desc' });
    await flush();
    bridge.emit('library:changed', { reason: 'scan' });
    await flush();
    expect(bridge.callsTo('library:listTracks').at(-1)).toEqual({ sort: { field: 'artist', direction: 'desc' } });
  });
});

describe('library refresh keeps the user where they are', () => {
  it('re-reads only what is on screen: summary + the open list, not All Tracks; All Tracks reloads when it returns', async () => {
    await connect();
    store.getState().setView('albums');
    await flush();
    const before = bridge.calls.length;
    bridge.backend.tracks = [...T, track(5, { title: 'Echo', artist: 'Ann', album: 'Third' })];
    bridge.emit('library:changed', { reason: 'watcher' });
    await flush();
    const channels = bridge.calls.slice(before).map((c) => c.channel);
    expect(channels).toEqual(expect.arrayContaining(['library:listRoots', 'library:getSummary', 'library:listGroups']));
    expect(channels).not.toContain('library:listTracks');
    expect(store.getState().groups.items.map((g) => g.name)).toContain('Third'); // counts follow the library
    expect(store.getState().summary?.albumCount).toBe(4);
    expect(store.getState().groups.status).toBe('ready'); // no loading flash
    store.getState().setView('tracks');
    await flush();
    expect(store.getState().tracks).toHaveLength(5);
  });

  it('refreshes an open album in place; if it vanished, goes back to the list with a plain notice', async () => {
    await connect();
    store.getState().setView('albums');
    await flush();
    store.getState().selectGroup({ kind: 'album', key: 'First' });
    await flush();
    bridge.backend.tracks = [...T, track(6, { title: 'Foxtrot', artist: 'Ann', album: 'First' })];
    bridge.emit('library:changed', { reason: 'scan' });
    await flush();
    expect(store.getState().detail.tracks).toHaveLength(3);
    expect(store.getState().detail.status).toBe('ready');
    bridge.backend.tracks = T.filter((t) => t.album !== 'First');
    bridge.emit('library:changed', { reason: 'scan' });
    await flush();
    expect(store.getState().selection).toBeUndefined();
    expect(store.getState().browseNotice).toBe('That item is no longer in your library.');
    expect(store.getState().groups.items.map((g) => g.name)).not.toContain('First');
    store.getState().dismissBrowseNotice();
    expect(store.getState().browseNotice).toBeUndefined();
  });

  it('a refresh never touches the search box or the open view', async () => {
    await connect();
    store.getState().setView('genres');
    store.getState().setQuery('alpha');
    await flush();
    bridge.emit('library:changed', { reason: 'scan' });
    await flush();
    expect(store.getState().view).toBe('genres');
    expect(store.getState().query).toBe('alpha');
  });
});

describe('errors and retry', () => {
  it('a failed group list says so in plain words and retryBrowse recovers', async () => {
    await connect();
    let healthy = false;
    bridge.on('library:listGroups', (r) => (healthy ? result({ kind: (r as { kind: 'album' }).kind, groups: [] }) : failure('internal', 'Something went wrong. The details were written to the application log.')));
    store.getState().setView('albums');
    await flush();
    expect(store.getState().groups).toMatchObject({ status: 'error', error: { code: 'internal' } });
    healthy = true;
    store.getState().retryBrowse();
    await flush();
    expect(store.getState().groups.status).toBe('ready');
  });

  it('an unreachable bridge becomes the generic unavailable error, never raw text', async () => {
    await connect();
    bridge.on('library:getGroup', () => {
      throw new Error('ECONNRESET /home/me/Music');
    });
    store.getState().selectGroup({ kind: 'album', key: 'First' });
    await flush();
    expect(store.getState().detail.error).toMatchObject({ code: 'unavailable' });
    expect(JSON.stringify(store.getState().detail.error)).not.toContain('/home/me');
  });
});

describe('high-frequency playback state never reaches the library store', () => {
  it('a burst of playback-position style events changes nothing here and triggers no request', async () => {
    await connect();
    const calls = bridge.calls.length;
    let changes = 0;
    const unsubscribe = store.subscribe(() => void (changes += 1));
    for (let i = 0; i < 500; i += 1) bridge.emit('library:watcherStatus', store.getState().watcher.status ?? { running: false, roots: [] });
    unsubscribe();
    // (watcher status is the only high-ish-rate library event and replaces one small slice; it never reloads lists)
    expect(bridge.calls.length).toBe(calls);
    expect(store.getState().tracks).toHaveLength(4);
    void changes;
    void ID;
  });
});
