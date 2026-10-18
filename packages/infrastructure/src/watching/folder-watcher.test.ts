import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LibraryScanner, ScanRequest, ScanResult } from '../scanning/scan-types.js';
import {
  createFolderWatcher,
  type FolderWatcher,
  type FolderWatcherDependencies,
  type FolderWatcherErrorEvent,
  type WatchFunction,
} from './folder-watcher.js';

/** Absolute, host-appropriate fake paths (nothing here touches the disk). */
const abs = (...parts: string[]): string => path.resolve(path.sep, ...parts);

function result(request: ScanRequest, status: ScanResult['status'] = 'completed'): ScanResult {
  return {
    status, root: request.root, scope: request.scope ?? request.root,
    discovered: 0, skipped: 0, added: 0, updated: 0, removed: 0, failed: 0, possibleDuplicates: 0,
    failures: [], removalWithheld: undefined,
  };
}

interface FakeScanner extends LibraryScanner {
  readonly requests: ScanRequest[];
  /** Makes the next scan(s) hang until released. */
  hold(): { release(): void };
}
function fakeScanner(): FakeScanner {
  const requests: ScanRequest[] = [];
  let gate: Promise<void> | undefined;
  return {
    requests,
    hold() {
      let release!: () => void;
      gate = new Promise<void>((resolve) => (release = resolve));
      return {
        release: () => {
          release();
          gate = undefined;
        },
      };
    },
    async scan(request) {
      requests.push(request);
      if (gate) await gate;
      return result(request, request.signal?.aborted ? 'cancelled' : 'completed');
    },
  };
}

/** A controllable stand-in for the OS watch. */
interface FakeWatch {
  readonly watch: WatchFunction;
  readonly started: string[];
  readonly closed: string[];
  emit(root: string, relative: string | null): void;
  fail(root: string, error?: Error): void;
  /** Roots for which starting a watch should throw (until cleared). */
  readonly broken: Set<string>;
}
function fakeWatch(): FakeWatch {
  const listeners = new Map<string, { onEvent: (p: string | null) => void; onError: (e: Error) => void }>();
  const started: string[] = [];
  const closed: string[] = [];
  const broken = new Set<string>();
  return {
    started, closed, broken,
    watch(root, onEvent, onError) {
      if (broken.has(root)) throw Object.assign(new Error(`ENOENT: ${root}`), { code: 'ENOENT' });
      started.push(root);
      listeners.set(root, { onEvent, onError });
      return { close: () => void closed.push(root) };
    },
    emit: (root, relative) => listeners.get(root)?.onEvent(relative),
    fail: (root, error = new Error('watch failed')) => listeners.get(root)?.onError(error),
  };
}

let scanner: FakeScanner;
let os: FakeWatch;
let watchers: FolderWatcher[];
let errors: FolderWatcherErrorEvent[];

function make(overrides: Partial<FolderWatcherDependencies> = {}): FolderWatcher {
  const watcher = createFolderWatcher({
    scanner, watch: os.watch, debounceMs: 100, reconcileIntervalMs: 0,
    onError: (e) => errors.push(e), ...overrides,
  });
  watchers.push(watcher);
  return watcher;
}

beforeEach(() => {
  vi.useFakeTimers();
  scanner = fakeScanner();
  os = fakeWatch();
  watchers = [];
  errors = [];
});
afterEach(async () => {
  for (const w of watchers) await w.stop();
  vi.useRealTimers();
});

const scopes = (): string[] => scanner.requests.map((r) => r.scope ?? r.root);

