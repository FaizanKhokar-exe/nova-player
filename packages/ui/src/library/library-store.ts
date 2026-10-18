import { createStore, type StoreApi } from 'zustand/vanilla';
import type {
  GroupDto,
  GroupKindDto,
  GroupRefDto,
  IpcErrorCode,
  IpcRequest,
  IpcResponse,
  LibraryIpcContract,
  LibrarySummaryDto,
  NovaBridge,
  RootDto,
  ScanProgressDto,
  ScanResultDto,
  SearchResultDto,
  TrackDto,
  TrackSortDto,
  WatcherStatusDto,
} from '@nova/shared';

/**
 * Renderer state for the library (Phase 3 half 2).
 *
 * The store is a thin, honest mirror of the main process: it calls the typed
 * `library:*` channels, listens to the four library events, and keeps what
 * came back. It contains no business rules - scanning, searching and
 * reconciliation all happen in main; React never estimates progress or
 * re-implements search.
 *
 * It is created by a factory from a `NovaBridge` (so there is no global
 * instance and tests inject a fake bridge) and is one focused store - no
 * playback/queue/lyrics state lives here.
 */

/** What the UI shows when something failed. Either an `IpcError` from main, or
 *  `unavailable` when the bridge itself could not be reached. */
export interface UiError {
  readonly code: IpcErrorCode | 'unavailable';
  readonly message: string;
  readonly operation: string;
}

export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

/** `starting`/`cancelling` are renderer-side moments between a click and
 *  main's answer; the backend's own states are running/finished. */
export type ScanPhase = 'idle' | 'starting' | 'running' | 'cancelling';

export interface ScanSlice {
  readonly phase: ScanPhase;
  readonly scanId: string | undefined;
  /** The latest `library:scanProgress` payload while a scan runs. */
  readonly progress: ScanProgressDto | undefined;
  /** The most recent finished scan (completed, cancelled or failed). */
  readonly last: ScanResultDto | undefined;
  readonly error: UiError | undefined;
}

export interface SearchSlice {
  readonly status: LoadStatus;
  /** The query these results answer. */
  readonly query: string;
  readonly results: readonly SearchResultDto[];
  readonly total: number;
  readonly error: UiError | undefined;
}

/** What the main area shows. Search is not a view: a query replaces the main list wherever you are
 *  (see `TrackList`), and clearing it returns to the view and selection you left. */
export type LibraryView = 'tracks' | 'albums' | 'artists' | 'genres' | 'queue' | 'nowplaying' | 'lyrics' | 'settings';

export const DEFAULT_SORT: TrackSortDto = { field: 'title', direction: 'asc' };

const KIND_OF_VIEW: Readonly<Record<'albums' | 'artists' | 'genres', GroupKindDto>> = { albums: 'album', artists: 'artist', genres: 'genre' };

export function groupKindOfView(view: LibraryView): GroupKindDto | undefined {
  return view === 'albums' || view === 'artists' || view === 'genres' ? KIND_OF_VIEW[view] : undefined;
}

export interface GroupsSlice {
  /** The kind these groups are of (the list is replaced when the view changes). */
  readonly kind: GroupKindDto | undefined;
  readonly status: LoadStatus;
  readonly items: readonly GroupDto[];
  readonly error: UiError | undefined;
}

export interface DetailSlice {
  readonly status: LoadStatus;
  readonly group: GroupDto | undefined;
  readonly tracks: readonly TrackDto[];
  /** `undefined` = the group's natural order (albums: disc/track; artists: album by album). */
  readonly sort: TrackSortDto | undefined;
  readonly error: UiError | undefined;
}

export interface LibraryState {
  /** The first load after `connect()`. */
  readonly connection: 'disconnected' | 'loading' | 'ready' | 'failed';
  readonly connectionError: UiError | undefined;

  readonly roots: readonly RootDto[];
  readonly rootsError: UiError | undefined;
  /** An add/remove is in flight, or the last one failed. */
  readonly rootAction: { readonly busy: boolean; readonly error: UiError | undefined };

  readonly tracks: readonly TrackDto[];
  readonly tracksStatus: LoadStatus;
  readonly tracksError: UiError | undefined;
  /** The order of All Tracks (applied in main, never in React). */
  readonly sort: TrackSortDto;

