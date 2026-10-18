/**
 * CORS for `nova-media://` (Phase 11). The renderer's audio spectrum connects the <audio> element to a Web Audio
 * `AnalyserNode`, and for that the element must be CORS-enabled (`crossOrigin = 'anonymous'`); otherwise a
 * cross-origin media element is "tainted" and its samples read as silence. The page's origin (the app page) and
 * `nova-media://` are different origins, so every response carries the headers that make the load CORS-clean.
 *
 * Why a wildcard origin is acceptable here: the scheme exists only inside this application's own session, so no
 * web page can address it; it resolves only unguessable track ids (UUIDs) of files inside currently registered
 * library folders (see `media-access.ts`), or the dev-only fixtures; and the app page's Content-Security-Policy
 * decides which documents/frames/scripts can reference it at all. `*` also cannot be combined with credentials, and
 * none are ever sent. Nothing here widens WHICH files are served - only whether the page may read what it already
 * is allowed to play.
 */
export const MEDIA_CORS_HEADERS: Readonly<Record<string, string>> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

/** The answer to a CORS preflight (`OPTIONS`): no body, nothing about any file, so it needs no authorization. */
export function preflightResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...MEDIA_CORS_HEADERS,
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Range',
      'Access-Control-Max-Age': '600',
      'Cache-Control': 'no-store',
    },
  });
}
