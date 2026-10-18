/**
 * What a scan reports while it runs and when it ends. Plain data only, so a
 * later phase can send it over IPC to a UI unchanged.
 */
export type ScanPhase =
  /** Walking folders, classifying each audio file as unchanged / new / changed. */
  | 'discovering'
  /** Reading tags for new and changed files and saving them. */
  | 'reading'
  /** Removing tracks whose files are gone. */
  | 'removing'
  /** Finished normally. */
  | 'completed'
  /** Stopped early because the caller asked it to. */
  | 'cancelled';

export interface ScanCounts {
  /** Audio files found so far (supported extension, regular file). */
  readonly discovered: number;
  /** Files left alone because size and modification time match what is stored. */
  readonly skipped: number;
  /** New tracks saved. */
  readonly added: number;
  /** Existing tracks re-read and saved (same TrackId). */
  readonly updated: number;
  /** Tracks deleted because their file is gone. */
  readonly removed: number;
  /** Files (or folders) that could not be handled; see `ScanResult.failures`. */
  readonly failed: number;
  /** New tracks whose advisory dedup key matched a track already stored. They are still saved. */
  readonly possibleDuplicates: number;
}

export interface ScanProgress extends ScanCounts {
  readonly phase: ScanPhase;
  /** Files fully dealt with so far: skipped + added + updated + failed. */
  readonly processed: number;
  /** Total files to deal with. Unknown (`undefined`) until discovery finishes, then equal to `discovered`. */
  readonly total: number | undefined;
  /** The path currently being worked on, when there is one. */
  readonly currentPath: string | undefined;
}

export type ScanFailureKind =
  /** The file is not usable audio (corrupt, truncated, unsupported contents). */
  | 'unreadable-media'
  /** The disk refused: could not stat a file or list a folder. */
  | 'filesystem'
  /** The library store rejected this one track (e.g. a path that collides with another). */
  | 'persistence';

export interface ScanFailure {
  readonly path: string;
  readonly kind: ScanFailureKind;
  readonly message: string;
}

export interface ScanResult extends ScanCounts {
  readonly status: 'completed' | 'cancelled';
  readonly root: string;
  /** The part of the library that was reconciled (equals `root` for a full scan). */
  readonly scope: string;
  readonly failures: readonly ScanFailure[];
  /**
   * Set when removal of missing tracks was deliberately skipped because the
   * whole root contained no audio files at all while tracks are stored for
   * it. An empty root is indistinguishable from a drive that failed to
   * mount, and wiping the index on a flaky mount would be far worse than
   * keeping stale rows until the next scan that finds a file.
   */
  readonly removalWithheld: 'root-appears-empty' | undefined;
}

export type ScanErrorCode =
  /** The root does not exist or cannot be opened. Nothing was changed. */
  | 'root-unavailable'
  | 'root-not-directory'
  | 'scope-outside-root';

/** A scan that could not even start. A scan that starts never throws for a
 *  bad file - those become `ScanResult.failures`. */
export class ScanError extends Error {
  readonly code: ScanErrorCode;
  constructor(code: ScanErrorCode, message: string, options?: { readonly cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'ScanError';
    this.code = code;
  }
}

export interface ScanRequest {
  /** The library root: a folder the user added. Must exist. */
  readonly root: string;
  /**
   * Restrict this scan to a file or folder inside `root` (default: all of
   * `root`). Only tracks inside the scope are added, updated or removed, so a
   * watcher can reconcile just the part that changed. A scope that no longer
   * exists is fine: tracks stored under it are removed.
   */
  readonly scope?: string;
  /** Aborting stops the scan cooperatively; see `LibraryScanner`. */
  readonly signal?: AbortSignal;
  /** Called with a fresh snapshot after meaningful steps. An exception thrown
   *  by the callback aborts the scan and propagates - it is not swallowed. */
  readonly onProgress?: (progress: ScanProgress) => void;
}

export interface LibraryScanner {
  /**
   * Reconciles the stored library with the files on disk.
   *
   * Policy:
   *  - NEW audio file -> read tags, create a Track with a fresh TrackId, save.
   *  - KNOWN file (same canonical path, compared case-insensitively on
   *    Windows) whose size, modification time and stored spelling are
   *    unchanged -> skipped without reading it.
   *  - KNOWN file that changed -> re-read, same TrackId, saved.
   *  - A stored track whose file is gone -> removed - EXCEPT inside any
   *    folder that could not be listed this time (unknown is not "gone"),
   *    when the scan was cancelled, or when the whole root looks empty.
   *  - A moved/renamed file is a removal plus an addition (a new TrackId);
   *    no identity guessing is attempted.
   *  - Possible duplicates (same advisory dedup key) are saved as separate
   *    tracks and counted, never merged.
   *  - Symlinks/junctions are not followed.
   *
   * Cancellation: after `signal` aborts, no new file is started, in-flight
   * tag reads finish and are saved, nothing is removed, and the result has
   * status 'cancelled'. Every saved track is complete (each batch commits
   * atomically), so the database is valid and a later scan simply continues.
   *
   * Scans on one scanner never overlap; a second call waits for the first.
   * @throws ScanError when the root is unavailable / not a folder / the scope is outside it
   * @throws FileSystemError `invalid-path` for an unusable root/scope string
   */
  scan(request: ScanRequest): Promise<ScanResult>;
}
