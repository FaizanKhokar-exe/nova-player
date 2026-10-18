import { protocol } from 'electron';
import { handleNovaMediaRequest, type NovaMediaProtocolOptions } from './media/handle-media-request.js';
import { NOVA_MEDIA_SCHEME } from './media/media-url.js';

/**
 * The `nova-media://` protocol: the ONE way audio bytes reach the renderer.
 *
 * Phase 4 turned it from a fixtures-only spike into the library's media
 * boundary without adding a second mechanism:
 *  - `nova-media://track/<TrackId>` - an opaque id; the main process resolves
 *    it to a file inside a currently registered library folder (see
 *    `media/media-access.ts`) or refuses.
 *  - `nova-media://local/<path>` - the Phase 0 spike shape, served only from an
 *    explicit `allowedRoots` list (the fixtures folder in development builds).
 * HTTP semantics (Range/206/416/HEAD) live in `media/serve-media-file.ts`.
 */
export { NOVA_MEDIA_SCHEME } from './media/media-url.js';
export { buildNovaMediaUrl, buildTrackMediaUrl, parseNovaMediaUrl, type ParsedMediaUrl } from './media/media-url.js';
export { parseByteRange, type ByteRangeResult } from './media/byte-range.js';
export { handleNovaMediaRequest, type NovaMediaProtocolOptions, type NovaMediaRequestInfo } from './media/handle-media-request.js';

/**
 * Must be called synchronously at module load time, before `app.whenReady()`.
 * This is an Electron requirement for privileged custom schemes, not a
 * stylistic choice - registering it later is silently ineffective.
 *
 * `stream: true` + `supportFetchAPI: true` let the renderer treat this as a
 * normal fetchable/streamable origin. Range/206 semantics are NOT inherited
 * from these privileges or from delegating to net.fetch (Phase 0 proved
 * net.fetch() on a file:// URL does not set 206/Content-Range/Accept-Ranges);
 * they are implemented by hand in `serveMediaFile`.
 */
export function registerNovaMediaSchemeAsPrivileged(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: NOVA_MEDIA_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        stream: true,
        supportFetchAPI: true,
        bypassCSP: false,
        // Phase 11: true so the renderer's CORS-enabled <audio> (Web Audio analyser) may read the media; every
        // response carries the matching headers (see `media/cors.ts` for why that is safe). All other privileges unchanged.
        corsEnabled: true,
      },
    },
  ]);
}

/** Must be called after `app.whenReady()`. */
export function registerNovaMediaProtocolHandler(options: NovaMediaProtocolOptions): void {
  protocol.handle(NOVA_MEDIA_SCHEME, (request) => handleNovaMediaRequest(request, options));
}
