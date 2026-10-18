import {
  groupTracks,
  searchTracks as searchDomainTracks,
  selectGroup,
  sortTracks,
  LibraryRootRepositoryError,
  type GroupKind,
  type LibraryGroup,
  type LibraryRoot,
  type SearchResult,
  type Track,
  type TrackSort,
} from '@nova/domain';
import { FileSystemError } from '../filesystem/file-system-error.js';
import { isPathWithin, pathComparisonKey } from '../filesystem/path-policy.js';
import type { FolderWatcher, FolderWatcherDependencies } from '../watching/folder-watcher.js';
import type { LibraryServices } from '../composition/library-services.js';
import { ScanError, type ScanCounts, type ScanFailure, type ScanProgress } from '../scanning/scan-types.js';

/* ------------------------------------------------------------------ *
 * Views: what the application layer returns. They are plain data with
 * no infrastructure types, but they are NOT the IPC DTOs - the desktop
 * main process maps them to those (the explicit renderer boundary).
 * ------------------------------------------------------------------ */

export interface RootView {
  readonly id: string;
  readonly path: string;
  readonly addedAtMs: number;
  /** Whether the folder currently exists and can be opened. */
  readonly available: boolean;
  /** How many stored tracks lie inside it. */
  readonly trackCount: number;
  /** Whether the folder watcher is currently watching it. */
  readonly watched: boolean;
}

export interface ScanJobProgress {
  readonly scanId: string;
  readonly rootId: string;
  readonly rootPath: string;
  /** 0-based position of this root within the job. */
  readonly rootIndex: number;
  readonly rootCount: number;
  readonly progress: ScanProgress;
}

export interface ScanRootOutcome {
  readonly rootId: string;
  readonly rootPath: string;
  readonly status: 'completed' | 'cancelled' | 'failed';
  readonly counts: ScanCounts;
  /** The first few failures; `failureCount` is the true total. */
  readonly failures: readonly ScanFailure[];
  readonly failureCount: number;
  readonly removalWithheld: 'root-appears-empty' | undefined;
  /** Set when the root could not be scanned at all. */
  readonly error: { readonly code: string; readonly message: string } | undefined;
}

export interface ScanJobResult {
  readonly scanId: string;
  readonly status: 'completed' | 'cancelled' | 'failed';
  readonly startedAtMs: number;
  readonly finishedAtMs: number;
  readonly roots: readonly ScanRootOutcome[];
}

export interface ScanState {
  /** The running job's latest progress, or `undefined` when idle. `scanId` is always known while running. */
  readonly active: { readonly scanId: string; readonly startedAtMs: number; readonly progress: ScanJobProgress | undefined } | undefined;
  /** The most recent finished job (not persisted across app restarts). */
  readonly last: ScanJobResult | undefined;
}

export interface WatcherStatusView {
  readonly running: boolean;
  readonly roots: readonly { readonly rootId: string; readonly path: string; readonly state: 'watching' | 'unavailable' }[];
  readonly lastReconcile:
    | { readonly atMs: number; readonly rootId: string | undefined; readonly counts: ScanCounts; readonly status: 'completed' | 'cancelled' }
    | undefined;
  readonly lastError: { readonly atMs: number; readonly rootId: string | undefined; readonly message: string } | undefined;
}

export type LibraryChangeReason = 'scan' | 'watcher' | 'root-added' | 'root-removed';

export type LibraryApplicationEvent =
  | { readonly type: 'scan-progress'; readonly progress: ScanJobProgress }
  | { readonly type: 'scan-finished'; readonly result: ScanJobResult }
  | { readonly type: 'library-changed'; readonly reason: LibraryChangeReason }
  | { readonly type: 'watcher-status'; readonly status: WatcherStatusView };

export type LibraryApplicationErrorCode =
  | 'root-unavailable'
  | 'root-not-directory'
  | 'root-exists'
  | 'root-overlaps'
  | 'root-not-found'
  | 'no-roots'
  | 'scan-running'
  | 'group-not-found';

