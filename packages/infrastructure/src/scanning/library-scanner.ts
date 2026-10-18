import path from 'node:path';
import {
  computeDeduplicationKey,
  createTrack,
  createTrackId as createDomainTrackId,
  TrackRepositoryError,
  type TrackFileState,
  type TrackId,
  type TrackRecord,
  type TrackRepository,
} from '@nova/domain';
import { FileSystemError } from '../filesystem/file-system-error.js';
import type { FileStats, FileSystem } from '../filesystem/file-system.js';
import { canonicalizePath, isPathWithin, pathComparisonKey, type CanonicalPath, type PathKey } from '../filesystem/path-policy.js';
import { isSupportedAudioFile } from '../metadata/supported-formats.js';
import type { MetadataReader, MetadataReadResult } from '../metadata/music-metadata-reader.js';
import {
  ScanError,
  type LibraryScanner,
  type ScanCounts,
  type ScanFailure,
  type ScanProgress,
  type ScanRequest,
  type ScanResult,
} from './scan-types.js';

export interface LibraryScannerDependencies {
  readonly fileSystem: FileSystem;
  readonly metadataReader: MetadataReader;
  readonly trackRepository: TrackRepository;
  /** Mints the TrackId of each NEW track. Defaults to the domain's `createTrackId`. */
  readonly createTrackId?: () => TrackId;
  /** Maximum simultaneous tag reads. Default 4. */
  readonly concurrency?: number;
  /** Files whose results are saved per database transaction. Default 100. */
  readonly batchSize?: number;
}

interface WorkItem {
  readonly path: CanonicalPath;
  readonly stats: FileStats;
  /** Present when the file is already known (a re-read, keeping its TrackId). */
  readonly existing: TrackFileState | undefined;
}

/** What reading one work item produced. `skipped-by-cancel` = never started. */
type ReadOutcome = MetadataReadResult | { readonly status: 'filesystem-error'; readonly error: FileSystemError } | undefined;

