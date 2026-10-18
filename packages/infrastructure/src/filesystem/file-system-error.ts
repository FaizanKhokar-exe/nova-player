export type FileSystemErrorCode =
  /** The path (or a parent of it) does not exist. */
  | 'not-found'
  /** The OS denied access (EACCES/EPERM). */
  | 'access-denied'
  /** The path string itself is unusable: empty, relative, illegal characters, etc. */
  | 'invalid-path'
  /** A directory was required but the path is something else (e.g. a file). */
  | 'not-a-directory'
  /** A regular file was required but the path is something else (e.g. a directory). */
  | 'not-a-file'
  /** A root-relative path would resolve outside its root. */
  | 'outside-root'
  /** Any other I/O failure; see `cause` for the underlying error. */
  | 'io-error';

/**
 * The single error type thrown by the filesystem layer. It carries a small
 * stable `code` callers can branch on, the offending `path`, and the
 * original Node error as `cause` for diagnostics - callers should not need
 * to inspect `cause` (or know about errno codes) to decide what to do.
 */
export class FileSystemError extends Error {
  readonly code: FileSystemErrorCode;
  readonly path: string;

  constructor(code: FileSystemErrorCode, message: string, options: { readonly path: string; readonly cause?: unknown }) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'FileSystemError';
    this.code = code;
    this.path = options.path;
  }
}

/** Which Node call failed. Only needed because ENOTDIR means different
 *  things: "this is not a directory" for a listing, but "no such path" when
 *  a parent component of a looked-up path turns out to be a file. */
export type FileSystemOperation = 'stat' | 'readdir' | 'realpath';

/** Translates whatever a Node fs call threw into a `FileSystemError`. */
export function toFileSystemError(error: unknown, path: string, operation: FileSystemOperation): FileSystemError {
  if (error instanceof FileSystemError) return error;

  const errno = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  const code = typeof errno === 'string' ? errno : undefined;

  switch (code) {
    case 'ENOENT':
      return new FileSystemError('not-found', `Path not found: ${path}`, { path, cause: error });
    case 'ENOTDIR':
      return operation === 'readdir'
        ? new FileSystemError('not-a-directory', `Not a directory: ${path}`, { path, cause: error })
        : new FileSystemError('not-found', `Path not found (a parent is not a directory): ${path}`, { path, cause: error });
    case 'EISDIR':
      return new FileSystemError('not-a-file', `Is a directory, not a file: ${path}`, { path, cause: error });
    case 'EACCES':
    case 'EPERM':
      return new FileSystemError('access-denied', `Access denied: ${path}`, { path, cause: error });
    case 'ENAMETOOLONG':
    case 'EINVAL':
    case 'ERR_INVALID_ARG_VALUE':
    case 'ERR_INVALID_ARG_TYPE':
      return new FileSystemError('invalid-path', `Invalid path: ${path}`, { path, cause: error });
    default: {
      const detail = code ?? (error instanceof Error ? error.message : String(error));
      return new FileSystemError('io-error', `Filesystem error (${detail}) for: ${path}`, { path, cause: error });
    }
  }
}
