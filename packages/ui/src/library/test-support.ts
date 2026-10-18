import type {
  IpcEventChannel,
  IpcEventPayload,
  IpcResult,
  NovaBridge,
  RootDto,
  ScanProgressDto,
  ScanResultDto,
  ScanStateDto,
  GroupDto,
  GroupKindDto,
  SearchResultDto,
  TrackDto,
  WatcherStatusDto,
} from '@nova/shared';

/* Test-only helpers: a scripted stand-in for `window.nova` and DTO builders.
 * Nothing here is imported by application code. */

export const ID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export function root(n: number, overrides: Partial<RootDto> = {}): RootDto {
  return { id: ID(n), path: `/music/folder-${n}`, addedAtMs: n, available: true, trackCount: 0, watched: false, ...overrides };
}

export function track(n: number, overrides: Partial<TrackDto> = {}): TrackDto {
  return { id: ID(1000 + n), title: `Song ${n}`, artist: `Artist ${n}`, artwork: 'none', ...overrides };
}

export function progress(overrides: Partial<ScanProgressDto> = {}): ScanProgressDto {
  return {
    scanId: ID(900), rootId: ID(1), rootIndex: 0, rootCount: 1, phase: 'reading', processed: 0, total: 10,
    discovered: 10, skipped: 0, added: 0, updated: 0, removed: 0, failed: 0, possibleDuplicates: 0, ...overrides,
  };
}

/** Progress during discovery: the backend has not told us a total yet (the key is absent). */
export function discoveringProgress(discovered: number): ScanProgressDto {
  const { total: _total, ...rest } = progress();
  void _total;
  return { ...rest, phase: 'discovering', processed: 0, discovered };
}

export function scanResult(overrides: Partial<ScanResultDto> = {}): ScanResultDto {
  return {
    scanId: ID(900), status: 'completed', startedAtMs: 1, finishedAtMs: 2,
    roots: [{
      rootId: ID(1), rootPath: '/music/folder-1', status: 'completed', failureCount: 0, failures: [],
      counts: { discovered: 3, skipped: 0, added: 3, updated: 0, removed: 0, failed: 0, possibleDuplicates: 0 },
    }],
    ...overrides,
  };
}

/** A naive stand-in for main's sort (the real one is tested in the domain): enough to prove the UI shows main's answer. */
export function compareTracksBy(sort: { field: string; direction: string } | undefined): (a: TrackDto, b: TrackDto) => number {
  const field = sort?.field ?? 'title';
  const dir = sort?.direction === 'desc' ? -1 : 1;
  const key = (t: TrackDto): string | number | undefined => {
    switch (field) {
      case 'artist': return t.artist.toLowerCase();
      case 'album': return t.album?.toLowerCase();
      case 'albumArtist': return t.albumArtist?.toLowerCase();
      case 'genre': return t.genre?.toLowerCase();
      case 'year': return t.year;
      case 'duration': return t.durationSeconds;
      default: return t.title.toLowerCase();
    }
  };
  return (a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka === undefined || kb === undefined) return ka === kb ? 0 : ka === undefined ? 1 : -1; // missing is always last
    return ka < kb ? -dir : ka > kb ? dir : 0;
  };
}

/** A simple stand-in for main's grouping (UI tests treat group keys as opaque): groups by the plain field value. */
export function fakeGroups(tracks: readonly TrackDto[], kind: GroupKindDto): GroupDto[] {
  const buckets = new Map<string, TrackDto[]>();
  for (const t of tracks) {
    const name = kind === 'album' ? t.album : kind === 'artist' ? (t.albumArtist ?? t.artist) : t.genre;
    const key = name ?? '(unknown)';
    buckets.set(key, [...(buckets.get(key) ?? []), t]);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => (a === '(unknown)' ? 1 : b === '(unknown)' ? -1 : a < b ? -1 : a > b ? 1 : 0))
    .map(([key, members]) => ({
      kind,
      key,
      name: key === '(unknown)' ? `Unknown ${kind[0]!.toUpperCase()}${kind.slice(1)}` : key,
      unknown: key === '(unknown)',
      trackCount: members.length,
      ...(members.some((m) => m.durationSeconds !== undefined) && { durationSeconds: members.reduce((sum, m) => sum + (m.durationSeconds ?? 0), 0) }),
      ...(kind === 'album' && members.some((m) => m.year !== undefined) && { year: Math.min(...members.flatMap((m) => (m.year === undefined ? [] : [m.year]))) }),
      ...(kind === 'album' && { artist: members[0]!.artist }),
      ...(kind === 'artist' && { albumCount: new Set(members.map((m) => m.album)).size }),
    }));
}

export function fakeGroupMembers(tracks: readonly TrackDto[], kind: GroupKindDto, key: string): TrackDto[] {
  return tracks.filter((t) => {
    const name = kind === 'album' ? t.album : kind === 'artist' ? (t.albumArtist ?? t.artist) : t.genre;
    return (name ?? '(unknown)') === key;
  });
}

export const IDLE_WATCHER: WatcherStatusDto = { running: false, roots: [] };

export function result<T>(value: T): IpcResult<T> {
  return { ok: true, value };
}
export function failure(code: string, message: string, operation = 'test'): IpcResult<never> {
  return { ok: false, error: { code: code as never, message, operation } };
}

