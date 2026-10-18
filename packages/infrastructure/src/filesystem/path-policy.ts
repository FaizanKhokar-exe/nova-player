import { posix, win32 } from 'node:path';
import { FileSystemError } from './file-system-error.js';

/**
 * Nova Player's path vocabulary. Four different things are all "a path",
 * and mixing them up is how duplicate library entries and traversal bugs
 * happen, so they are kept apart:
 *
 *  1. USER-SELECTED / IMPORTED path - a plain `string` straight from a
 *     folder dialog, a drag-and-drop, a settings file or an OS event. It is
 *     untrusted: it may be relative, have mixed `/` and `\`, `..`, a trailing
 *     slash, a lower-case drive letter, or be garbage.
 *
 *  2. CANONICAL path (`CanonicalPath`) - the one agreed representation of an
 *     ABSOLUTE path: native separators, `.`/`..` resolved, no duplicate or
 *     trailing separators, upper-case drive letter, no `\\?\` prefix. It is
 *     produced ONLY by `canonicalizePath` and is what should be stored as a
 *     track's `sourcePath` (the `tracks.source_path` column). It keeps the
 *     original letter case (so it is still a path you can display and open).
 *
 *  3. COMPARISON KEY (`PathKey`) - a canonical path additionally case-folded
 *     when the file system ignores case (Windows). Use it - never the raw
 *     `sourcePath` - to ask "are these the same file?" or to key a Map/Set.
 *     It is for comparing only; it is not a path to open.
 *
 *  4. ABSOLUTE path in general - anything that starts at a drive/UNC root.
 *     Every filesystem operation in this package requires one and rejects
 *     relative paths outright, so nothing is ever silently resolved against
 *     the process's current directory.
 *
 * The domain's `TrackId` remains the identity of a track; none of the above
 * is an identity.
 *
 * All functions take an explicit `PathFlavor` (defaulting to the platform
 * this process runs on). The Windows rules are pure string logic built on
 * `node:path/win32`, so they behave identically - and are tested - on any
 * host; only the actual disk access in `NodeFileSystem` needs real Windows.
 */
export type PathFlavor = 'win32' | 'posix';

export const NATIVE_PATH_FLAVOR: PathFlavor = process.platform === 'win32' ? 'win32' : 'posix';

declare const canonicalPathBrand: unique symbol;
/** An absolute path in canonical form. Only `canonicalizePath` creates one. */
export type CanonicalPath = string & { readonly [canonicalPathBrand]: true };

declare const pathKeyBrand: unique symbol;
/** A case-folded canonical path used purely for equality/lookup. */
export type PathKey = string & { readonly [pathKeyBrand]: true };

function invalid(input: unknown, reason: string): FileSystemError {
  return new FileSystemError('invalid-path', `Invalid path (${reason}): ${typeof input === 'string' ? input : String(input)}`, {
    path: typeof input === 'string' ? input : String(input),
  });
}

// Characters Windows forbids in a path segment (':' only appears in the
// drive prefix, which is handled separately - a ':' inside a segment would
// be an NTFS alternate data stream, e.g. "song.mp3:stream").
const WIN32_ILLEGAL_SEGMENT_CHARS = /[<>:"|?*]/;
const WIN32_RESERVED_DEVICE_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;

function canonicalizeWin32(input: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(input)) throw invalid(input, 'contains a control character');

  // Extended-length prefixes are unwrapped BEFORE normalisation so that
  // `..` can never eat into the drive or server/share portion.
  let raw = input;
  if (raw.startsWith('\\\\?\\')) {
    const rest = raw.slice(4);
    if (/^UNC\\/i.test(rest)) raw = `\\\\${rest.slice(4)}`;
    else if (/^[A-Za-z]:\\/.test(rest)) raw = rest;
    else throw invalid(input, 'device and volume-GUID paths are not supported');
  }

  // win32.normalize converts '/' to '\', collapses duplicate separators and
  // resolves '.' and '..' (clamping at the root, as the OS does).
  const normalized = win32.normalize(raw);
  if (normalized.startsWith('\\\\?\\') || normalized.startsWith('\\\\.\\')) {
    throw invalid(input, 'device paths are not supported');
  }

  const root = win32.parse(normalized).root;
  const drive = /^([A-Za-z]):\\$/.exec(root);
  const isUnc = /^\\\\[^\\]+\\[^\\]+\\$/.test(root);
  if (drive === null && !isUnc) {
    throw invalid(input, 'not absolute - needs a drive letter (C:\\...) or a UNC share (\\\\server\\share\\...)');
  }

  const segments = normalized
    .slice(root.length)
    .split('\\')
    .filter((segment) => segment.length > 0);
  for (const segment of segments) {
    if (WIN32_ILLEGAL_SEGMENT_CHARS.test(segment)) throw invalid(input, `"${segment}" contains a character Windows does not allow`);
    if (/[. ]$/.test(segment)) throw invalid(input, `"${segment}" ends with a dot or space, which Windows silently strips`);
    if (WIN32_RESERVED_DEVICE_NAME.test(segment)) throw invalid(input, `"${segment}" is a reserved Windows device name`);
  }

  const canonicalRoot = drive !== null ? `${(drive[1] as string).toUpperCase()}:\\` : root;
  return canonicalRoot + segments.join('\\');
}

