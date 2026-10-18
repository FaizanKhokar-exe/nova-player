import { Readable } from 'node:stream';
import { parseByteRange } from './byte-range.js';
import { MEDIA_CORS_HEADERS } from './cors.js';
import { openAuthorizedFile, type OpenRefusal } from './verified-open.js';

export interface ServeMediaFileOptions {
  /** A path that has ALREADY been authorized. This function does not decide access. */
  readonly filePath: string;
  readonly contentType: string;
  /**
   * Phase 8: after opening, prove that the open file is still the one that was authorized (no link was
   * spliced into the path between the authorization and the open - see `openAuthorizedFile`). Library
   * tracks always set this; it is off by default because callers other than the media protocol hand in a
   * path that was not produced by `MediaAccess` (so "the path still resolves to itself" does not apply).
   */
  readonly verifyStable?: boolean;
}

const BASE_HEADERS = {
  'Accept-Ranges': 'bytes',
  // The file can change under us (a rescan, a re-tag) and no validators are
  // sent, so a cached copy must never be reused without asking again.
  'Cache-Control': 'no-cache',
  'X-Content-Type-Options': 'nosniff',
  ...MEDIA_CORS_HEADERS,
} as const;

function text(status: number, body: string, extra: Record<string, string> = {}): Response {
  // Like a protocol refusal, a failure to open the file describes the moment and must never be cached.
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...MEDIA_CORS_HEADERS, ...extra } });
}

/** How a refused open is answered. `changed` is reported as `outside-root`: what is at the path is no longer
 *  what was authorized (a link or swap got in the way), the same answer the up-front containment check gives. */
function refusalFor(refusal: OpenRefusal): Response {
  switch (refusal) {
    case 'missing':
    case 'not-a-file':
      return text(404, 'Not Found');
    case 'forbidden':
      return text(403, 'Forbidden');
    case 'changed':
      return text(403, 'Forbidden', { 'X-Nova-Media-Denial': 'outside-root' });
    case 'failed':
      return text(500, 'The file could not be opened');
  }
}

/**
 * Serves one already-authorized file with real HTTP semantics (the part
 * Phase 0 proved `net.fetch(file://)` does not provide):
 *
 *  - GET and HEAD only (HEAD gets the GET headers and no body); anything else
 *    is 405 with `Allow`.
 *  - 200 with the whole file when there is no (usable) `Range`.
 *  - 206 with `Content-Range` for a satisfiable single range; 416 with
 *    `Content-Range: bytes * /size` for an unsatisfiable one; a multi-range or
 *    non-byte Range is answered with the whole file (RFC permitted).
 *  - A `Range` accompanied by `If-Range` is ignored: no validator (ETag/date)
 *    is ever issued, so a conforming client cannot hold a matching one.
 *  - The file is opened FIRST, so "vanished" (404) and "no access" (403) are
 *    real statuses, not a broken 200 body; and it is streamed from the open
 *    handle in chunks - never read into memory - and closed when the body
 *    ends, is cancelled, or is never read.
 */
export async function serveMediaFile(request: Request, options: ServeMediaFileOptions): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return text(405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
  }
  const isHead = request.method === 'HEAD';

  // Phase 8: opened WITHOUT following a link at the last component and without ever blocking on a pipe, then
  // checked to be a regular file and (for library tracks) to still be the file that was authorized.
  const opened = await openAuthorizedFile(options.filePath, { verifyStable: options.verifyStable === true });
  if (!opened.ok) return refusalFor(opened.refusal);
  const { handle, size } = opened;

  const rangeHeader = request.headers.get('range');
  const useRange = rangeHeader !== null && request.headers.get('if-range') === null;
  const parsed = useRange ? parseByteRange(rangeHeader, size) : ({ kind: 'unsupported' } as const);

  if (parsed.kind === 'unsatisfiable') {
    await handle.close();
    return new Response(null, { status: 416, headers: { ...BASE_HEADERS, 'Content-Range': `bytes */${size}` } });
  }

  const partial = parsed.kind === 'single';
  const start = partial ? parsed.start : 0;
  const end = partial ? parsed.end : size - 1;
  const length = size === 0 ? 0 : end - start + 1;

  const headers: Record<string, string> = {
    ...BASE_HEADERS,
    'Content-Type': options.contentType,
    'Content-Length': String(length),
    ...(partial && { 'Content-Range': `bytes ${start}-${end}/${size}` }),
  };
  const status = partial ? 206 : 200;

  if (isHead || length === 0) {
    await handle.close();
    return new Response(null, { status, headers });
  }

  // The stream owns the handle from here: it closes it at end/error/cancel.
  const stream = handle.createReadStream({ start, end, autoClose: true });
  return new Response(Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>, { status, headers });
}