describe('FolderWatcher: debouncing', () => {
  it('collapses a burst of events into ONE scan, fired only after the quiet period', async () => {
    const root = abs('lib');
    const w = make({ debounceMs: 100 });
    w.start([root]);
    for (let i = 0; i < 20; i += 1) os.emit(root, path.join('Album', 'song.mp3'));

    await vi.advanceTimersByTimeAsync(99);
    expect(scanner.requests).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2);
    expect(scanner.requests).toHaveLength(1);
    expect(scopes()).toEqual([abs('lib', 'Album', 'song.mp3')]);
  });

  it('every new event restarts the quiet period (a long copy does not scan mid-way)', async () => {
    const root = abs('lib');
    make({ debounceMs: 100 }).start([root]);
    for (let i = 0; i < 5; i += 1) {
      os.emit(root, 'growing-copy.mp3');
      await vi.advanceTimersByTimeAsync(80); // always shorter than the debounce
    }
    expect(scanner.requests).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(scanner.requests).toHaveLength(1);
  });

  it('the debounce time is configurable', async () => {
    const root = abs('lib');
    make({ debounceMs: 5000 }).start([root]);
    os.emit(root, 'a.mp3');
    await vi.advanceTimersByTimeAsync(4999);
    expect(scanner.requests).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2);
    expect(scanner.requests).toHaveLength(1);
  });

  it('events after a flush start a new burst and a new scan', async () => {
    const root = abs('lib');
    make().start([root]);
    os.emit(root, 'a.mp3');
    await vi.advanceTimersByTimeAsync(150);
    os.emit(root, 'b.mp3');
    await vi.advanceTimersByTimeAsync(150);
    expect(scopes()).toEqual([abs('lib', 'a.mp3'), abs('lib', 'b.mp3')]);
  });
});