/** A rule of the library application was violated (as opposed to a disk fault). */
export class LibraryApplicationError extends Error {
  readonly code: LibraryApplicationErrorCode;
  constructor(code: LibraryApplicationErrorCode, message: string, options?: { readonly cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'LibraryApplicationError';
    this.code = code;
  }
}

/* ------------------------------------------------------------------ *
 * The application service
 * ------------------------------------------------------------------ */

export interface LibraryApplication {
  listRoots(): Promise<readonly RootView[]>;
  /** Registers an existing folder as a library root. Does not scan it. */
  addRoot(folderPath: string): Promise<RootView>;
  /** Unregisters a root and removes its tracks, atomically. Refused while a scan runs. */
  removeRoot(rootId: string): Promise<{ readonly removedTracks: number }>;

  /** Starts a background scan of one root, or of every root. Returns at once. */
  startScan(request?: { readonly rootId?: string }): { readonly scanId: string; readonly rootCount: number };
  /** Cooperatively cancels the running scan. Returns whether one was running. */
  cancelScan(): boolean;
  getScanState(): ScanState;

  /** Every stored track in a deterministic order: `sort` (default title ascending). */
  listTracks(sort?: TrackSort): readonly Track[];
  /** Counts of tracks, albums, artists and genres, derived from the stored tracks. */
  getSummary(): LibrarySummary;
  /** Every album / artist / genre with counts, in a deterministic order. */
  listGroups(kind: GroupKind): readonly LibraryGroup[];
  /** One group and its tracks (natural order, or `sort`).
   *  @throws LibraryApplicationError `group-not-found` when it no longer exists */
  getGroup(kind: GroupKind, key: string, sort?: TrackSort): { readonly group: LibraryGroup; readonly tracks: readonly Track[] };
  /** The domain's Phase 1 search over the stored tracks. */
  searchTracks(query: string): SearchResult[];

  /**
   * The launch policy (Phase 5). Called once by the host after wiring; returns at once with a
   * report while the work continues in the background:
   *  1. no roots registered -> nothing to do;
   *  2. the folder watcher is started over every root (idempotent; an unavailable root is
   *     reported by the watcher and retried by its reconcile timer) - BEFORE the scan, so a
   *     file changed while the scan runs is not missed;
   *  3. one incremental reconciliation scan over the roots that are AVAILABLE right now (so
   *     an unplugged drive is skipped instead of failing every launch, and its tracks are
   *     never removed). It is skipped when a scan is already running, so two scans never overlap.
   * It never throws for a library problem; the UI stays usable throughout because scanning
   * is a background job whose progress arrives as events.
   */
  startup(): Promise<StartupReport>;

  /** Starts the folder watcher over every root (idempotent). */
  startWatching(): Promise<WatcherStatusView>;
  stopWatching(): Promise<WatcherStatusView>;
  getWatcherStatus(): WatcherStatusView;

  /** Subscribes to events. Returns the unsubscribe function. */
  subscribe(listener: (event: LibraryApplicationEvent) => void): () => void;

  /** Aborts and awaits the running scan, stops the watcher, drops subscribers. Idempotent. */
  dispose(): Promise<void>;
}

export interface LibraryApplicationDependencies {
  /** The Phase 2 composition root. The application layer builds nothing of its own. */
  readonly services: Pick<
    LibraryServices,
    'trackRepository' | 'libraryRootRepository' | 'fileSystem' | 'scanner' | 'createFolderWatcher'
  >;
  readonly now?: () => number;
  /** Mints root ids and scan ids. Defaults to `crypto.randomUUID()`. */
  readonly newId?: () => string;
  /** Minimum time between progress events within one phase. Default 100 ms. */
  readonly progressIntervalMs?: number;
  /** Failures kept per root in a job result. Default 100. */
  readonly maxReportedFailures?: number;
  /** Watcher tuning (debounce, periodic interval, ...). */
  readonly watcher?: Omit<FolderWatcherDependencies, 'scanner' | 'onReconciled' | 'onError'>;
  /** Called with unexpected errors the application layer had to contain
   *  (a throwing subscriber, a scan that crashed). Never receives control flow. */
  readonly onInternalError?: (error: unknown) => void;
}

export interface LibrarySummary {
  readonly trackCount: number;
  readonly albumCount: number;
  readonly artistCount: number;
  readonly genreCount: number;
}

export interface StartupReport {
  readonly rootCount: number;
  /** Roots that were reachable at launch and so were scanned. */
  readonly availableRoots: number;
  readonly unavailableRoots: number;
  readonly watching: boolean;
  readonly scanStarted: boolean;
}

const EMPTY_COUNTS: ScanCounts = { discovered: 0, skipped: 0, added: 0, updated: 0, removed: 0, failed: 0, possibleDuplicates: 0 };

function countsOf(source: ScanCounts): ScanCounts {
  const { discovered, skipped, added, updated, removed, failed, possibleDuplicates } = source;
  return { discovered, skipped, added, updated, removed, failed, possibleDuplicates };
}

function inside(rootPath: string, candidate: string): boolean {
  try {
    return isPathWithin(rootPath, candidate);
  } catch {
    return false; // a stored path the policy cannot read belongs to no root
  }
}

/** Stable library order: title, then artist (both normalised, plain code-unit order), then id. */
export function createLibraryApplication(dependencies: LibraryApplicationDependencies): LibraryApplication {
  const { services } = dependencies;
  const { trackRepository, libraryRootRepository, fileSystem, scanner } = services;
  const now = dependencies.now ?? Date.now;
  const newId = dependencies.newId ?? ((): string => crypto.randomUUID());
  const progressIntervalMs = dependencies.progressIntervalMs ?? 100;
  const maxReportedFailures = dependencies.maxReportedFailures ?? 100;
  const reportInternal = (error: unknown): void => {
    try {
      dependencies.onInternalError?.(error);
    } catch {
      // the error sink itself failed; nothing sensible is left to do
    }
  };

  let disposed = false;
  const listeners = new Set<(event: LibraryApplicationEvent) => void>();

  function emit(event: LibraryApplicationEvent): void {
    if (disposed) return;
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (error) {
        // A broken subscriber must never abort a scan or the watcher.
        reportInternal(error);
      }
    }
  }

