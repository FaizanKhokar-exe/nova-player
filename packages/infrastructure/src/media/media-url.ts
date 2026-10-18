import { parseTrackId, type TrackId } from '@nova/domain';

export const NOVA_MEDIA_SCHEME = 'nova-media';

/** Host of the library-track URL shape: `nova-media://track/<TrackId>`. */
export const TRACK_MEDIA_HOST = 'track';
/** Host of the Phase 0 spike URL shape: `nova-media://local/<absolute path>`. */
export const LOCAL_MEDIA_HOST = 'local';

/** The only query a track URL may carry is `?v=<1-9 digits>`: a cache key, never data (see below). */
export const MAX_SOURCE_VERSION = 999_999_999;

/**
 * The renderer-facing address of a library track. It is derived from the
 * track's opaque identity only - never from its path - so handing it to an
 * <audio> element teaches the renderer nothing about the file system, and
 * knowing it grants nothing the main process does not independently decide.
 *
 * `version` exists for one reason: Chromium's media layer remembers a FAILED
 * load per URL, so after a failure (a drive was unplugged, then reconnected)
 * retrying the identical URL is answered from that memory without ever asking
 * the main process again. Main therefore hands out the same track under a new
 * `?v=N` after it diagnoses a failure. The number carries no meaning and is
 * ignored when serving; version 0 has no query at all.
 */
export function buildTrackMediaUrl(trackId: TrackId, version = 0): string {
  const base = `${NOVA_MEDIA_SCHEME}://${TRACK_MEDIA_HOST}/${trackId}`;
  return version > 0 ? `${base}?v=${Math.min(Math.floor(version), MAX_SOURCE_VERSION)}` : base;
}

/** The Phase 0 spike's path-based URL. Servable only from the fixed
 *  `allowedRoots` the protocol was configured with (the fixtures folder in a
 *  development build; nothing in a packaged one). */
export function buildNovaMediaUrl(absoluteFilePath: string): string {
  return `${NOVA_MEDIA_SCHEME}://${LOCAL_MEDIA_HOST}${encodeURIComponent(absoluteFilePath).replace(/%2F/g, '/')}`;
}

export type MediaUrlRejection =
  | 'unparseable'
  | 'wrong-scheme'
  | 'unknown-host'
  | 'credentials-or-port'
  | 'query-or-fragment'
  | 'invalid-track-id'
  | 'malformed-path';

export type ParsedMediaUrl =
  | { readonly kind: 'track'; readonly trackId: TrackId; readonly version: number }
  | { readonly kind: 'local'; readonly path: string }
  | { readonly kind: 'invalid'; readonly reason: MediaUrlRejection };

/**
 * Total: never throws, whatever string it is given. The accepted shapes are
 * exactly the two builders above; everything else is `invalid` and the
 * protocol answers 400. In particular a track URL must be `/<TrackId>` and
 * nothing else - no extra segments, no fragment, no credentials, no port, no
 * percent-encoded tricks (the id is validated AFTER the URL is parsed, and a
 * valid TrackId contains no character that needs encoding) - and its only
 * permitted query is exactly `?v=<1-9 digits>`, the cache key described on
 * `buildTrackMediaUrl`. Every other query is invalid.
 */
export function parseNovaMediaUrl(rawUrl: string): ParsedMediaUrl {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { kind: 'invalid', reason: 'unparseable' };
  }
  if (url.protocol !== `${NOVA_MEDIA_SCHEME}:`) return { kind: 'invalid', reason: 'wrong-scheme' };
  if (url.username !== '' || url.password !== '' || url.port !== '') return { kind: 'invalid', reason: 'credentials-or-port' };
  if (url.hash !== '') return { kind: 'invalid', reason: 'query-or-fragment' };

  if (url.hostname === TRACK_MEDIA_HOST) {
    let version = 0;
    if (url.search !== '') {
      const versionMatch = /^\?v=(\d{1,9})$/.exec(url.search);
      if (versionMatch?.[1] === undefined) return { kind: 'invalid', reason: 'query-or-fragment' };
      version = Number(versionMatch[1]);
    }
    const match = /^\/([^/]+)$/.exec(url.pathname);
    const id = match?.[1] === undefined ? undefined : parseTrackId(match[1]);
    return id === undefined ? { kind: 'invalid', reason: 'invalid-track-id' } : { kind: 'track', trackId: id, version };
  }

  if (url.search !== '') return { kind: 'invalid', reason: 'query-or-fragment' };

  if (url.hostname === LOCAL_MEDIA_HOST) {
    try {
      return { kind: 'local', path: decodeURIComponent(url.pathname) };
    } catch {
      return { kind: 'invalid', reason: 'malformed-path' };
    }
  }

  return { kind: 'invalid', reason: 'unknown-host' };
}
