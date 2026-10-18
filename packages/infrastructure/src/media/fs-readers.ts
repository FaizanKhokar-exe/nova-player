import fs from 'node:fs';
import { open } from 'node:fs/promises';

/** `O_NONBLOCK`: opening a named pipe must not wait for a writer that may never come (no effect on a regular
 *  file). `O_NOFOLLOW`: the callers pass a path that was already resolved to its real location, so a link at the
 *  last component now means it was swapped in after that check, and it is refused. Windows has neither flag; there
 *  both are 0. */
const READ_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOFOLLOW ?? 0);

/**
 * Reads at most `maxBytes` of a REGULAR file (never the whole of an oversized one). A pipe, device or
 * directory is refused instead of being read: a sidecar that is a named pipe would otherwise block the read
 * (and with it the lyrics lookup) forever.
 */
export async function readFileBounded(path: string, maxBytes: number): Promise<Uint8Array> {
  const handle = await open(path, READ_FLAGS);
  try {
    if (!(await handle.stat()).isFile()) throw new Error('not a regular file');
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0);
    if (bytesRead > maxBytes) throw new Error('file too large');
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
