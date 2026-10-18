/**
 * A folder the user has added to their library. Roots are what scans and
 * watchers operate on; tracks belong to a root by lying inside it.
 */
export interface LibraryRoot {
  /** Opaque identifier (a UUID). Not derived from the path: the same folder
   *  removed and re-added is a new root. */
  readonly id: string;
  /** The folder's canonical absolute path, as chosen by the user. */
  readonly path: string;
  /** When it was added, whole milliseconds since the Unix epoch. */
  readonly addedAtMs: number;
}

export type LibraryRootRepositoryErrorCode =
  /** A root with this id already exists. */
  | 'duplicate-root-id'
  /** A root for this same folder already exists (however its path was spelled). */
  | 'duplicate-root-path'
  /** The store rejected the value. */
  | 'constraint-violation'
  /** Stored data could not be turned back into a valid root. */
  | 'corrupt-record';

export class LibraryRootRepositoryError extends Error {
  readonly code: LibraryRootRepositoryErrorCode;

  constructor(code: LibraryRootRepositoryErrorCode, message: string, options?: { readonly cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'LibraryRootRepositoryError';
    this.code = code;
  }
}

/**
 * Persistence port for the registered library folders. Synchronous for the
 * same reason as `TrackRepository`. Deliberately minimal: roots are only
 * ever listed, added and removed.
 */
export interface LibraryRootRepository {
  /** Every root, oldest first (then by id), so the order is stable. */
  list(): readonly LibraryRoot[];
  getById(id: string): LibraryRoot | undefined;
  /** @throws LibraryRootRepositoryError `duplicate-root-id`, `duplicate-root-path`, `constraint-violation` */
  insert(root: LibraryRoot): void;
  /** Returns whether a root was actually removed. Does NOT touch tracks;
   *  the caller removes those in the same transaction. */
  delete(id: string): boolean;
}
