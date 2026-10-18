import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createLibraryApplication,
  createLibraryServices,
  LibraryApplicationError,
  type LibraryApplication,
  type LibraryApplicationEvent,
  type LibraryServices,
} from '@nova/infrastructure';
import { IPC_INVOKE_CHANNELS, type IpcEventChannel, type IpcEventPayload, type IpcResult } from '@nova/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bridgeApplicationEvents, registerLibraryIpc, type IpcRegistrar, type PublishEvent } from './register-library-ipc.js';

type Handler = (event: unknown, request: unknown) => unknown;
const TRUSTED = { trusted: true };
const UNTRUSTED = { trusted: false };
const ID = '123e4567-e89b-42d3-a456-426614174000';

function fakeRegistrar(): IpcRegistrar & { handlers: Map<string, Handler>; call(channel: string, request?: unknown, event?: unknown): Promise<IpcResult<unknown>> } {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    handle: (channel, listener) => {
      if (handlers.has(channel)) throw new Error(`duplicate registration: ${channel}`);
      handlers.set(channel, listener);
    },
    call: async (channel, request, event = TRUSTED) => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`no handler for ${channel}`);
      return (await handler(event, request)) as IpcResult<unknown>;
    },
  };
}

/** A recording stand-in for the application layer: proves each handler calls
 *  the right service method and nothing else. */
function fakeApplication(overrides: Partial<LibraryApplication> = {}): LibraryApplication & { calls: string[] } {
  const calls: string[] = [];
  const note =
    <T>(name: string, value: T) =>
    (...args: unknown[]): T => {
      calls.push(`${name}(${args.map((a) => JSON.stringify(a)).join(',')})`);
      return value;
    };
  const watcher = { running: false, roots: [], lastReconcile: undefined, lastError: undefined };
  return Object.assign(
    {
      calls,
      listRoots: note('listRoots', Promise.resolve([])),
      addRoot: note('addRoot', Promise.resolve({ id: ID, path: '/m', addedAtMs: 1, available: true, trackCount: 0, watched: false })),
      removeRoot: note('removeRoot', Promise.resolve({ removedTracks: 4 })),
      startScan: note('startScan', { scanId: 'scan-1', rootCount: 1 }),
      cancelScan: note('cancelScan', true),
      getScanState: note('getScanState', { active: undefined, last: undefined }),
      listTracks: note('listTracks', []),
      searchTracks: note('searchTracks', []),
      getSummary: note('getSummary', { trackCount: 3, albumCount: 2, artistCount: 1, genreCount: 1 }),
      listGroups: note('listGroups', []),
      getGroup: note('getGroup', { group: { kind: 'album' as const, key: 'k', name: 'N', unknown: false, trackCount: 0, durationSeconds: undefined, artist: 'A', year: undefined, albumCount: undefined, coverTrackId: undefined }, tracks: [] }),
      startup: note('startup', Promise.resolve({ rootCount: 0, availableRoots: 0, unavailableRoots: 0, watching: false, scanStarted: false })),
      startWatching: note('startWatching', Promise.resolve(watcher)),
      stopWatching: note('stopWatching', Promise.resolve(watcher)),
      getWatcherStatus: note('getWatcherStatus', watcher),
      subscribe: () => () => undefined,
      dispose: () => Promise.resolve(),
    } satisfies LibraryApplication & { calls: string[] },
    overrides,
  );
}

function setup(app: LibraryApplication, extra: { pickFolder?: () => Promise<string | undefined> } = {}) {
  const registrar = fakeRegistrar();
  const logged: unknown[] = [];
  registerLibraryIpc({
    registrar,
    application: app,
    pickFolder: extra.pickFolder ?? (() => Promise.resolve('/chosen')),
    isTrustedSender: (event) => (event as { trusted?: boolean }).trusted === true,
    log: (_m, e) => logged.push(e),
  });
  return { registrar, logged };
}