  readonly view: LibraryView;
  /** Counts of tracks / albums / artists / genres, from main. */
  readonly summary: LibrarySummaryDto | undefined;
  readonly groups: GroupsSlice;
  readonly selection: GroupRefDto | undefined;
  readonly detail: DetailSlice;
  /** A plain remark (e.g. the album you were viewing left the library). */
  readonly browseNotice: string | undefined;

  /** What is typed in the search box (may be ahead of `search.query` while debouncing). */
  readonly query: string;
  readonly search: SearchSlice;

  readonly scan: ScanSlice;
  readonly watcher: {
    readonly status: WatcherStatusDto | undefined;
    readonly busy: boolean;
    readonly error: UiError | undefined;
  };
}

export interface LibraryActions {
  /**
   * Subscribes to the library events and loads the initial state. Returns the
   * function that undoes it. Calls are counted: React Strict Mode's
   * mount/unmount/mount (and a real remount) never leaves duplicate
   * subscriptions, and an in-flight initial load is shared, not repeated.
   */
  connect(): () => void;
  /** Reloads everything (the "Try again" button). */
  reload(): Promise<void>;

  /** Opens the OS folder picker in main; the renderer never supplies a path. */
  addRoot(): Promise<void>;
  removeRoot(rootId: string): Promise<void>;

  startScan(rootId?: string): Promise<void>;
  cancelScan(): Promise<void>;

  startWatching(): Promise<void>;
  stopWatching(): Promise<void>;

  setQuery(query: string): void;

  /** Switches the main area. Leaves any open album/artist/genre. */
  setView(view: LibraryView): void;
  setSort(sort: TrackSortDto): void;
  /** Opens one album / artist / genre. */
  selectGroup(group: GroupRefDto): void;
  clearSelection(): void;
  /** `undefined` returns to the group's natural order. */
  setDetailSort(sort: TrackSortDto | undefined): void;
  retryBrowse(): void;
  dismissBrowseNotice(): void;

  dismissRootError(): void;
  dismissScanError(): void;
  dismissWatcherError(): void;
}

export type LibraryStore = LibraryState & LibraryActions;
export type LibraryStoreApi = StoreApi<LibraryStore>;

export interface LibraryStoreOptions {
  /** Quiet time after the last keystroke before searching. Default 200 ms. */
  readonly searchDebounceMs?: number;
  /** Results requested per search. Default 500 (the backend maximum is 5 000). */
  readonly searchLimit?: number;
}

type LibraryChannel = keyof LibraryIpcContract;
type Failure = { readonly ok: false; readonly error: UiError };

const IDLE_SCAN: ScanSlice = { phase: 'idle', scanId: undefined, progress: undefined, last: undefined, error: undefined };
const IDLE_GROUPS: GroupsSlice = { kind: undefined, status: 'idle', items: [], error: undefined };
const IDLE_DETAIL: DetailSlice = { status: 'idle', group: undefined, tracks: [], sort: undefined, error: undefined };
const IDLE_SEARCH: SearchSlice = { status: 'idle', query: '', results: [], total: 0, error: undefined };