type ApplyOutcome =
  | { readonly kind: 'added'; readonly duplicate: boolean }
  | { readonly kind: 'updated' }
  | { readonly kind: 'failed'; readonly failure: ScanFailure };

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_BATCH_SIZE = 100;

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer, got ${value}`);
  return value;
}

export function createLibraryScanner(dependencies: LibraryScannerDependencies): LibraryScanner {
  const { fileSystem, metadataReader, trackRepository } = dependencies;
  const newTrackId = dependencies.createTrackId ?? createDomainTrackId;
  const concurrency = positiveInteger(dependencies.concurrency, DEFAULT_CONCURRENCY, 'concurrency');
  const batchSize = positiveInteger(dependencies.batchSize, DEFAULT_BATCH_SIZE, 'batchSize');

  // Scans on this scanner run one at a time: two scans doing check-then-write
  // against the same tables would race. (Per instance - not a global lock.)
  let queue: Promise<unknown> = Promise.resolve();

  async function runScan(request: ScanRequest): Promise<ScanResult> {
    const { signal, onProgress } = request;
    const aborted = (): boolean => signal?.aborted === true;

    const root = canonicalizePath(request.root);
    const scope = request.scope === undefined ? root : canonicalizePath(request.scope);
    if (!isPathWithin(root, scope)) {
      throw new ScanError('scope-outside-root', `Scan scope ${scope} is not inside the library root ${root}.`);
    }

    const counts = { discovered: 0, skipped: 0, added: 0, updated: 0, removed: 0, failed: 0, possibleDuplicates: 0 };
    const failures: ScanFailure[] = [];
    // `total` is unknown until discovery ends; the progress closure reads it live.
    const plan: { value: number | undefined } = { value: undefined };
    let removalWithheld: ScanResult['removalWithheld'];

    const emit = (phase: ScanProgress['phase'], currentPath?: string): void => {
      onProgress?.({
        ...counts,
        phase,
        processed: counts.skipped + counts.added + counts.updated + counts.failed,
        total: plan.value,
        currentPath,
      });
    };
    const fail = (path: string, kind: ScanFailure['kind'], message: string): void => {
      counts.failed += 1;
      failures.push({ path, kind, message });
    };
    const finish = (): ScanResult => {
      const status = aborted() ? 'cancelled' : 'completed';
      emit(status);
      const snapshot: ScanCounts = { ...counts };
      return { status, root, scope, ...snapshot, failures, removalWithheld };
    };

    if (aborted()) return finish();

    // ---- Preconditions: the root must be a reachable folder. Checked first
    // and fatally so an unavailable drive can never look like "all files deleted".
    let rootStats: FileStats;
    try {
      rootStats = await fileSystem.stat(root);
    } catch (error) {
      if (error instanceof FileSystemError && (error.code === 'not-found' || error.code === 'access-denied')) {
        throw new ScanError('root-unavailable', `Library root is not available (${error.code}): ${root}`, { cause: error });
      }
      throw error;
    }
    if (rootStats.kind !== 'directory') throw new ScanError('root-not-directory', `Library root is not a folder: ${root}`);

    // ---- What the store already knows inside this scope, keyed by path identity.
    const known = new Map<PathKey, TrackFileState>();
    for (const state of trackRepository.listFileStates()) {
      try {
        if (isPathWithin(scope, state.sourcePath)) known.set(pathComparisonKey(state.sourcePath), state);
      } catch {
        // A stored path the current policy cannot read can never match a
        // scanned file; leave that row alone rather than guess.
      }
    }

    // ---- Discovery: walk the scope, classify every audio file.
    const seen = new Set<PathKey>();
    const unverified: string[] = []; // folders we could not list: their tracks must not be removed
    const work: WorkItem[] = [];
    let scopeUnverified = false;

    const classify = async (filePath: CanonicalPath): Promise<void> => {
      counts.discovered += 1;
      seen.add(pathComparisonKey(filePath));
      let stats: FileStats;
      try {
        stats = await fileSystem.statFile(filePath);
      } catch (error) {
        if (error instanceof FileSystemError) {
          fail(filePath, 'filesystem', error.message);
          return;
        }
        throw error;
      }
      const existing = known.get(pathComparisonKey(filePath));
      if (
        existing !== undefined &&
        existing.sizeBytes === stats.sizeBytes &&
        existing.modifiedAtMs === stats.modifiedAtMs &&
        existing.sourcePath === filePath
      ) {
        counts.skipped += 1;
        return;
      }
      work.push({ path: filePath, stats, existing });
    };

    emit('discovering', scope);
    let scopeStats: FileStats | undefined = scope === root ? rootStats : undefined;
    if (scopeStats === undefined) {
      try {
        scopeStats = await fileSystem.stat(scope);
      } catch (error) {
        if (!(error instanceof FileSystemError)) throw error;
        if (error.code !== 'not-found') {
          fail(scope, 'filesystem', error.message);
          scopeUnverified = true;
        } // not-found: the scope is simply gone; its tracks are removed below
      }
    }

    if (scopeStats?.kind === 'file') {
      if (isSupportedAudioFile(path.basename(scope))) await classify(scope);
    } else if (scopeStats?.kind === 'directory') {
      const visited = new Set<PathKey>();
      const stack: CanonicalPath[] = [scope];
      while (stack.length > 0 && !aborted()) {
        const directory = stack.pop() as CanonicalPath;
        const directoryKey = pathComparisonKey(directory);
        if (visited.has(directoryKey)) continue; // belt and braces: links are not followed, but never loop
        visited.add(directoryKey);

        let entries;
        try {
          entries = await fileSystem.readDirectory(directory);
        } catch (error) {
          if (error instanceof FileSystemError) {
            fail(directory, 'filesystem', error.message);
            unverified.push(directory);
            continue;
          }
          throw error;
        }

        const subdirectories: CanonicalPath[] = [];
        for (const entry of entries) {
          if (aborted()) break;
          if (entry.kind === 'directory') subdirectories.push(entry.path);
          else if (entry.kind === 'file' && isSupportedAudioFile(entry.name)) await classify(entry.path);
          // symlinks, junctions and other kinds are deliberately ignored
        }
        // Push in reverse so the sorted order is also the visiting order.
        for (let i = subdirectories.length - 1; i >= 0; i -= 1) stack.push(subdirectories[i] as CanonicalPath);
        emit('discovering', directory);
      }
    }

    // ---- Reading + saving, in batches.
    plan.value = counts.discovered;
    if (!aborted()) emit('reading');
    for (let start = 0; start < work.length && !aborted(); start += batchSize) {
      const chunk = work.slice(start, start + batchSize);
      const results = await readChunk(chunk, aborted);
      const outcomes = saveChunk(chunk, results);
      chunk.forEach((item, index) => {
        const outcome = outcomes[index];
        if (outcome === undefined) return; // never read (cancelled)
        if (outcome.kind === 'added') {
          counts.added += 1;
          if (outcome.duplicate) counts.possibleDuplicates += 1;
        } else if (outcome.kind === 'updated') {
          counts.updated += 1;
        } else {
          counts.failed += 1;
          failures.push(outcome.failure);
        }
        emit('reading', item.path);
      });
    }

    // ---- Removal of tracks whose files are gone.
    if (!aborted() && !scopeUnverified) {
      const gone: TrackFileState[] = [];
      for (const [key, state] of known) {
        if (seen.has(key)) continue;
        if (unverified.some((folder) => insideOrEqual(folder, state.sourcePath))) continue;
        gone.push(state);
      }
      if (scope === root && counts.discovered === 0 && counts.failed === 0 && gone.length > 0) {
        removalWithheld = 'root-appears-empty';
      } else if (gone.length > 0) {
        emit('removing');
        for (let start = 0; start < gone.length && !aborted(); start += batchSize) {
          const chunk = gone.slice(start, start + batchSize);
          const removed = trackRepository.runInTransaction(() => chunk.filter((state) => trackRepository.delete(state.id)).length);
          counts.removed += removed;
          emit('removing', chunk[chunk.length - 1]?.sourcePath);
        }
      }
    }

    return finish();
  }

  function insideOrEqual(folder: string, candidate: string): boolean {
    try {
      return isPathWithin(folder, candidate);
    } catch {
      return false;
    }
  }

  /** Reads tags for a chunk with bounded concurrency. Stops starting new
   *  reads once cancelled; reads already in flight complete. */
  async function readChunk(chunk: readonly WorkItem[], aborted: () => boolean): Promise<ReadOutcome[]> {
    const results: ReadOutcome[] = new Array<ReadOutcome>(chunk.length).fill(undefined);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (!aborted()) {
        const index = next;
        next += 1;
        const item = chunk[index];
        if (item === undefined) return;
        try {
          results[index] = await metadataReader.read(item.path);
        } catch (error) {
          if (error instanceof FileSystemError) results[index] = { status: 'filesystem-error', error };
          else throw error;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, chunk.length) }, worker));
    return results;
  }

  /** Saves one chunk in a single transaction. Each file is its own nested
   *  unit, so one rejected track cannot undo its neighbours. */
  function saveChunk(chunk: readonly WorkItem[], results: readonly ReadOutcome[]): (ApplyOutcome | undefined)[] {
    const outcomes: (ApplyOutcome | undefined)[] = new Array<ApplyOutcome | undefined>(chunk.length).fill(undefined);
    trackRepository.runInTransaction(() => {
      chunk.forEach((item, index) => {
        const result = results[index];
        if (result === undefined) return;
        if (result.status === 'filesystem-error') {
          outcomes[index] = { kind: 'failed', failure: { path: item.path, kind: 'filesystem', message: result.error.message } };
          return;
        }
        if (result.status === 'unreadable') {
          // A previously good track whose file is now unreadable is left as it was.
          outcomes[index] = { kind: 'failed', failure: { path: item.path, kind: 'unreadable-media', message: result.reason } };
          return;
        }
        try {
          outcomes[index] = trackRepository.runInTransaction(() => saveOne(item, result.metadata));
        } catch (error) {
          if (!(error instanceof TrackRepositoryError)) throw error;
          outcomes[index] = { kind: 'failed', failure: { path: item.path, kind: 'persistence', message: error.message } };
        }
      });
    });
    return outcomes;
  }

  function saveOne(item: WorkItem, raw: Extract<MetadataReadResult, { status: 'ok' }>['metadata']): ApplyOutcome {
    // The DOMAIN decides title/artist/fallbacks; the scanner only supplies
    // an id (new, or the existing one) and the canonical path.
    const track = createTrack({ id: item.existing?.id ?? newTrackId(), sourcePath: item.path, raw });
    const record: TrackRecord = { track, sizeBytes: item.stats.sizeBytes, modifiedAtMs: item.stats.modifiedAtMs };

    if (item.existing !== undefined) {
      trackRepository.update(record);
      return { kind: 'updated' };
    }
    const duplicate =
      trackRepository.findByDeduplicationKey(
        computeDeduplicationKey({ title: track.title, artist: track.artist, sizeBytes: item.stats.sizeBytes }),
      ).length > 0;
    trackRepository.insert(record);
    return { kind: 'added', duplicate };
  }

  return {
    scan(request) {
      const run = queue.then(
        () => runScan(request),
        () => runScan(request),
      );
      queue = run.catch(() => undefined);
      return run;
    },
  };
}