describe('registration', () => {
  it('registers every library channel in the contract, exactly once, and nothing else', () => {
    const { registrar } = setup(fakeApplication());
    const expected = IPC_INVOKE_CHANNELS.filter((c) => c.startsWith('library:')).sort();
    expect([...registrar.handlers.keys()].sort()).toEqual(expected);
    expect(expected).toHaveLength(14);
  });
});

describe('dispatch: each handler calls exactly the right application service', () => {
  it('library:listRoots', async () => {
    const app = fakeApplication();
    const { registrar } = setup(app);
    expect(await registrar.call('library:listRoots')).toEqual({ ok: true, value: { roots: [] } });
    expect(app.calls).toEqual(['listRoots()']);
  });

  it('library:addRoot shows the picker, then registers the chosen folder', async () => {
    const app = fakeApplication();
    const pickFolder = vi.fn(() => Promise.resolve('/chosen'));
    const { registrar } = setup(app, { pickFolder });
    const result = await registrar.call('library:addRoot');
    expect(pickFolder).toHaveBeenCalledTimes(1);
    expect(app.calls).toEqual(['addRoot("/chosen")']);
    expect(result).toEqual({ ok: true, value: { outcome: 'added', root: { id: ID, path: '/m', addedAtMs: 1, available: true, trackCount: 0, watched: false } } });
  });

  it('library:addRoot: a cancelled picker adds nothing', async () => {
    const app = fakeApplication();
    const { registrar } = setup(app, { pickFolder: () => Promise.resolve(undefined) });
    expect(await registrar.call('library:addRoot')).toEqual({ ok: true, value: { outcome: 'cancelled' } });
    expect(app.calls).toEqual([]);
  });

  it('library:addRoot refuses any argument: the renderer cannot supply a path', async () => {
    const app = fakeApplication();
    const pickFolder = vi.fn(() => Promise.resolve('/chosen'));
    const { registrar } = setup(app, { pickFolder });
    const result = await registrar.call('library:addRoot', { path: 'C:\\Windows' });
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid-request' } });
    expect(pickFolder).not.toHaveBeenCalled();
    expect(app.calls).toEqual([]);
  });

  it('library:removeRoot / startScan / cancelScan / getScanState', async () => {
    const app = fakeApplication();
    const { registrar } = setup(app);
    expect(await registrar.call('library:removeRoot', { rootId: ID })).toEqual({ ok: true, value: { removedTracks: 4 } });
    expect(await registrar.call('library:startScan', undefined)).toEqual({ ok: true, value: { scanId: 'scan-1', rootCount: 1 } });
    expect(await registrar.call('library:startScan', { rootId: ID })).toMatchObject({ ok: true });
    expect(await registrar.call('library:cancelScan')).toEqual({ ok: true, value: { cancelled: true } });
    expect(await registrar.call('library:getScanState')).toEqual({ ok: true, value: {} });
    expect(app.calls).toEqual([`removeRoot("${ID}")`, 'startScan({})', `startScan({"rootId":"${ID}"})`, 'cancelScan()', 'getScanState()']);
  });

  it('library:startWatching / stopWatching / getWatcherStatus', async () => {
    const app = fakeApplication();
    const { registrar } = setup(app);
    for (const channel of ['library:startWatching', 'library:stopWatching', 'library:getWatcherStatus']) {
      expect(await registrar.call(channel)).toEqual({ ok: true, value: { running: false, roots: [] } });
    }
    expect(app.calls).toEqual(['startWatching()', 'stopWatching()', 'getWatcherStatus()']);
  });
});