describe('FolderWatcher: targeted scopes', () => {
  it('asks the scanner for the changed path only, scoped inside its root', async () => {
    const root = abs('lib');
    make().start([root]);
    os.emit(root, path.join('Rock', 'new.flac'));
    await vi.advanceTimersByTimeAsync(150);
    expect(scanner.requests[0]).toMatchObject({ root, scope: abs('lib', 'Rock', 'new.flac') });
    expect(scanner.requests[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('merges dirty paths inside a dirty folder into that folder', async () => {
    const root = abs('lib');
    make().start([root]);
    os.emit(root, path.join('Album', '1.mp3'));
    os.emit(root, path.join('Album', 'sub', '2.mp3'));
    os.emit(root, 'Album');
    await vi.advanceTimersByTimeAsync(150);
    expect(scopes()).toEqual([abs('lib', 'Album')]);
  });

  it('keeps unrelated dirty paths as separate scans, in a deterministic order', async () => {
    const root = abs('lib');
    make().start([root]);
    os.emit(root, path.join('Pop', 'x.mp3'));
    os.emit(root, path.join('Album', 'y.mp3'));
    os.emit(root, path.join('Album-2', 'z.mp3')); // shares a name PREFIX with Album, but is not inside it
    await vi.advanceTimersByTimeAsync(150);
    // Sorted by plain string order ('-' sorts before '/'), so the order is fixed, not arrival-dependent.
    expect(scopes()).toEqual([abs('lib', 'Album-2', 'z.mp3'), abs('lib', 'Album', 'y.mp3'), abs('lib', 'Pop', 'x.mp3')]);
  });

  it('falls back to one scan of the whole root when too many paths changed', async () => {
    const root = abs('lib');
    make({ maxTargetedScopes: 3 }).start([root]);
    for (let i = 0; i < 4; i += 1) os.emit(root, `d${i}/f.mp3`);
    await vi.advanceTimersByTimeAsync(150);
    expect(scopes()).toEqual([root]);
  });

  it('scans the whole root when the OS does not say which path changed', async () => {
    const root = abs('lib');
    make().start([root]);
    os.emit(root, null);
    os.emit(root, 'a.mp3');
    await vi.advanceTimersByTimeAsync(150);
    expect(scopes()).toEqual([root]);
  });

  it('refuses an event path that would escape the root, and reports it instead of scanning', async () => {
    const root = abs('lib');
    make().start([root]);
    os.emit(root, path.join('..', 'etc', 'passwd'));
    os.emit(root, path.join('Album', '..', '..', 'elsewhere.mp3'));
    await vi.advanceTimersByTimeAsync(500);
    expect(scanner.requests).toHaveLength(0);
    expect(errors).toMatchObject([{ kind: 'watch', root }, { kind: 'watch', root }]);
  });
});

describe('FolderWatcher: several roots', () => {
  it('debounces and scans each root independently, with its own root', async () => {
    const a = abs('libA');
    const b = abs('libB');
    make().start([a, b]);
    os.emit(a, 'a1.mp3');
    await vi.advanceTimersByTimeAsync(60);
    os.emit(b, 'b1.mp3');
    await vi.advanceTimersByTimeAsync(60); // A's quiet period is over, B's is not
    expect(scanner.requests.map((r) => r.root)).toEqual([a]);
    await vi.advanceTimersByTimeAsync(100);
    expect(scanner.requests.map((r) => r.root)).toEqual([a, b]);
  });

  it('watches each root once even if listed twice', () => {
    const root = abs('lib');
    make().start([root, root]);
    expect(os.started).toEqual([root]);
  });
});

describe('FolderWatcher: periodic reconciliation (the safety net for lost events)', () => {
  it('runs a full incremental scan of every root on the interval, with no events at all', async () => {
    const a = abs('libA');
    const b = abs('libB');
    make({ reconcileIntervalMs: 1000 }).start([a, b]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(scanner.requests.map((r) => [r.root, r.scope])).toEqual([[a, a], [b, b]]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(scanner.requests).toHaveLength(4);
  });

  it('is off when the interval is 0', async () => {
    make({ reconcileIntervalMs: 0 }).start([abs('lib')]);
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(scanner.requests).toHaveLength(0);
  });

  it('does not pile up passes while the previous one is still running', async () => {
    const root = abs('lib');
    make({ reconcileIntervalMs: 1000 }).start([root]);
    const gate = scanner.hold();
    await vi.advanceTimersByTimeAsync(5000); // five ticks while the first scan hangs
    expect(scanner.requests).toHaveLength(1);
    gate.release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(scanner.requests.length).toBeGreaterThan(1);
  });

  it('reconcileNow() runs an immediate full scan of every root and swallows a pending debounce', async () => {
    const root = abs('lib');
    const w = make({ debounceMs: 100 });
    w.start([root]);
    os.emit(root, 'a.mp3');
    await w.reconcileNow();
    expect(scopes()).toEqual([root]);
    await vi.advanceTimersByTimeAsync(500);
    expect(scopes()).toEqual([root]); // the pending targeted scan was subsumed
  });

  it('reports a failed reconcile (e.g. root unavailable) without stopping the watcher', async () => {
    const root = abs('lib');
    const failing: LibraryScanner = { scan: () => Promise.reject(new Error('root-unavailable')) };
    const w = make({ scanner: failing });
    w.start([root]);
    await w.reconcileNow();
    expect(errors).toMatchObject([{ root, kind: 'reconcile' }]);
    expect(w.isRunning).toBe(true);
  });
});

describe('FolderWatcher: recovering from watcher problems', () => {
  it('a failing watch is closed, reported, and followed by a full reconcile (events may be lost)', async () => {
    const root = abs('lib');
    make().start([root]);
    os.fail(root, new Error('EPERM: watch handle lost'));
    expect(os.closed).toEqual([root]);
    expect(errors).toMatchObject([{ root, kind: 'watch' }]);
    await vi.advanceTimersByTimeAsync(150);
    expect(scopes()).toEqual([root]);
  });

  it('the next periodic reconciliation re-establishes the dead watch, and events flow again', async () => {
    const root = abs('lib');
    make({ reconcileIntervalMs: 1000 }).start([root]);
    os.fail(root);
    expect(os.started).toEqual([root]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(os.started).toEqual([root, root]); // watch restarted
    scanner.requests.length = 0;
    os.emit(root, 'back.mp3');
    await vi.advanceTimersByTimeAsync(150);
    expect(scopes()).toEqual([abs('lib', 'back.mp3')]);
  });

  it('a root that cannot be watched at start is reported and retried; the other roots work', async () => {
    const good = abs('good');
    const bad = abs('bad');
    os.broken.add(bad);
    const w = make({ reconcileIntervalMs: 1000 });
    const report = w.start([good, bad]);

    expect(report.watching).toEqual([good]);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]?.root).toBe(bad);
    expect(errors).toMatchObject([{ root: bad, kind: 'watch' }]);

    os.broken.delete(bad); // the drive comes back
    await vi.advanceTimersByTimeAsync(1000);
    expect(os.started).toEqual([good, bad]);
  });

  it('an invalid root string is reported, not thrown, and does not block valid roots', () => {
    const good = abs('good');
    const report = make().start(['relative/path', good]);
    expect(report.watching).toEqual([good]);
    expect(report.failed[0]?.root).toBe('relative/path');
  });

  it('a throwing error listener cannot break the watcher', async () => {
    const root = abs('lib');
    const w = make({
      onError: () => {
        throw new Error('listener bug');
      },
    });
    w.start([root]);
    os.emit(root, '../escape.mp3');
    os.emit(root, 'ok.mp3');
    await vi.advanceTimersByTimeAsync(150);
    expect(scopes()).toEqual([abs('lib', 'ok.mp3')]);
  });
});

describe('FolderWatcher: lifecycle', () => {
  it('stop() closes every OS watch and cancels pending timers (no scan fires afterwards)', async () => {
    const a = abs('libA');
    const b = abs('libB');
    const w = make({ reconcileIntervalMs: 1000 });
    w.start([a, b]);
    os.emit(a, 'x.mp3');
    await w.stop();
    expect(os.closed.sort()).toEqual([a, b].sort());
    expect(w.isRunning).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(scanner.requests).toHaveLength(0);
  });

  it('stop() is idempotent, and safe before start()', async () => {
    const w = make();
    await w.stop();
    w.start([abs('lib')]);
    await w.stop();
    await w.stop();
    expect(os.closed).toEqual([abs('lib')]); // closed exactly once
  });

  it('stop() aborts the in-flight scan and waits for it to finish', async () => {
    const root = abs('lib');
    const w = make();
    w.start([root]);
    const gate = scanner.hold();
    os.emit(root, 'a.mp3');
    await vi.advanceTimersByTimeAsync(150);
    const signal = scanner.requests[0]?.signal;
    expect(signal?.aborted).toBe(false);

    let stopped = false;
    const stopping = w.stop().then(() => (stopped = true));
    await Promise.resolve();
    expect(signal?.aborted).toBe(true);
    expect(stopped).toBe(false); // still waiting for the scan to settle
    gate.release();
    await stopping;
    expect(stopped).toBe(true);
  });

  it('ignores events that arrive after stop()', async () => {
    const root = abs('lib');
    const w = make();
    w.start([root]);
    await w.stop();
    os.emit(root, 'late.mp3');
    await vi.advanceTimersByTimeAsync(1000);
    expect(scanner.requests).toHaveLength(0);
  });

  it('can be started again after stop() with a fresh state', async () => {
    const root = abs('lib');
    const w = make();
    w.start([root]);
    os.emit(root, 'stale.mp3');
    await w.stop();
    w.start([root]);
    os.emit(root, 'fresh.mp3');
    await vi.advanceTimersByTimeAsync(150);
    expect(scopes()).toEqual([abs('lib', 'fresh.mp3')]); // the pre-stop dirty path did not leak
  });

  it('refuses a second start() while running', () => {
    const w = make();
    w.start([abs('lib')]);
    expect(() => w.start([abs('lib')])).toThrow(/already running/);
  });

  it('reports each completed reconciliation to onReconciled', async () => {
    const root = abs('lib');
    const seen: string[] = [];
    make({ onReconciled: (e) => seen.push(`${e.result.status}:${e.scope}`) }).start([root]);
    os.emit(root, 'a.mp3');
    await vi.advanceTimersByTimeAsync(150);
    expect(seen).toEqual([`completed:${abs('lib', 'a.mp3')}`]);
  });

  it('rejects nonsensical tuning', () => {
    expect(() => make({ debounceMs: -1 })).toThrow(RangeError);
    expect(() => make({ reconcileIntervalMs: Number.NaN })).toThrow(RangeError);
    expect(() => make({ maxTargetedScopes: 0 })).toThrow(RangeError);
  });
});