/** What the fake "main process" currently holds. Handlers read it live. */
export interface FakeBackend {
  roots: RootDto[];
  tracks: TrackDto[];
  scanState: ScanStateDto;
  watcher: WatcherStatusDto;
  /** Answer for `library:search`; receives the query. */
  search: (query: string) => SearchResultDto[];
}

type Handler = (request: unknown) => unknown;

export interface FakeBridge extends NovaBridge {
  readonly backend: FakeBackend;
  /** Every invoke, in order. */
  readonly calls: { channel: string; request: unknown }[];
  callsTo(channel: string): unknown[];
  /** Replace one channel's behaviour (return a value, a Promise, or throw/reject). */
  on(channel: string, handler: Handler): void;
  /** Emit a main -> renderer event to every current subscriber. */
  emit<E extends IpcEventChannel>(event: E, payload: IpcEventPayload<E>): void;
  /** Currently subscribed listeners for one event (a leak detector). */
  subscriberCount(event?: IpcEventChannel): number;
  /** Holds a channel's next reply until `release` is called. */
  hold(channel: string): { release(): void };
}

export function createFakeBridge(initial: Partial<FakeBackend> = {}): FakeBridge {
  const backend: FakeBackend = {
    roots: [],
    tracks: [],
    scanState: {},
    watcher: IDLE_WATCHER,
    search: () => [],
    ...initial,
  };
  const calls: { channel: string; request: unknown }[] = [];
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const overrides = new Map<string, Handler>();
  const holds = new Map<string, Promise<void>>();

  const defaults: Record<string, Handler> = {
    'library:listRoots': () => result({ roots: backend.roots }),
    'library:addRoot': () => result({ outcome: 'cancelled' as const }),
    'library:removeRoot': (r) => {
      const id = (r as { rootId: string }).rootId;
      backend.roots = backend.roots.filter((x) => x.id !== id);
      return result({ removedTracks: 0 });
    },
    'library:startScan': () => result({ scanId: ID(900), rootCount: Math.max(backend.roots.length, 1) }),
    'library:cancelScan': () => result({ cancelled: true }),
    'library:getScanState': () => result(backend.scanState),
    'library:listTracks': (r) => {
      const sort = (r as { sort?: { field: string; direction: string } } | undefined)?.sort;
      const tracks = sort === undefined ? backend.tracks : [...backend.tracks].sort(compareTracksBy(sort));
      return result({ total: backend.tracks.length, offset: 0, tracks });
    },
    'library:search': (r) => {
      const query = (r as { query: string }).query;
      const results = backend.search(query);
      return result({ query, total: results.length, results });
    },
    'library:getSummary': () =>
      result({
        trackCount: backend.tracks.length,
        albumCount: fakeGroups(backend.tracks, 'album').length,
        artistCount: fakeGroups(backend.tracks, 'artist').length,
        genreCount: fakeGroups(backend.tracks, 'genre').length,
      }),
    'library:listGroups': (r) => {
      const kind = (r as { kind: GroupKindDto }).kind;
      return result({ kind, groups: fakeGroups(backend.tracks, kind) });
    },
    'library:getGroup': (r) => {
      const { kind, key, sort } = r as { kind: GroupKindDto; key: string; sort?: { field: string; direction: string } };
      const group = fakeGroups(backend.tracks, kind).find((g) => g.key === key);
      if (group === undefined) return failure('group-not-found', 'That album, artist or genre is no longer in the library.', 'library:getGroup');
      const members = backend.tracks.filter((t) => {
        const name = kind === 'album' ? t.album : kind === 'artist' ? (t.albumArtist ?? t.artist) : t.genre;
        return (name ?? '(unknown)') === key;
      });
      return result({ group, tracks: sort === undefined ? members : [...members].sort(compareTracksBy(sort)) });
    },
    'library:startWatching': () => result((backend.watcher = { running: true, roots: [] })),
    'library:stopWatching': () => result((backend.watcher = { running: false, roots: [] })),
    'library:getWatcherStatus': () => result(backend.watcher),
  };

  return {
    backend,
    calls,
    callsTo: (channel) => calls.filter((c) => c.channel === channel).map((c) => c.request),
    on: (channel, handler) => void overrides.set(channel, handler),
    hold(channel) {
      let release!: () => void;
      holds.set(channel, new Promise<void>((resolve) => (release = resolve)));
      return { release: () => { release(); holds.delete(channel); } };
    },
    async invoke(channel: string, request: unknown) {
      calls.push({ channel, request });
      const gate = holds.get(channel);
      if (gate) await gate;
      const handler = overrides.get(channel) ?? defaults[channel];
      if (!handler) throw new Error(`fake bridge: no handler for ${channel}`);
      return handler(request);
    },
    subscribe(event, listener) {
      const set = listeners.get(event) ?? new Set();
      set.add(listener as (payload: unknown) => void);
      listeners.set(event, set);
      return () => void set.delete(listener as (payload: unknown) => void);
    },
    emit(event, payload) {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(payload);
    },
    subscriberCount: (event) =>
      event === undefined ? [...listeners.values()].reduce((n, s) => n + s.size, 0) : (listeners.get(event)?.size ?? 0),
  } as FakeBridge;
}

/** Lets pending promise callbacks run. */
export const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