  /* ----- scan job state ----- */
  interface ActiveJob {
    readonly scanId: string;
    readonly startedAtMs: number;
    readonly abort: AbortController;
    readonly done: Promise<void>;
    progress: ScanJobProgress | undefined;
  }
  let active: ActiveJob | undefined;
  let lastResult: ScanJobResult | undefined;

  /* ----- watcher state ----- */
  let watcher: FolderWatcher | undefined;
  let watchedKeys = new Set<string>();
  let failedKeys = new Set<string>();
  let lastReconcile: WatcherStatusView['lastReconcile'];
  let lastError: WatcherStatusView['lastError'];

  function rootIdForPath(rootPath: string): string | undefined {
    try {
      const key = pathComparisonKey(rootPath);
      return libraryRootRepository.list().find((root) => pathComparisonKey(root.path) === key)?.id;
    } catch {
      return undefined;
    }
  }

  function watcherStatus(): WatcherStatusView {
    return {
      running: watcher?.isRunning === true,
      roots:
        watcher?.isRunning === true
          ? libraryRootRepository.list().map((root) => {
              const key = safeKey(root.path);
              return { rootId: root.id, path: root.path, state: watchedKeys.has(key) && !failedKeys.has(key) ? ('watching' as const) : ('unavailable' as const) };
            })
          : [],
      lastReconcile,
      lastError,
    };
  }

  function safeKey(p: string): string {
    try {
      return pathComparisonKey(p);
    } catch {
      return p;
    }
  }

  async function startWatcherOver(roots: readonly LibraryRoot[]): Promise<void> {
    watchedKeys = new Set();
    failedKeys = new Set();
    const created = services.createFolderWatcher({
      ...dependencies.watcher,
      onReconciled: ({ root, result }) => {
        lastReconcile = {
          atMs: now(),
          rootId: rootIdForPath(root),
          counts: countsOf(result),
          status: result.status,
        };
        if (result.added + result.updated + result.removed > 0) emit({ type: 'library-changed', reason: 'watcher' });
        emit({ type: 'watcher-status', status: watcherStatus() });
      },
      onError: ({ root, error }) => {
        failedKeys.add(safeKey(root));
        lastError = { atMs: now(), rootId: rootIdForPath(root), message: error instanceof Error ? error.message : String(error) };
        emit({ type: 'watcher-status', status: watcherStatus() });
      },
    });
    watcher = created;
    const report = created.start(roots.map((root) => root.path));
    for (const path of report.watching) watchedKeys.add(safeKey(path));
    for (const failure of report.failed) failedKeys.add(safeKey(failure.root));
  }

  async function stopWatcher(): Promise<void> {
    const current = watcher;
    watcher = undefined;
    watchedKeys = new Set();
    failedKeys = new Set();
    await current?.stop();
  }

