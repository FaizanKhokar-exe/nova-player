import fs from 'node:fs';
import { canonicalizePath, isPathWithin, resolveWithin, type CanonicalPath } from '../filesystem/path-policy.js';
import type { LibraryScanner, ScanResult } from '../scanning/scan-types.js';

/** A running OS watch on one folder tree. */
export interface WatchHandle {
  close(): void;
}

/**
 * Starts watching `root` recursively. `onEvent` receives the changed path
 * RELATIVE to `root` (or `null` when the OS cannot say which). Throwing
 * synchronously means the watch could not start (e.g. the folder is gone).
 * A later failure of a running watch is reported through `onError`.
 * Injectable so the debounce/recovery logic can be tested without a disk.
 */
export type WatchFunction = (
  root: string,
  onEvent: (relativePath: string | null) => void,
  onError: (error: Error) => void,
) => WatchHandle;

/** The production implementation: Node's native recursive `fs.watch`
 *  (ReadDirectoryChangesW on Windows; no extra dependency). */
export const watchWithFsWatch: WatchFunction = (root, onEvent, onError) => {
  const watcher = fs.watch(root, { recursive: true, persistent: false }, (_eventType, filename) => {
    onEvent(filename === null || filename === undefined ? null : String(filename));
  });
  watcher.on('error', onError);
  return { close: () => watcher.close() };
};

export interface FolderWatcherErrorEvent {
  readonly root: string;
  /** `watch`: the OS watch failed or reported something unusable.
   *  `reconcile`: a reconciliation scan could not run (e.g. the root is unavailable). */
  readonly kind: 'watch' | 'reconcile';
  readonly error: unknown;
}

export interface FolderWatcherReconciledEvent {
  readonly root: string;
  readonly scope: string;
  readonly result: ScanResult;
}

export interface FolderWatcherDependencies {
  /** Does ALL the real work. The watcher never reads tags or touches the
   *  database itself - it only decides WHEN and WHAT to ask the scanner. */
  readonly scanner: LibraryScanner;
  readonly watch?: WatchFunction;
  /** Quiet time after the LAST raw event before reconciling. Default 1000 ms. */
  readonly debounceMs?: number;
  /** How often to run a full incremental scan of every root as a safety net
   *  for events the OS never delivered. 0 disables it. Default 10 minutes. */
  readonly reconcileIntervalMs?: number;
  /** More than this many distinct changed paths in one burst falls back to
   *  one scan of the whole root. Default 25. */
  readonly maxTargetedScopes?: number;
  readonly onReconciled?: (event: FolderWatcherReconciledEvent) => void;
  readonly onError?: (event: FolderWatcherErrorEvent) => void;
}

export interface FolderWatcherStartReport {
  /** Canonical roots now being watched. */
  readonly watching: readonly string[];
  /** Roots that could not be watched yet. They are retried at every periodic reconciliation. */
  readonly failed: readonly { readonly root: string; readonly error: unknown }[];
}

export interface FolderWatcher {
  /** Begins watching `roots`. Does NOT scan: run an initial scan first (or call `reconcileNow`).
   *  @throws Error if already running */
  start(roots: readonly string[]): FolderWatcherStartReport;
  /** Stops everything: cancels timers, closes every OS watch, aborts the
   *  in-flight scan and waits for it to settle. Idempotent. */
  stop(): Promise<void>;
  /** Re-establishes any lost watches, then runs a full incremental scan of every root. */
  reconcileNow(): Promise<void>;
  readonly isRunning: boolean;
}

interface RootState {
  readonly root: CanonicalPath;
  handle: WatchHandle | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  pending: Set<CanonicalPath>;
  /** The next flush must scan the whole root (event path unknown, buffer overflowed, watch was lost...). */
  fullPending: boolean;
}

const DEFAULT_DEBOUNCE_MS = 1000;
const DEFAULT_RECONCILE_INTERVAL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_TARGETED_SCOPES = 25;

/**
 * Keeps the library in step with the disk. Raw OS events are only a hint -
 * they can be duplicated, coalesced, reordered or (on a busy or network
 * drive, or after a buffer overflow) dropped - so the design is:
 *
 *  1. every event just marks a path as "dirty" and (re)starts a debounce timer;
 *  2. when the burst goes quiet, the scanner reconciles ONLY the dirty
 *     paths (smaller dirty paths inside a larger dirty folder are merged);
 *  3. independently, a periodic full incremental scan catches whatever the
 *     events missed, and also re-establishes watches that died.
 *
 * No global state: each watcher owns its timers and handles.
 */