function canonicalizePosix(input: string): string {
  if (input.includes('\0')) throw invalid(input, 'contains a NUL character');
  if (!input.startsWith('/')) throw invalid(input, 'not absolute - must start with "/"');
  const normalized = posix.normalize(input);
  return normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

/**
 * Turns an untrusted absolute path into its canonical form, or throws
 * `FileSystemError('invalid-path')`. Purely lexical: it does not touch the
 * disk, so it neither resolves symlinks/junctions nor learns the real letter
 * case of existing folders (see `FileSystem.realPath` for that).
 *
 * Rejected on purpose rather than "fixed up": relative paths, drive-relative
 * (`C:foo`) and rooted-without-drive (`\foo`) paths, device paths, illegal
 * characters, reserved device names (`NUL`, `COM1`, ...) and segments ending
 * in a dot or space. Fixing them silently could map two different strings
 * onto one file, or one string onto a file the user never meant.
 *
 * Idempotent: canonicalising a canonical path returns it unchanged.
 */
export function canonicalizePath(input: string, flavor: PathFlavor = NATIVE_PATH_FLAVOR): CanonicalPath {
  if (typeof input !== 'string' || input.length === 0) throw invalid(input, 'must be a non-empty string');
  return (flavor === 'win32' ? canonicalizeWin32(input) : canonicalizePosix(input)) as CanonicalPath;
}

/**
 * The key to use when asking "is this the same file path?". Windows paths
 * compare case-insensitively, so they are lower-cased; POSIX paths are not.
 * Limitation: this uses JavaScript's Unicode lower-casing, which is not
 * byte-identical to NTFS's own case table for a handful of exotic
 * characters; it is exact for ordinary (and all ASCII) names.
 */
export function pathComparisonKey(input: string, flavor: PathFlavor = NATIVE_PATH_FLAVOR): PathKey {
  const canonical = canonicalizePath(input, flavor);
  return (flavor === 'win32' ? canonical.toLowerCase() : canonical) as PathKey;
}

/**
 * True when `candidate` is `root` itself or lies beneath it. Decided on
 * path SEGMENTS via `path.relative` - never by a string-prefix test, which
 * would wrongly accept `C:\Music2` as inside `C:\Music`. Case-insensitive on
 * Windows, and it understands different drives/shares.
 *
 * This is purely lexical: it cannot see symlinks or junctions, so a link
 * inside `root` that points elsewhere still counts as "inside". Code that
 * must not follow links (the Phase 2E scanner) has to check entry kinds.
 */
export function isPathWithin(root: string, candidate: string, flavor: PathFlavor = NATIVE_PATH_FLAVOR): boolean {
  const pathModule = flavor === 'win32' ? win32 : posix;
  const relative = pathModule.relative(canonicalizePath(root, flavor), canonicalizePath(candidate, flavor));
  if (relative === '') return true;
  if (pathModule.isAbsolute(relative)) return false; // different drive / share
  return relative !== '..' && !relative.startsWith(`..${pathModule.sep}`);
}

/**
 * Resolves `relativePath` against `root` and guarantees the result is
 * inside `root`: an absolute/rooted/drive-qualified `relativePath`, or one
 * whose `..` segments climb out of the root, throws (`invalid-path` /
 * `outside-root`). Segments that dip and come back (`a/../b`) are fine.
 * An empty `relativePath` is `root` itself. Lexical only - see
 * `isPathWithin` for the symlink caveat.
 */
export function resolveWithin(root: string, relativePath: string, flavor: PathFlavor = NATIVE_PATH_FLAVOR): CanonicalPath {
  const pathModule = flavor === 'win32' ? win32 : posix;
  const canonicalRoot = canonicalizePath(root, flavor);

  if (typeof relativePath !== 'string') throw invalid(relativePath, 'relative path must be a string');
  const looksAbsolute =
    pathModule.isAbsolute(relativePath) || relativePath.startsWith('/') || (flavor === 'win32' && /^[A-Za-z]:/.test(relativePath));
  if (looksAbsolute) throw invalid(relativePath, 'must be relative to the root, not absolute');

  const resolved = canonicalizePath(pathModule.join(canonicalRoot, relativePath), flavor);
  if (!isPathWithin(canonicalRoot, resolved, flavor)) {
    throw new FileSystemError('outside-root', `Path escapes its root: "${relativePath}" is not inside ${canonicalRoot}`, {
      path: relativePath,
    });
  }
  return resolved;
}
