import type { DeduplicationKey } from './deduplication.js';
import type { Track } from './track.js';
import type { TrackId } from './track-id.js';

/**
 * A `Track` together with the one file fact the library must remember
 * about it that `Track` deliberately does not carry: the file's size in
 * bytes. The size is an input to the deduplication identity (see
 * `computeDeduplicationKey`), so the repository needs it whenever it writes
 * a track. It is write-side only - reads return plain `Track`s.
 */
export interface TrackRecord {
  readonly track: Track;
  /** Non-negative integer number of bytes. */
  readonly sizeBytes: number;
  /**
   * The file's last-modified time in whole milliseconds since the Unix
   * epoch, as observed when the metadata was read. Together with
   * `sizeBytes` it lets a scanner tell whether a file changed since it was
   * last read. Omitted means "unknown" and is stored as 0, which never
   * matches a real file, so such a track is always re-read.
   */
  readonly modifiedAtMs?: number;
}

/**
 * The small, cheap-to-load slice of a stored track that incremental
 * scanning compares against the file system: where the track was found, and
 * the size and modification time it had when last read. Deliberately not a
 * full `Track` - a scan over a large library should not materialise every
 * track's metadata just to learn which files are unchanged.
 */
export interface TrackFileState {
  readonly id: TrackId;
  readonly sourcePath: string;
  readonly sizeBytes: number;
  /** 0 when unknown. */
  readonly modifiedAtMs: number;
}

export type TrackRepositoryErrorCode =
  /** Another track already has this TrackId. */
  | 'duplicate-track-id'
  /** Another track already points at this source path. */
  | 'duplicate-source-path'
  /** `update` was called for a TrackId that is not in the library. */
  | 'track-not-found'
  /** The store rejected the value (e.g. a title that is empty, a year out of range). */
  | 'constraint-violation'
  /** Stored data could not be turned back into a valid `Track`. */
  | 'corrupt-record';

/**
 * The failure type of every `TrackRepository` write, and of reads that hit
 * unreadable stored data. Storage-specific errors (SQLite, etc.) are
 * translated into one of these codes by the implementation; the original
 * error is kept on `cause` for diagnostics only.
 */
export class TrackRepositoryError extends Error {
  readonly code: TrackRepositoryErrorCode;

  constructor(code: TrackRepositoryErrorCode, message: string, options?: { readonly cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'TrackRepositoryError';
    this.code = code;
  }
}

/**
 * The persistence port for the track library. The domain and application
 * layers depend on this interface; infrastructure supplies the
 * implementation. It speaks only domain types - no rows, SQL or driver.
 *
 * Deliberately synchronous: the only planned implementation is an
 * in-process SQLite store whose transactions are synchronous, and pretending
 * otherwise would only make atomic multi-step operations harder to write.
 *
 * Deliberately small - only what the library actually needs now. Lookup by
 * source path, counts, bulk writes and transactions are NOT here; the
 * scanning phase will add exactly what it proves it needs.
 *
 * Three identities stay distinct (see track-id.ts): a track is identified
 * by its `TrackId`; its `sourcePath` is just where the file currently is
 * (and may change via `update`); and the `DeduplicationKey` is an advisory
 * "looks like a duplicate" signal that never identifies anything.
 */
export interface TrackRepository {
  /** The track with this id, or `undefined` if there is none. */
  getById(id: TrackId): Track | undefined;

  /** Every track in the library, in no guaranteed order. */
  list(): readonly Track[];

  /**
   * Adds a new track.
   * @throws TrackRepositoryError `duplicate-track-id`, `duplicate-source-path`
   *   or `constraint-violation`. A failed insert stores nothing.
   */
  insert(record: TrackRecord): void;

  /**
   * Replaces ALL stored fields of the existing track whose id matches
   * `record.track.id`. The id itself never changes. `sourcePath` may change
   * (a moved/renamed file keeps its TrackId).
   * @throws TrackRepositoryError `track-not-found`, `duplicate-source-path`
   *   or `constraint-violation`. A failed update changes nothing.
   */
  update(record: TrackRecord): void;

  /** Removes a track. Returns whether one was actually removed. Never throws for a missing id. */
  delete(id: TrackId): boolean;

  /**
   * Every track whose stored deduplication key equals `key`. Several tracks
   * may share a key (it is advisory, not unique); an empty array means
   * nothing looks like a duplicate.
   */
  findByDeduplicationKey(key: DeduplicationKey): readonly Track[];

  /** The file state of every stored track (see `TrackFileState`), in no guaranteed order. */
  listFileStates(): readonly TrackFileState[];

  /**
   * Runs `work` as one atomic unit: if it throws, every write it made is
   * rolled back and the error is rethrown; otherwise all of them commit
   * together. Calls may be nested - a nested call that throws undoes only
   * its own writes, so an outer unit can catch that failure and carry on.
   * `work` must be synchronous (returning a promise is an error), which is
   * what keeps a transaction from being held open across unrelated work.
   */
  runInTransaction<T>(work: () => T): T;
}