describe('listing and search go through the application layer and return DTOs', () => {
  let dir: string;
  let services: LibraryServices;
  let real: LibraryApplication;
  const fixtures = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../../tests/fixtures/metadata');

  beforeEach(async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nova-ipc-test-')));
    services = createLibraryServices({ databasePath: path.join(dir, 'nova.db') });
    real = createLibraryApplication({ services, progressIntervalMs: 0, watcher: { debounceMs: 50, reconcileIntervalMs: 0 } });
    const lib = path.join(dir, 'lib');
    fs.mkdirSync(lib);
    for (const [name, fixture] of [['a.mp3', 'full-tags.mp3'], ['b.flac', 'unicode-tags.flac'], ['c.mp3', 'Partial Tags.mp3']] as const) {
      fs.copyFileSync(path.join(fixtures, fixture), path.join(lib, name));
    }
    await real.addRoot(lib);
    let done = false;
    real.subscribe((e) => {
      if (e.type === 'scan-finished') done = true;
    });
    real.startScan();
    while (!done) await new Promise((r) => setTimeout(r, 20));
  });
  afterEach(async () => {
    await real.dispose();
    await services.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('library:listTracks returns serializable TrackDtos with no paths, and pages correctly', async () => {
    const { registrar } = setup(real);
    const all = (await registrar.call('library:listTracks', undefined)) as Extract<IpcResult<{ total: number; offset: number; tracks: { title: string }[] }>, { ok: true }>;
    expect(all.ok).toBe(true);
    expect(all.value).toMatchObject({ total: 3, offset: 0 });
    expect(all.value.tracks.map((t) => t.title)).toEqual(['Full Tags Song', 'Only A Title', '夜に駆ける – Ünïcödé 🎵']);
    expect(JSON.stringify(all)).not.toContain(dir);
    expect(JSON.stringify(all)).not.toContain('sourcePath');
    expect(structuredClone(all)).toEqual(all);

    const page = (await registrar.call('library:listTracks', { offset: 1, limit: 1 })) as typeof all;
    expect(page.value).toMatchObject({ total: 3, offset: 1 });
    expect(page.value.tracks.map((t) => t.title)).toEqual(['Only A Title']);
    const beyond = (await registrar.call('library:listTracks', { offset: 10 })) as typeof all;
    expect(beyond.value).toMatchObject({ total: 3, tracks: [] });
  });

  it('library:search is the domain search, returned as DTOs, with total and limit', async () => {
    const { registrar } = setup(real);
    const found = (await registrar.call('library:search', { query: 'TAGGED' })) as { ok: true; value: { query: string; total: number; results: { track: { title: string }; match: unknown }[] } };
    expect(found.ok).toBe(true);
    expect(found.value.total).toBe(found.value.results.length);
    expect(found.value.results[0]).toMatchObject({ track: { title: 'Full Tags Song' }, match: { kind: 'field' } });

    const empty = (await registrar.call('library:search', { query: '   ' })) as typeof found;
    expect(empty.value).toEqual({ query: '   ', total: 0, results: [] });

    const limited = (await registrar.call('library:search', { query: 'a', limit: 1 })) as typeof found;
    expect(limited.value.results.length).toBeLessThanOrEqual(1);
    expect(limited.value.total).toBeGreaterThanOrEqual(limited.value.results.length);
    expect(JSON.stringify(found)).not.toContain(dir);
  });

  it('library:listRoots reports the real root with its track count', async () => {
    const { registrar } = setup(real);
    const result = (await registrar.call('library:listRoots')) as { ok: true; value: { roots: { path: string; trackCount: number; available: boolean }[] } };
    expect(result.value.roots).toHaveLength(1);
    expect(result.value.roots[0]).toMatchObject({ trackCount: 3, available: true });
  });
});

describe('errors', () => {
  it('application rule violations become coded, serializable errors', async () => {
    const app = fakeApplication({
      startScan: () => {
        throw new LibraryApplicationError('scan-running', 'A scan is already running.');
      },
    });
    const { registrar, logged } = setup(app);
    const result = await registrar.call('library:startScan', {});
    expect(result).toEqual({ ok: false, error: { code: 'scan-running', message: 'A scan is already running.', operation: 'library:startScan' } });
    expect(logged).toEqual([]);
  });

  it('an unexpected failure (even an async one) is generic to the renderer and logged in main', async () => {
    const boom = new Error('SQLITE_IOERR: disk I/O error at /home/me/.config/nova.db');
    const app = fakeApplication({ listRoots: () => Promise.reject(boom) });
    const { registrar, logged } = setup(app);
    const result = await registrar.call('library:listRoots');
    expect(result).toMatchObject({ ok: false, error: { code: 'internal', operation: 'library:listRoots' } });
    expect(JSON.stringify(result)).not.toMatch(/SQLITE|\/home/);
    expect(logged).toEqual([boom]);
  });

  it('every channel returns an IpcResult, never throws, even for garbage input', async () => {
    const { registrar } = setup(fakeApplication());
    for (const channel of registrar.handlers.keys()) {
      for (const garbage of [null, 42, 'x', [], { rootId: {} }, { query: 5 }, { offset: -1 }]) {
        const result = await registrar.call(channel, garbage);
        expect(typeof result.ok).toBe('boolean');
        if (!result.ok) expect(Object.keys(result.error).sort()).toEqual(['code', 'message', 'operation']);
      }
    }
  });
});

describe('sender trust', () => {
  it('every channel refuses an untrusted sender, before validating or calling anything', async () => {
    const app = fakeApplication();
    const pickFolder = vi.fn(() => Promise.resolve('/x'));
    const { registrar } = setup(app, { pickFolder });
    for (const channel of registrar.handlers.keys()) {
      const result = await registrar.call(channel, undefined, UNTRUSTED);
      expect(result).toMatchObject({ ok: false, error: { code: 'forbidden', operation: channel } });
    }
    expect(app.calls).toEqual([]);
    expect(pickFolder).not.toHaveBeenCalled();
  });
});

describe('bridgeApplicationEvents', () => {
  it('forwards each application event as a DTO on its own contract channel', () => {
    let emit!: (event: LibraryApplicationEvent) => void;
    let unsubscribed = false;
    const app = fakeApplication({
      subscribe: (listener) => {
        emit = listener;
        return () => {
          unsubscribed = true;
        };
      },
    });
    const published: { channel: IpcEventChannel; payload: unknown }[] = [];
    const publish: PublishEvent = <E extends IpcEventChannel>(channel: E, payload: IpcEventPayload<E>) => {
      published.push({ channel, payload });
    };
    const off = bridgeApplicationEvents(app, publish);

    const counts = { discovered: 1, skipped: 0, added: 1, updated: 0, removed: 0, failed: 0, possibleDuplicates: 0 };
    emit({ type: 'scan-progress', progress: { scanId: 's', rootId: 'r', rootPath: '/m', rootIndex: 0, rootCount: 1, progress: { ...counts, phase: 'reading', processed: 1, total: 1, currentPath: '/m/a.mp3' } } });
    emit({ type: 'scan-finished', result: { scanId: 's', status: 'completed', startedAtMs: 1, finishedAtMs: 2, roots: [] } });
    emit({ type: 'library-changed', reason: 'scan' });
    emit({ type: 'watcher-status', status: { running: true, roots: [], lastReconcile: undefined, lastError: undefined } });

    expect(published.map((p) => p.channel)).toEqual(['library:scanProgress', 'library:scanFinished', 'library:changed', 'library:watcherStatus']);
    expect(published[0]?.payload).toMatchObject({ scanId: 's', rootId: 'r', phase: 'reading', processed: 1, total: 1 });
    expect(JSON.stringify(published[0]?.payload)).not.toContain('rootPath');
    expect(published[2]?.payload).toEqual({ reason: 'scan' });
    for (const p of published) expect(structuredClone(p.payload)).toEqual(p.payload);
    off();
    expect(unsubscribed).toBe(true);
  });
});


describe('Phase 5 browse channels', () => {
  it('library:listTracks passes a validated sort to the application before paging', async () => {
    const app = fakeApplication();
    const { registrar } = setup(app);
    await registrar.call('library:listTracks', { sort: { field: 'year', direction: 'desc' }, offset: 2, limit: 5 });
    expect(app.calls).toEqual(['listTracks({"field":"year","direction":"desc"})']);
  });

  it('library:listTracks rejects an invalid or oversized sort and unknown keys, calling nothing', async () => {
    const app = fakeApplication();
    const { registrar } = setup(app);
    for (const sort of [{ field: 'path', direction: 'asc' }, { field: 'title', direction: 'up' }, { field: 'title' }, 'title', { field: 'title', direction: 'asc', extra: 1 }, null]) {
      expect(await registrar.call('library:listTracks', { sort })).toMatchObject({ ok: false, error: { code: 'invalid-request' } });
    }
    expect(app.calls).toEqual([]);
  });

  it('library:getSummary maps counts and accepts no arguments', async () => {
    const app = fakeApplication();
    const { registrar } = setup(app);
    expect(await registrar.call('library:getSummary')).toEqual({ ok: true, value: { trackCount: 3, albumCount: 2, artistCount: 1, genreCount: 1 } });
    expect(await registrar.call('library:getSummary', {})).toMatchObject({ ok: false, error: { code: 'invalid-request' } });
  });

  it('library:listGroups validates the kind and maps groups without undefined keys', async () => {
    const group = { kind: 'album' as const, key: 'k', name: 'N', unknown: false, trackCount: 2, durationSeconds: 30, artist: 'A', year: undefined, albumCount: undefined, coverTrackId: undefined };
    const app = fakeApplication({ listGroups: () => [group] });
    const { registrar } = setup(app);
    const result = await registrar.call('library:listGroups', { kind: 'album' });
    expect(result).toEqual({ ok: true, value: { kind: 'album', groups: [{ kind: 'album', key: 'k', name: 'N', unknown: false, trackCount: 2, durationSeconds: 30, artist: 'A' }] } });
    for (const bad of [{ kind: 'playlist' }, {}, { kind: 'album', extra: 1 }, 'album', undefined]) {
      expect(await registrar.call('library:listGroups', bad)).toMatchObject({ ok: false, error: { code: 'invalid-request' } });
    }
  });

  it('library:getGroup validates kind/key/sort and returns a stable group-not-found error', async () => {
    const app = fakeApplication({
      getGroup: () => {
        throw new LibraryApplicationError('group-not-found', 'That album, artist or genre is no longer in the library.');
      },
    });
    const { registrar, logged } = setup(app);
    expect(await registrar.call('library:getGroup', { kind: 'genre', key: 'n:rock' })).toEqual({
      ok: false,
      error: { code: 'group-not-found', message: 'That album, artist or genre is no longer in the library.', operation: 'library:getGroup' },
    });
    expect(logged).toEqual([]);
    for (const bad of [{ kind: 'genre', key: '' }, { kind: 'genre', key: 'x'.repeat(2_001) }, { kind: 'genre', key: 5 }, { kind: 'x', key: 'k' }, { kind: 'genre', key: 'k', sort: { field: 'nope', direction: 'asc' } }, { key: 'k' }]) {
      expect(await registrar.call('library:getGroup', bad)).toMatchObject({ ok: false, error: { code: 'invalid-request' } });
    }
  });

  it('library:getGroup rejects unknown keys (nothing is silently ignored)', async () => {
    const app = fakeApplication();
    const { registrar } = setup(app);
    expect(await registrar.call('library:getGroup', { kind: 'genre', key: 'n:rock', path: '/etc' })).toMatchObject({ ok: false, error: { code: 'invalid-request' } });
    expect(await registrar.call('library:getGroup', { kind: 'genre', key: 'n:rock', sort: { field: 'title', direction: 'asc', x: 1 } })).toMatchObject({ ok: false, error: { code: 'invalid-request' } });
    expect(app.calls).toEqual([]);
  });

  it('refuses the new channels for an untrusted sender', async () => {
    const app = fakeApplication();
    const { registrar } = setup(app);
    for (const channel of ['library:getSummary', 'library:listGroups', 'library:getGroup'] as const) {
      expect(await registrar.call(channel, undefined, UNTRUSTED)).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    }
    expect(app.calls).toEqual([]);
  });
});