export function createLibraryStore(bridge: NovaBridge, options: LibraryStoreOptions = {}): LibraryStoreApi {
  const searchDebounceMs = options.searchDebounceMs ?? 200;
  const searchLimit = options.searchLimit ?? 500;

  /** Calls a library channel. A rejected bridge call (it only rejects for a
   *  bug or a dead app) is folded into the same failure shape as an `IpcError`. */
  async function call<K extends LibraryChannel>(channel: K, request: IpcRequest<K>): Promise<IpcResponse<K>> {
    try {
      return await bridge.invoke(channel, request);
    } catch {
      const failure: Failure = {
        ok: false,
        error: { code: 'unavailable', message: 'Could not reach the application. Try restarting Nova Player.', operation: channel },
      };
      return failure as IpcResponse<K>;
    }
  }

  return createStore<LibraryStore>((set, get) => {
    let connections = 0;
    let unsubscribers: (() => void)[] = [];
    let initialLoad: Promise<void> | undefined;
    let searchTimer: ReturnType<typeof setTimeout> | undefined;
    let searchSequence = 0;
    let refreshing: Promise<void> | undefined;
    let refreshAgain = false;
    let tracksSequence = 0;
    let groupsSequence = 0;
    let detailSequence = 0;
    /** All Tracks changed in main while another view was showing; reload when it comes back. */
    let tracksStale = false;

    /* ------------------------------ loaders ------------------------------ */

    async function loadRoots(): Promise<UiError | undefined> {
      const result = await call('library:listRoots', undefined);
      if (result.ok) {
        set({ roots: result.value.roots, rootsError: undefined });
        return undefined;
      }
      set({ rootsError: result.error });
      return result.error;
    }

    async function loadTracks(): Promise<UiError | undefined> {
      // Show the loading state only when there is nothing to show yet;
      // a refresh after a change (or a re-sort) keeps the current list on screen.
      if (get().tracksStatus !== 'ready') set({ tracksStatus: 'loading', tracksError: undefined });
      const sequence = ++tracksSequence;
      const { sort } = get();
      const isDefault = sort.field === DEFAULT_SORT.field && sort.direction === DEFAULT_SORT.direction;
      const result = await call('library:listTracks', isDefault ? {} : { sort });
      if (sequence !== tracksSequence) return undefined; // a newer load superseded this one
      tracksStale = false;
      if (result.ok) {
        set({ tracks: result.value.tracks, tracksStatus: 'ready', tracksError: undefined });
        return undefined;
      }
      set({ tracksStatus: 'error', tracksError: result.error });
      return result.error;
    }

    async function loadSummary(): Promise<UiError | undefined> {
      const result = await call('library:getSummary', undefined);
      if (result.ok) {
        set({ summary: result.value });
        return undefined;
      }
      return result.error;
    }

    async function loadGroups(): Promise<UiError | undefined> {
      const kind = groupKindOfView(get().view);
      if (kind === undefined) return undefined;
      const sequence = ++groupsSequence;
      // Keep the list on screen while refreshing the same kind; show loading only for a new kind.
      if (get().groups.kind !== kind) set({ groups: { kind, status: 'loading', items: [], error: undefined } });
      const result = await call('library:listGroups', { kind });
      if (sequence !== groupsSequence) return undefined;
      if (result.ok) {
        set({ groups: { kind, status: 'ready', items: result.value.groups, error: undefined } });
        return undefined;
      }
      set((s) => ({ groups: { kind, status: 'error', items: s.groups.kind === kind ? s.groups.items : [], error: result.error } }));
      return result.error;
    }

    async function loadDetail(): Promise<UiError | undefined> {
      const selection = get().selection;
      if (selection === undefined) return undefined;
      const sequence = ++detailSequence;
      const { sort } = get().detail;
      const result = await call('library:getGroup', sort === undefined ? { kind: selection.kind, key: selection.key } : { kind: selection.kind, key: selection.key, sort });
      if (sequence !== detailSequence) return undefined;
      if (result.ok) {
        set((s) => ({ detail: { ...s.detail, status: 'ready', group: result.value.group, tracks: result.value.tracks, error: undefined } }));
        return undefined;
      }
      if (result.error.code === 'group-not-found') {
        // The library changed under the user (a scan removed it): go back to the list, and say so.
        set({ selection: undefined, detail: IDLE_DETAIL, browseNotice: 'That item is no longer in your library.' });
        void loadGroups();
        return undefined;
      }
      set((s) => ({ detail: { ...s.detail, status: 'error', error: result.error } }));
      return result.error;
    }

    async function loadScanState(): Promise<UiError | undefined> {
      const result = await call('library:getScanState', undefined);
      if (!result.ok) {
        set((s) => ({ scan: { ...s.scan, error: result.error } }));
        return result.error;
      }
      const { active, last } = result.value;
      set((s) => ({
        scan: {
          phase: active === undefined ? (s.scan.phase === 'starting' ? 'starting' : 'idle') : s.scan.phase === 'cancelling' ? 'cancelling' : 'running',
          scanId: active?.scanId,
          progress: active?.progress,
          last: last ?? s.scan.last,
          error: undefined,
        },
      }));
      return undefined;
    }

    async function loadWatcher(): Promise<UiError | undefined> {
      const result = await call('library:getWatcherStatus', undefined);
      if (result.ok) {
        set((s) => ({ watcher: { ...s.watcher, status: result.value, error: undefined } }));
        return undefined;
      }
      set((s) => ({ watcher: { ...s.watcher, error: result.error } }));
      return result.error;
    }

    async function runSearch(query: string): Promise<void> {
      const sequence = ++searchSequence;
      set((s) => ({ search: { ...s.search, status: 'loading', query, error: undefined } }));
      const result = await call('library:search', { query, limit: searchLimit });
      if (sequence !== searchSequence) return; // a newer search (or a cleared box) superseded this one
      if (result.ok) {
        set({ search: { status: 'ready', query, results: result.value.results, total: result.value.total, error: undefined } });
      } else {
        set({ search: { status: 'error', query, results: [], total: 0, error: result.error } });
      }
    }

    /** Re-reads what a `library:changed` event made stale. Overlapping
     *  refreshes are coalesced: at most one runs and one more is queued. */
    function refreshLibrary(): Promise<void> {
      if (refreshing !== undefined) {
        refreshAgain = true;
        return refreshing;
      }
      refreshing = (async () => {
        do {
          refreshAgain = false;
          const query = get().search.query;
          const { view, selection } = get();
          // Only what is on screen is re-read; All Tracks is marked stale and reloaded when it is shown again.
          if (view !== 'tracks') tracksStale = true;
          await Promise.all([
            loadRoots(),
            loadSummary(),
            view === 'tracks' ? loadTracks() : Promise.resolve(),
            groupKindOfView(view) !== undefined && selection === undefined ? loadGroups() : Promise.resolve(),
            selection !== undefined ? loadDetail() : Promise.resolve(),
            query.trim() === '' ? Promise.resolve() : runSearch(query),
          ]);
        } while (refreshAgain);
      })().finally(() => {
        refreshing = undefined;
      });
      return refreshing;
    }

    async function loadEverything(): Promise<void> {
      set({ connection: 'loading', connectionError: undefined });
      const errors = await Promise.all([loadRoots(), loadTracks(), loadScanState(), loadWatcher(), loadSummary()]);
      const failed = errors.filter((e): e is UiError => e !== undefined);
      if (failed.length === errors.length) set({ connection: 'failed', connectionError: failed[0] });
      else set({ connection: 'ready', connectionError: undefined });
    }

    function startInitialLoad(): Promise<void> {
      initialLoad ??= loadEverything().finally(() => {
        initialLoad = undefined;
      });
      return initialLoad;
    }

    /* ------------------------------- events ------------------------------ */

    function subscribeToEvents(): (() => void)[] {
      return [
        bridge.subscribe('library:scanProgress', (progress) => {
          set((s) => ({
            scan: { ...s.scan, phase: s.scan.phase === 'cancelling' ? 'cancelling' : 'running', scanId: progress.scanId, progress },
          }));
        }),
        bridge.subscribe('library:scanFinished', (result) => {
          set({ scan: { phase: 'idle', scanId: undefined, progress: undefined, last: result, error: undefined } });
        }),
        bridge.subscribe('library:changed', () => {
          void refreshLibrary();
        }),
        bridge.subscribe('library:watcherStatus', (status) => {
          set((s) => ({ watcher: { ...s.watcher, status } }));
        }),
      ];
    }

    return {
      connection: 'disconnected',
      connectionError: undefined,
      roots: [],
      rootsError: undefined,
      rootAction: { busy: false, error: undefined },
      tracks: [],
      tracksStatus: 'idle',
      tracksError: undefined,
      sort: DEFAULT_SORT,
      view: 'tracks',
      summary: undefined,
      groups: IDLE_GROUPS,
      selection: undefined,
      detail: IDLE_DETAIL,
      browseNotice: undefined,
      query: '',
      search: IDLE_SEARCH,
      scan: IDLE_SCAN,
      watcher: { status: undefined, busy: false, error: undefined },

      connect() {
        connections += 1;
        if (connections === 1) {
          unsubscribers = subscribeToEvents();
          void startInitialLoad();
        } else if (get().connection === 'disconnected') {
          void startInitialLoad();
        }
        let released = false;
        return () => {
          if (released) return;
          released = true;
          connections -= 1;
          if (connections === 0) {
            for (const unsubscribe of unsubscribers) unsubscribe();
            unsubscribers = [];
            if (searchTimer !== undefined) clearTimeout(searchTimer);
            searchTimer = undefined;
          }
        };
      },

      reload: () => loadEverything(),

      async addRoot() {
        if (get().rootAction.busy) return;
        set({ rootAction: { busy: true, error: undefined } });
        const result = await call('library:addRoot', undefined);
        if (!result.ok) {
          set({ rootAction: { busy: false, error: result.error } });
          return;
        }
        if (result.value.outcome === 'added') {
          const added = result.value.root;
          set((s) => ({ roots: s.roots.some((r) => r.id === added.id) ? s.roots : [...s.roots, added] }));
        }
        set({ rootAction: { busy: false, error: undefined } });
      },

      async removeRoot(rootId) {
        if (get().rootAction.busy) return;
        set({ rootAction: { busy: true, error: undefined } });
        const result = await call('library:removeRoot', { rootId });
        if (!result.ok) {
          set({ rootAction: { busy: false, error: result.error } });
          return;
        }
        set((s) => ({ roots: s.roots.filter((r) => r.id !== rootId), rootAction: { busy: false, error: undefined } }));
      },

      async startScan(rootId) {
        if (get().scan.phase !== 'idle') return; // the backend allows one scan at a time
        set((s) => ({ scan: { ...s.scan, phase: 'starting', error: undefined } }));
        const result = await call('library:startScan', rootId === undefined ? {} : { rootId });
        if (!result.ok) {
          set((s) => ({ scan: { ...s.scan, phase: 'idle', error: result.error } }));
          return;
        }
        // Events can overtake this reply; only move on if nothing else has.
        set((s) => (s.scan.phase === 'starting' ? { scan: { ...s.scan, phase: 'running', scanId: result.value.scanId } } : {}));
      },

      async cancelScan() {
        const { phase } = get().scan;
        if (phase !== 'running' && phase !== 'starting') return;
        set((s) => ({ scan: { ...s.scan, phase: 'cancelling', error: undefined } }));
        const result = await call('library:cancelScan', undefined);
        if (!result.ok) {
          set((s) => ({ scan: { ...s.scan, phase: s.scan.phase === 'cancelling' ? 'running' : s.scan.phase, error: result.error } }));
        } else if (!result.value.cancelled) {
          await loadScanState(); // nothing was running after all; resync with main
        }
      },

      async startWatching() {
        if (get().watcher.busy) return;
        set((s) => ({ watcher: { ...s.watcher, busy: true, error: undefined } }));
        const result = await call('library:startWatching', undefined);
        set((s) => ({
          watcher: result.ok ? { status: result.value, busy: false, error: undefined } : { ...s.watcher, busy: false, error: result.error },
        }));
      },

      async stopWatching() {
        if (get().watcher.busy) return;
        set((s) => ({ watcher: { ...s.watcher, busy: true, error: undefined } }));
        const result = await call('library:stopWatching', undefined);
        set((s) => ({
          watcher: result.ok ? { status: result.value, busy: false, error: undefined } : { ...s.watcher, busy: false, error: result.error },
        }));
      },

      setQuery(query) {
        set({ query });
        if (searchTimer !== undefined) clearTimeout(searchTimer);
        searchTimer = undefined;
        if (query.trim() === '') {
          searchSequence += 1; // invalidate any search still in flight
          set({ search: IDLE_SEARCH });
          return;
        }
        searchTimer = setTimeout(() => {
          searchTimer = undefined;
          void runSearch(query);
        }, searchDebounceMs);
      },

      setView(view) {
        if (get().view === view && get().selection === undefined) return;
        detailSequence += 1;
        set({ view, selection: undefined, detail: IDLE_DETAIL, browseNotice: undefined });
        if (view === 'tracks') {
          if (tracksStale || get().tracksStatus !== 'ready') void loadTracks();
        } else if (groupKindOfView(view) !== undefined) {
          void loadGroups();
        }
      },

      setSort(sort) {
        const current = get().sort;
        if (current.field === sort.field && current.direction === sort.direction) return;
        set({ sort });
        void loadTracks();
      },

      selectGroup(group) {
        detailSequence += 1;
        set({ selection: group, detail: { ...IDLE_DETAIL, status: 'loading' }, browseNotice: undefined });
        void loadDetail();
      },

      clearSelection() {
        detailSequence += 1;
        set({ selection: undefined, detail: IDLE_DETAIL });
        void loadGroups();
      },

      setDetailSort(sort) {
        set((s) => ({ detail: { ...s.detail, sort } }));
        void loadDetail();
      },

      retryBrowse() {
        const { view, selection } = get();
        if (selection !== undefined) void loadDetail();
        else if (view === 'tracks') void loadTracks();
        else if (groupKindOfView(view) !== undefined) void loadGroups();
        void loadSummary();
      },

      dismissBrowseNotice: () => set({ browseNotice: undefined }),

      dismissRootError: () => set((s) => ({ rootAction: { ...s.rootAction, error: undefined }, rootsError: undefined })),
      dismissScanError: () => set((s) => ({ scan: { ...s.scan, error: undefined } })),
      dismissWatcherError: () => set((s) => ({ watcher: { ...s.watcher, error: undefined } })),
    };
  });
}