  /**
   * Phase 8: stopping and starting the watcher each take an `await`, so two callers interleaving (a root added
   * while the launch sync starts the watcher, a `stopWatching` during a root removal) could start a second
   * watcher over the first one - which `watcher` then forgets, leaving it running (and scanning) for ever.
   * Every operation that changes the watcher therefore runs through this one queue, one at a time.
   */
  let watcherQueue: Promise<unknown> = Promise.resolve();
  function serializeWatcher<T>(operation: () => Promise<T>): Promise<T> {
    const run = watcherQueue.then(operation, operation);
    watcherQueue = run.catch(() => undefined);
    return run;
  }

  /** After the set of roots changed, a running watcher must watch the new set. (Call through `serializeWatcher`.) */
  async function refreshWatcherIfRunning(): Promise<void> {
    if (disposed || watcher?.isRunning !== true) return;
    await stopWatcher();
    await startWatcherOver(libraryRootRepository.list());
    emit({ type: 'watcher-status', status: watcherStatus() });
  }

  /* ----- roots ----- */
  function trackCountFor(rootPath: string, states: ReturnType<typeof trackRepository.listFileStates>): number {
    let count = 0;
    for (const state of states) if (inside(rootPath, state.sourcePath)) count += 1;
    return count;
  }

  async function isAvailable(rootPath: string): Promise<boolean> {
    try {
      return (await fileSystem.stat(rootPath)).kind === 'directory';
    } catch (error) {
      if (error instanceof FileSystemError) return false;
      throw error;
    }
  }

  async function toRootView(root: LibraryRoot, states: ReturnType<typeof trackRepository.listFileStates>): Promise<RootView> {
    return {
      id: root.id,
      path: root.path,
      addedAtMs: root.addedAtMs,
      available: await isAvailable(root.path),
      trackCount: trackCountFor(root.path, states),
      watched: watcher?.isRunning === true && watchedKeys.has(safeKey(root.path)) && !failedKeys.has(safeKey(root.path)),
    };
  }

  /* ----- the scan job ----- */
  async function runJob(job: ActiveJob, roots: readonly LibraryRoot[]): Promise<void> {
    const outcomes: ScanRootOutcome[] = [];
    let lastEmitAt = Number.NEGATIVE_INFINITY;
    let lastEmittedKey = '';

    for (const [rootIndex, root] of roots.entries()) {
      if (job.abort.signal.aborted) break;
      try {
        const result = await scanner.scan({
          root: root.path,
          signal: job.abort.signal,
          onProgress: (progress) => {
            const view: ScanJobProgress = { scanId: job.scanId, rootId: root.id, rootPath: root.path, rootIndex, rootCount: roots.length, progress };
            job.progress = view;
            // Throttle: the scanner reports on every step; a UI needs a few
            // updates a second. Phase changes (and the final snapshot) always pass.
            const key = `${rootIndex}:${progress.phase}`;
            const time = now();
            if (key !== lastEmittedKey || time - lastEmitAt >= progressIntervalMs) {
              lastEmittedKey = key;
              lastEmitAt = time;
              emit({ type: 'scan-progress', progress: view });
            }
          },
        });
        outcomes.push({
          rootId: root.id,
          rootPath: root.path,
          status: result.status,
          counts: countsOf(result),
          failures: result.failures.slice(0, maxReportedFailures),
          failureCount: result.failures.length,
          removalWithheld: result.removalWithheld,
          error: undefined,
        });
      } catch (error) {
        const known = error instanceof ScanError || error instanceof FileSystemError;
        if (!known) reportInternal(error);
        outcomes.push({
          rootId: root.id,
          rootPath: root.path,
          status: 'failed',
          counts: EMPTY_COUNTS,
          failures: [],
          failureCount: 0,
          removalWithheld: undefined,
          error: known
            ? { code: error.code, message: error.message }
            : { code: 'internal', message: 'The scan stopped because of an unexpected error.' },
        });
      }
    }

    const cancelled = job.abort.signal.aborted;
    const status: ScanJobResult['status'] = cancelled
      ? 'cancelled'
      : outcomes.length > 0 && outcomes.every((outcome) => outcome.status === 'failed')
        ? 'failed'
        : 'completed';
    const result: ScanJobResult = { scanId: job.scanId, status, startedAtMs: job.startedAtMs, finishedAtMs: now(), roots: outcomes };
    lastResult = result;
    active = undefined;
    emit({ type: 'scan-finished', result });
    emit({ type: 'library-changed', reason: 'scan' });
  }

