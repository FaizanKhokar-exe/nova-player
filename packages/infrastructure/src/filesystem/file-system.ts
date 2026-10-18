import type { CanonicalPath } from './path-policy.js';

/** What a path points at, after following symlinks/junctions (as `stat` does). */
export type FileKind = 'file' | 'directory' | 'other';

/** What a directory listing reports for an entry. Unlike `FileKind`, links
 *  are reported as links (`symlink`) and are NOT followed. */
export type DirectoryEntryKind = FileKind | 'symlink';

/**
 * What incremental scanning (Phase 2E) needs to tell whether a file
 * changed: where it is, how big it is, and when it was last modified.
 * Persisting these is 2E's decision; nothing here touches the database.
 */
export interface FileStats {
  readonly path: CanonicalPath;
  readonly kind: FileKind;
  /** Size in bytes. */
  readonly sizeBytes: number;
  /** Last-modified time, whole milliseconds since the Unix epoch (rounded down). */
  readonly modifiedAtMs: number;
}

export interface DirectoryEntry {
  /** The entry's own name, exactly as the file system reports it. */
  readonly name: string;
  /** The parent's canonical path joined with `name`. */
  readonly path: CanonicalPath;
  readonly kind: DirectoryEntryKind;
}

/**
 * The filesystem boundary for Nova Player's infrastructure. Deliberately
 * small: exactly what library scanning, metadata reading and folder
 * watching will ask of the disk. It has no write operations and no
 * byte-reading - `music-metadata` opens files itself.
 *
 * Every method accepts an ABSOLUTE path in any spelling (see
 * `canonicalizePath`) and rejects anything else with
 * `FileSystemError('invalid-path')` - a relative path is never resolved
 * against the current working directory. Every failure is a
 * `FileSystemError`; nothing is swallowed.
 */
export interface FileSystem {
  /**
   * Whether something exists at `path` (following links, so a broken symlink
   * is "no"). Resolves `false` ONLY for "not there"; access failures and
   * invalid paths throw, because answering `false` for "permission denied"
   * would make a scanner believe a file was deleted.
   */
  exists(path: string): Promise<boolean>;

  /** Size, modification time and kind of whatever is at `path`. Follows links.
   *  @throws FileSystemError `not-found`, `access-denied`, `invalid-path`, `io-error` */
  stat(path: string): Promise<FileStats>;

  /** `stat`, but additionally requires a regular file.
   *  @throws FileSystemError as `stat`, plus `not-a-file` */
  statFile(path: string): Promise<FileStats>;

  /**
   * The immediate children of a directory - NOT recursive - sorted by name
   * in plain UTF-16 code-unit order (not locale-aware, not case-folded), so
   * the result is identical on every run and platform. Includes hidden
   * entries; never includes `.` or `..`. Links are reported as `symlink`,
   * not followed. Recursion and filtering policy belong to the scanner.
   *
   * Names Windows cannot express as an ordinary path (reserved names,
   * trailing dot/space) are still listed, but passing their `path` back to
   * other methods will fail with `invalid-path`.
   * @throws FileSystemError `not-found`, `not-a-directory`, `access-denied`, `invalid-path`, `io-error`
   */
  readDirectory(path: string): Promise<readonly DirectoryEntry[]>;

  /**
   * The path as the file system itself spells it: symlinks/junctions
   * resolved, real letter case, Windows 8.3 short names expanded. Intended
   * for user-selected library roots, so `c:\music` and `C:\Music` become the
   * same stored root. Do not use it on every scanned file - it follows links
   * and costs a disk round-trip.
   * @throws FileSystemError as `stat`
   */
  realPath(path: string): Promise<CanonicalPath>;
}
