import { copyFile, rename, rm, writeFile } from 'node:fs/promises';
import { LRCLIB_HOST, type FetchText } from '@nova/infrastructure';

/** The minimal slice of Electron's `net.fetch` this module needs (so it can be tested with a fake). */
export type NetFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal; redirect: 'error' }) => Promise<{ status: number; body: ReadableStream<Uint8Array> | null }>;

/**
 * The one network port of the application: HTTPS GET, host pinned to LRCLIB, no redirects followed
 * (a redirect elsewhere is an error, not a detour), a hard timeout and a hard size cap.
 */
export function createPinnedFetchText(netFetch: NetFetch): FetchText {
  return async (url, init) => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== LRCLIB_HOST) throw new Error('host not allowed');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), init.timeoutMs);
    try {
      const response = await netFetch(parsed.toString(), { headers: init.headers, signal: controller.signal, redirect: 'error' });
      if (response.body === null) return { status: response.status, text: '' };
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > init.maxBytes) {
          await reader.cancel();
          throw new Error('response too large');
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return { status: response.status, text: new TextDecoder('utf-8').decode(bytes) };
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Writes `bytes` to `target` via a temp file + rename, first copying an existing `target` to `<target>.bak`. */
export async function writeLrcAtomic(target: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${target}.nova-tmp`;
  try {
    await copyFile(target, `${target}.bak`).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    await writeFile(temporary, bytes, { flag: 'w' });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
