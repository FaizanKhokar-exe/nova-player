import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { promisify } from 'node:util';
import { canonicalizePath, pathComparisonKey } from '../filesystem/path-policy.js';

// The callback form is the only one with `.native`, which asks the OS for the true spelling (the same call
// the file-system layer's `realPath` makes - the path that was authorized was produced by it).
const realpathNative = promisify(fs.realpath.native);

/** `O_NONBLOCK` makes opening a named pipe return at once instead of waiting for a writer that may never come
 *  (it changes nothing for a regular file). `O_NOFOLLOW` refuses a final path component that is now a link.
 *  Windows defines neither; there the flags are simply 0. */
const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOFOLLOW ?? 0);

export type OpenRefusal =
  /** Nothing is there (any more). */
  | 'missing'
  | 'forbidden'
  /** What was opened is not (or no longer provably) the file that was authorized: a link or swap got in the way. */
  | 'changed'
  /** A directory, pipe, device ... */
  | 'not-a-file'
  | 'failed';

export type OpenOutcome =
  | { readonly ok: true; readonly handle: fsPromises.FileHandle; readonly size: number }
  | { readonly ok: false; readonly refusal: OpenRefusal };

function errnoOf(error: unknown): string | undefined {
  const code = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : undefined;
}

function refusalForErrno(error: unknown): OpenRefusal {
  switch (errnoOf(error)) {
    case 'ENOENT':
    case 'ENOTDIR':
      return 'missing';
    case 'EACCES':
    case 'EPERM':
      return 'forbidden';
    case 'ELOOP':
      return 'changed';
    default:
      return 'failed';
  }
}

/**
 * Opens an ALREADY-AUTHORIZED regular file and proves that what was opened is what was authorized.
 *
 * Authorization (`MediaAccess.resolveTrack`) checks a path, and the file is opened a moment later, so a
 * local attacker who can write inside a library folder could swap a folder or the file for a link in
 * between (time of check / time of use). A path can never be made race-free by checking it again, but the
 * OPEN FILE can be compared with the path afterwards:
 *
 *  1. open with `O_NOFOLLOW` (a link at the last component is refused) and `O_NONBLOCK` (a pipe cannot hang the open);
 *  2. the open handle must be a regular file;
 *  3. when `verifyStable`, the authorized path must STILL resolve to itself (no link has been spliced into any
 *     component), and the file at that path must be the very file that is open (same device and file id).
 *     A link swapped in and then removed again before step 3 cannot satisfy the second half: the open handle
 *     is the wrong file.
 *
 * `filePath` is expected to be the real path `resolveTrack` returned, so "resolves to itself" means "still inside
 * the library folder that was authorized". What this does not cover: a hard link or a bind mount that was
 * created inside the library folder on purpose (that requires the same write access and gives no more than
 * reading the original); and real Windows junction behaviour, which has not been verified.
 */
export async function openAuthorizedFile(filePath: string, options: { readonly verifyStable: boolean }): Promise<OpenOutcome> {
  let handle: fsPromises.FileHandle;
  try {
    handle = await fsPromises.open(filePath, OPEN_FLAGS);
  } catch (error) {
    return { ok: false, refusal: refusalForErrno(error) };
  }

  const refuse = async (refusal: OpenRefusal): Promise<OpenOutcome> => {
    await handle.close().catch(() => undefined);
    return { ok: false, refusal };
  };

  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile()) return await refuse('not-a-file');

    if (options.verifyStable) {
      const expectedKey = pathComparisonKey(canonicalizePath(filePath));
      const resolved = canonicalizePath(await realpathNative(filePath));
      if (pathComparisonKey(resolved) !== expectedKey) return await refuse('changed');
      const atPath = await fsPromises.stat(resolved, { bigint: true });
      if (atPath.dev !== opened.dev || atPath.ino !== opened.ino) return await refuse('changed');
    }
    return { ok: true, handle, size: Number(opened.size) };
  } catch (error) {
    return refuse(refusalForErrno(error));
  }
}