  /** Installs and starts a scan job. The caller has checked that none is active. */
  function beginJob(roots: readonly LibraryRoot[]): { readonly scanId: string; readonly rootCount: number } {
    const scanId = newId();
    const abort = new AbortController();
    const job: ActiveJob = {
      scanId,
      startedAtMs: now(),
      abort,
      progress: undefined,
      done: Promise.resolve(),
    };
    // Installed as `active` BEFORE the job starts, so a second startScan is
    // refused immediately and the job can clear it when it finishes.
    active = job;
    (job as { done: Promise<void> }).done = runJob(job, roots).catch((error: unknown) => {
      reportInternal(error);
      active = undefined;
    });
    return { scanId, rootCount: roots.length };
  }

  /** Starts the watcher if it is not running. Idempotent. */
  function ensureWatching(): Promise<void> {
    return serializeWatcher(async () => {
      if (disposed || watcher?.isRunning === true) return;
      await startWatcherOver(libraryRootRepository.list());
      emit({ type: 'watcher-status', status: watcherStatus() });
    });
  }

  return {
    async listRoots() {
      const states = trackRepository.listFileStates();
      return Promise.all(libraryRootRepository.list().map((root) => toRootView(root, states)));
    },

    async addRoot(folderPath) {
      const canonical = await (async () => {
        let stats;
        try {
          stats = await fileSystem.stat(folderPath);
        } catch (error) {
          if (error instanceof FileSystemError && (error.code === 'not-found' || error.code === 'access-denied')) {
            throw new LibraryApplicationError('root-unavailable', `That folder is not available (${error.code}).`, { cause: error });
          }
          throw error;
        }
        if (stats.kind !== 'directory') throw new LibraryApplicationError('root-not-directory', 'That path is not a folder.');
        // The real, true-case path, so the same folder chosen two ways is one root.
        return fileSystem.realPath(folderPath);
      })();

      const key = pathComparisonKey(canonical);
      for (const existing of libraryRootRepository.list()) {
        if (pathComparisonKey(existing.path) === key) {
          throw new LibraryApplicationError('root-exists', 'That folder is already in the library.');
        }
        if (isPathWithin(existing.path, canonical) || isPathWithin(canonical, existing.path)) {
          throw new LibraryApplicationError(
            'root-overlaps',
            'That folder overlaps a folder already in the library (one contains the other).',
          );
        }
      }

      const root: LibraryRoot = { id: newId(), path: canonical, addedAtMs: now() };
      try {
        libraryRootRepository.insert(root);
      } catch (error) {
        if (error instanceof LibraryRootRepositoryError && error.code === 'duplicate-root-path') {
          throw new LibraryApplicationError('root-exists', 'That folder is already in the library.', { cause: error });
        }
        throw error;
      }
      await serializeWatcher(refreshWatcherIfRunning);
      emit({ type: 'library-changed', reason: 'root-added' });
      return toRootView(root, trackRepository.listFileStates());
    },

    async removeRoot(rootId) {
      if (active !== undefined) throw new LibraryApplicationError('scan-running', 'A scan is running. Cancel it or wait for it to finish first.');
      const root = libraryRootRepository.getById(rootId);
      if (root === undefined) throw new LibraryApplicationError('root-not-found', 'That library folder does not exist.');

      // Phase 8: the folder watcher is stopped FIRST, and its in-flight reconciliation awaited. The scanner's
      // cancellation policy is "in-flight tag reads finish and are saved", so a watcher scan that was
      // mid-read when the folder was removed used to save its files AFTER the removal had deleted the
      // folder's tracks: orphans that belong to no registered folder, show in the library, cannot be played
      // and can never be removed. With the watcher quiet, the delete below sees every track there will be.
      const removedTracks = await serializeWatcher(async () => {
        const wasWatching = watcher?.isRunning === true;
        if (wasWatching) await stopWatcher();
        try {
          // A manual scan could have been started while the watcher was stopping.
          if (active !== undefined) throw new LibraryApplicationError('scan-running', 'A scan is running. Cancel it or wait for it to finish first.');
          // Tracks and the root go together or not at all (both repositories share
          // one connection, so this single transaction covers both).
          return trackRepository.runInTransaction(() => {
            let removed = 0;
            for (const state of trackRepository.listFileStates()) {
              if (inside(root.path, state.sourcePath) && trackRepository.delete(state.id)) removed += 1;
            }
            libraryRootRepository.delete(root.id);
            return removed;
          });
        } finally {
          // Whether or not the removal worked, a watcher that was running keeps running, over the folders that remain.
          if (wasWatching && !disposed) {
            try {
              await startWatcherOver(libraryRootRepository.list());
              emit({ type: 'watcher-status', status: watcherStatus() });
            } catch (error) {
              reportInternal(error);
            }
          }
        }
      });
      emit({ type: 'library-changed', reason: 'root-removed' });
      return { removedTracks };
    },

    startScan(request = {}) {
      if (disposed) throw new Error('The library application is closed.');
      if (active !== undefined) throw new LibraryApplicationError('scan-running', 'A scan is already running.');

      let roots: readonly LibraryRoot[];
      if (request.rootId !== undefined) {
        const one = libraryRootRepository.getById(request.rootId);
        if (one === undefined) throw new LibraryApplicationError('root-not-found', 'That library folder does not exist.');
        roots = [one];
      } else {
        roots = libraryRootRepository.list();
      }
      if (roots.length === 0) throw new LibraryApplicationError('no-roots', 'There are no library folders to scan. Add a folder first.');
      return beginJob(roots);
    },

    cancelScan() {
      if (active === undefined) return false;
      active.abort.abort();
      return true;
    },

    getScanState() {
      return {
        active: active === undefined ? undefined : { scanId: active.scanId, startedAtMs: active.startedAtMs, progress: active.progress },
        last: lastResult,
      };
    },

    listTracks(sort) {
      return sortTracks(trackRepository.list(), sort);
    },

    getSummary() {
      const tracks = trackRepository.list();
      return {
        trackCount: tracks.length,
        albumCount: groupTracks(tracks, 'album').length,
        artistCount: groupTracks(tracks, 'artist').length,
        genreCount: groupTracks(tracks, 'genre').length,
      };
    },

    listGroups(kind) {
      return groupTracks(trackRepository.list(), kind);
    },

    getGroup(kind, key, sort) {
      const selected = selectGroup(trackRepository.list(), kind, key);
      if (selected === undefined) throw new LibraryApplicationError('group-not-found', 'That album, artist or genre is no longer in the library.');
      return { group: selected.group, tracks: sort === undefined ? selected.tracks : sortTracks(selected.tracks, sort) };
    },

    async startup() {
      if (disposed) throw new Error('The library application is closed.');
      const roots = libraryRootRepository.list();
      if (roots.length === 0) return { rootCount: 0, availableRoots: 0, unavailableRoots: 0, watching: false, scanStarted: false };

      let watching = false;
      try {
        await ensureWatching();
        watching = watcher?.isRunning === true;
      } catch (error) {
        reportInternal(error); // a watcher that cannot start must not stop the launch
      }

      const available: LibraryRoot[] = [];
      for (const root of roots) {
        try {
          if (await isAvailable(root.path)) available.push(root);
        } catch (error) {
          reportInternal(error);
        }
      }
      let scanStarted = false;
      if (available.length > 0 && active === undefined && !disposed) {
        beginJob(available);
        scanStarted = true;
      }
      return { rootCount: roots.length, availableRoots: available.length, unavailableRoots: roots.length - available.length, watching, scanStarted };
    },

    searchTracks(query) {
      return searchDomainTracks(trackRepository.list(), query);
    },

    async startWatching() {
      if (disposed) throw new Error('The library application is closed.');
      await ensureWatching();
      return watcherStatus();
    },

    stopWatching() {
      return serializeWatcher(async () => {
        if (watcher !== undefined) {
          await stopWatcher();
          emit({ type: 'watcher-status', status: watcherStatus() });
        }
        return watcherStatus();
      });
    },

    getWatcherStatus: watcherStatus,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async dispose() {
      if (disposed) return;
      disposed = true;
      const job = active;
      job?.abort.abort();
      await job?.done;
      await watcherQueue; // a start/stop already under way finishes first; none can start a watcher once `disposed` is set
      await stopWatcher();
      listeners.clear();
    },
  };
}