export function createFolderWatcher(dependencies: FolderWatcherDependencies): FolderWatcher {
  const { scanner, onReconciled, onError } = dependencies;
  const watch = dependencies.watch ?? watchWithFsWatch;
  const debounceMs = dependencies.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const reconcileIntervalMs = dependencies.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS;
  const maxTargetedScopes = dependencies.maxTargetedScopes ?? DEFAULT_MAX_TARGETED_SCOPES;
  for (const [name, value] of [['debounceMs', debounceMs], ['reconcileIntervalMs', reconcileIntervalMs]] as const) {
    if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be a non-negative number, got ${value}`);
  }
  if (!Number.isInteger(maxTargetedScopes) || maxTargetedScopes < 1) {
    throw new RangeError(`maxTargetedScopes must be a positive integer, got ${maxTargetedScopes}`);
  }

  let running = false;
  let abort: AbortController | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  let periodicRunning = false;
  const roots = new Map<CanonicalPath, RootState>();
  const inFlight = new Set<Promise<void>>();

  const report = (event: FolderWatcherErrorEvent): void => {
    try {
      onError?.(event);
    } catch {
      // A broken error listener must not take the watcher down with it.
    }
  };

  function reconcile(root: CanonicalPath, scope: CanonicalPath): Promise<void> {
    const signal = abort?.signal;
    const job = (async () => {
      try {
        const result = await scanner.scan({ root, scope, ...(signal !== undefined && { signal }) });
        onReconciled?.({ root, scope, result });
      } catch (error) {
        report({ root, kind: 'reconcile', error });
      }
    })();
    inFlight.add(job);
    void job.finally(() => inFlight.delete(job));
    return job;
  }

  function schedule(state: RootState): void {
    if (!running) return;
    if (state.timer !== undefined) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = undefined;
      flush(state);
    }, debounceMs);
    state.timer.unref?.();
  }

  /** Turns a burst's dirty paths into the fewest scans that cover them. */
  function flush(state: RootState): void {
    if (!running) return;
    let scopes: CanonicalPath[];
    if (state.fullPending || state.pending.size > maxTargetedScopes) {
      scopes = [state.root];
    } else {
      const all = [...state.pending];
      scopes = all.filter((scope) => !all.some((other) => other !== scope && isPathWithin(other, scope)));
    }
    state.pending = new Set();
    state.fullPending = false;
    for (const scope of scopes.sort()) void reconcile(state.root, scope);
  }

  function onRawEvent(state: RootState, relativePath: string | null): void {
    if (!running) return;
    if (relativePath === null || relativePath === '') {
      state.fullPending = true;
    } else {
      try {
        // The OS reports a path relative to the root. It is resolved through
        // the containment policy so a hostile or malformed name can never
        // point the scanner outside the root.
        state.pending.add(resolveWithin(state.root, relativePath));
      } catch (error) {
        report({ root: state.root, kind: 'watch', error });
        return;
      }
    }
    schedule(state);
  }

  function establishWatch(state: RootState): unknown {
    try {
      state.handle = watch(
        state.root,
        (relativePath) => onRawEvent(state, relativePath),
        (error) => onWatchFailed(state, error),
      );
      return undefined;
    } catch (error) {
      state.handle = undefined;
      return error;
    }
  }

  /** A running watch died (folder removed/unmounted, buffer overflow, ...). */
  function onWatchFailed(state: RootState, error: Error): void {
    if (!running) return;
    try {
      state.handle?.close();
    } catch {
      // already closed
    }
    state.handle = undefined;
    report({ root: state.root, kind: 'watch', error });
    // Events may have been lost: reconcile the whole root once, and the next
    // periodic reconciliation will try to re-establish the watch.
    state.fullPending = true;
    schedule(state);
  }

  return {
    get isRunning() {
      return running;
    },

    start(rootPaths) {
      if (running) throw new Error('FolderWatcher is already running; call stop() first.');
      running = true;
      abort = new AbortController();
      const watching: string[] = [];
      const failed: { root: string; error: unknown }[] = [];

      for (const rawRoot of rootPaths) {
        let root: CanonicalPath;
        try {
          root = canonicalizePath(rawRoot);
        } catch (error) {
          failed.push({ root: rawRoot, error });
          report({ root: rawRoot, kind: 'watch', error });
          continue;
        }
        if (roots.has(root)) continue; // the same root listed twice
        const state: RootState = { root, handle: undefined, timer: undefined, pending: new Set(), fullPending: false };
        roots.set(root, state);
        const error = establishWatch(state);
        if (error === undefined) {
          watching.push(root);
        } else {
          failed.push({ root, error });
          report({ root, kind: 'watch', error });
        }
      }

      if (reconcileIntervalMs > 0) {
        interval = setInterval(() => {
          if (periodicRunning) return; // the previous safety-net pass is still going
          periodicRunning = true;
          void this.reconcileNow().finally(() => {
            periodicRunning = false;
          });
        }, reconcileIntervalMs);
        interval.unref?.();
      }
      return { watching, failed };
    },

    async reconcileNow() {
      if (!running) return;
      const jobs: Promise<void>[] = [];
      for (const state of roots.values()) {
        if (state.handle === undefined) {
          const error = establishWatch(state); // recover a lost / never-started watch
          if (error !== undefined) report({ root: state.root, kind: 'watch', error });
        }
        // A full scan covers anything pending for this root.
        if (state.timer !== undefined) {
          clearTimeout(state.timer);
          state.timer = undefined;
        }
        state.pending = new Set();
        state.fullPending = false;
        jobs.push(reconcile(state.root, state.root));
      }
      await Promise.all(jobs);
    },

    async stop() {
      if (!running) return;
      running = false;
      if (interval !== undefined) clearInterval(interval);
      interval = undefined;
      abort?.abort();
      for (const state of roots.values()) {
        if (state.timer !== undefined) clearTimeout(state.timer);
        state.timer = undefined;
        try {
          state.handle?.close();
        } catch {
          // closing twice / on a dead watch is harmless
        }
        state.handle = undefined;
      }
      roots.clear();
      await Promise.allSettled([...inFlight]);
      abort = undefined;
    },
  };
}
