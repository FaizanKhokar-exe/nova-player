import path from 'node:path';
import { isPathWithin } from '../filesystem/path-policy.js';
import { MEDIA_CORS_HEADERS, preflightResponse } from './cors.js';
import { contentTypeForFile, type MediaAccess, type MediaDenial } from './media-access.js';
import { parseNovaMediaUrl } from './media-url.js';
import { serveMediaFile } from './serve-media-file.js';

export interface NovaMediaRequestInfo {
  /** `track/<id>` for a library request (never a file path); the requested path for a spike request. */
  requestedPath: string;
  rangeHeader: string | null;
  allowed: boolean;
  responseStatus?: number;
  /** Set when access was refused, with the reason (never a path). */
  denial?: MediaDenial | 'invalid-url' | 'outside-allowed-roots' | 'internal-error';
}

export interface NovaMediaProtocolOptions {
  /**
   * Decides which library tracks may be heard (see `createMediaAccess`). It
   * is asked on every request, against the CURRENT registered library roots.
   * Without it, no `nova-media://track/...` request is served.
   */
  mediaAccess?: MediaAccess;
  /**
   * Phase 0 spike only: absolute directories that `nova-media://local/<path>`
   * may serve. Empty/omitted means that URL shape serves nothing. The desktop
   * app passes the test-fixtures folder in a development build only.
   */
  allowedRoots?: readonly string[];
  onRequest?: (info: NovaMediaRequestInfo) => void;
  /**
   * Phase 8: receives an UNEXPECTED failure (a database or file-system fault that is not a normal refusal)
   * with its full detail, for the log. The caller of the protocol only ever sees a bare 500. A throwing
   * sink is ignored: reporting must never turn the refusal back into a rejected request.
   */
  onError?: (error: unknown) => void;
}

/** How each refusal is reported over HTTP. */
const DENIAL_STATUS: Readonly<Record<MediaDenial, number>> = {
  'invalid-id': 400,
  'track-not-found': 404,
  'root-not-registered': 403,
  'root-unavailable': 503,
  'root-changed': 403,
  'outside-root': 403,
  'file-missing': 404,
  'file-inaccessible': 403,
  'not-a-file': 404,
  'unsupported-format': 415,
};

const STATUS_TEXT: Readonly<Record<number, string>> = {
  400: 'Bad Request',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  500: 'Internal Server Error',
  415: 'Unsupported Media Type',
  503: 'Service Unavailable',
};

function refusal(status: number, reason: string): Response {
  return new Response(STATUS_TEXT[status] ?? 'Error', {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Nova-Media-Denial': reason,
      // A refusal describes the moment, not the file: the drive may be plugged back in a second
      // later. Without this Chromium's media cache replays the failure for the same URL
      // (found by the E2E "unplugged drive, then retry" scenario).
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...MEDIA_CORS_HEADERS,
      ...(status === 405 && { Allow: 'GET, HEAD' }),
    },
  });
}

/**
 * The request-handling logic behind `protocol.handle`, kept free of Electron
 * so it can be driven in unit tests with plain `Request` objects.
 *
 * Order of decisions: method -> URL shape -> authorization -> serving. A
 * request that fails an earlier step never reaches a later one, and the file
 * system is only touched after authorization succeeded.
 */
export async function handleNovaMediaRequest(request: Request, options: NovaMediaProtocolOptions): Promise<Response> {
  try {
    return await decideAndServe(request, options);
  } catch (error) {
    // An unexpected fault (closed database, a file-system error that is not a refusal) must not reach
    // Chromium as a rejected protocol handler: it is logged with detail, and answered with a bare 500.
    try {
      options.onError?.(error);
    } catch {
      // nothing sensible is left to do
    }
    const response = refusal(500, 'internal-error');
    try {
      options.onRequest?.({ requestedPath: '', rangeHeader: request.headers.get('range'), allowed: false, responseStatus: 500, denial: 'internal-error' });
    } catch {
      // as above
    }
    return response;
  }
}

async function decideAndServe(request: Request, options: NovaMediaProtocolOptions): Promise<Response> {
  const rangeHeader = request.headers.get('range');
  const finish = (response: Response, info: Omit<NovaMediaRequestInfo, 'rangeHeader' | 'responseStatus'>): Response => {
    options.onRequest?.({ ...info, rangeHeader, responseStatus: response.status });
    return response;
  };

  if (request.method === 'OPTIONS') return finish(preflightResponse(), { requestedPath: '', allowed: true });

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return finish(refusal(405, 'method-not-allowed'), { requestedPath: '', allowed: false });
  }

  const parsed = parseNovaMediaUrl(request.url);

  if (parsed.kind === 'invalid') {
    return finish(refusal(400, `invalid-url:${parsed.reason}`), { requestedPath: '', allowed: false, denial: 'invalid-url' });
  }

  if (parsed.kind === 'track') {
    const requestedPath = `track/${parsed.trackId}`;
    if (options.mediaAccess === undefined) {
      return finish(refusal(403, 'track-media-not-configured'), { requestedPath, allowed: false, denial: 'root-not-registered' });
    }
    const resolution = await options.mediaAccess.resolveTrack(parsed.trackId);
    if (!resolution.ok) {
      return finish(refusal(DENIAL_STATUS[resolution.denial], resolution.denial), { requestedPath, allowed: false, denial: resolution.denial });
    }
    const response = await serveMediaFile(request, { filePath: resolution.filePath, contentType: resolution.contentType, verifyStable: true });
    return finish(response, { requestedPath, allowed: true });
  }

  // `local/<path>`: the fixed-allowlist spike shape.
  const roots = (options.allowedRoots ?? []).map((root) => path.resolve(root));
  const requestedPath = path.resolve(parsed.path);
  const allowed = roots.some((root) => {
    try {
      return isPathWithin(root, requestedPath);
    } catch {
      return false; // a path the policy cannot even read is not allowed: fail closed
    }
  });
  if (!allowed) {
    return finish(refusal(403, 'outside-allowed-roots'), { requestedPath, allowed: false, denial: 'outside-allowed-roots' });
  }
  const contentType = contentTypeForFile(requestedPath);
  if (contentType === undefined) {
    return finish(refusal(415, 'unsupported-format'), { requestedPath, allowed: false, denial: 'unsupported-format' });
  }
  const response = await serveMediaFile(request, { filePath: requestedPath, contentType });
  return finish(response, { requestedPath, allowed: true });
}
