import { parseFile } from 'music-metadata';
import type { RawTrackMetadata } from '@nova/domain';
import { toFileSystemError } from '../filesystem/file-system-error.js';
import { canonicalizePath } from '../filesystem/path-policy.js';

/**
 * The outcome of reading one media file's tags. There are three distinct
 * outcomes and they are kept distinct on purpose:
 *
 *  - `ok`: the file is audio `music-metadata` understands. `metadata` is the
 *    domain-owned `RawTrackMetadata` (possibly with no tags at all - an
 *    untagged but valid file is fine; the DOMAIN then falls back to the
 *    file name).
 *  - `unreadable`: the bytes are not usable audio (corrupt, truncated,
 *    not really the type the extension claims, or a format the parser does
 *    not support). The caller must NOT turn this into a track.
 *  - a thrown `FileSystemError`: the file could not be opened at all
 *    (missing, permission denied, is a directory, ...). That is a problem
 *    with the disk, not with the media.
 */
export type MetadataReadResult =
  | { readonly status: 'ok'; readonly metadata: RawTrackMetadata }
  | { readonly status: 'unreadable'; readonly reason: string };

/** The metadata-reading boundary. Only domain types appear in it. */
export interface MetadataReader {
  /** @throws FileSystemError when the file itself cannot be read (`invalid-path`, `not-found`, `access-denied`, `not-a-file`, `io-error`). */
  read(filePath: string): Promise<MetadataReadResult>;
}

/** Errno-style codes ("ENOENT", "EACCES", ...) mean the OS refused the read,
 *  as opposed to the parser rejecting the bytes. */
function isOperatingSystemError(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^E[A-Z0-9]+$/.test(code);
}

/**
 * The only place in the codebase that speaks to `music-metadata`. It maps
 * the library's output onto `RawTrackMetadata` and does NOTHING else: no
 * trimming, no fallbacks, no title/artist guessing - all of that is the
 * domain's `createTrack`, so swapping the tag library never changes it.
 */
export function createMusicMetadataReader(): MetadataReader {
  return {
    async read(filePath) {
      const canonical = canonicalizePath(filePath);

      let parsed: Awaited<ReturnType<typeof parseFile>>;
      try {
        parsed = await parseFile(canonical);
      } catch (error) {
        if (isOperatingSystemError(error)) throw toFileSystemError(error, canonical, 'stat');
        return { status: 'unreadable', reason: error instanceof Error ? error.message : String(error) };
      }

      // `parseFile` happily "succeeds" on garbage, empty files and
      // tags-without-audio, returning an object with no audio format at all.
      // Treating that as a valid (empty) track is exactly the silent
      // corruption the scanner must avoid, so "no audio format detected" is
      // an unreadable file.
      const { format, common } = parsed;
      if (format.container === undefined && format.codec === undefined) {
        return { status: 'unreadable', reason: 'No audio stream was detected in this file.' };
      }

      const genre = (common.genre ?? []).filter((g) => g.trim().length > 0).join(', ');
      const metadata: RawTrackMetadata = {
        ...(common.title !== undefined && { title: common.title }),
        ...(common.artist !== undefined && { artist: common.artist }),
        ...(common.album !== undefined && { album: common.album }),
        ...(common.albumartist !== undefined && { albumArtist: common.albumartist }),
        ...(genre.length > 0 && { genre }),
        ...(common.track.no !== null && { trackNumber: common.track.no }),
        ...(common.disk.no !== null && { discNumber: common.disk.no }),
        ...(common.year !== undefined && { year: common.year }),
        // Seconds, exactly as the domain's `durationSeconds` expects.
        ...(format.duration !== undefined && { durationSeconds: format.duration }),
        hasEmbeddedArtwork: (common.picture?.length ?? 0) > 0,
      };
      return { status: 'ok', metadata };
    },
  };
}

/** The first embedded picture of an audio file (tags only; the audio is not decoded). Phase 6 artwork. */
export async function readEmbeddedPicture(path: string): Promise<{ mimeType: string; data: Uint8Array } | undefined> {
  const metadata = await parseFile(path, { duration: false, skipPostHeaders: true });
  const picture = metadata.common.picture?.[0];
  return picture === undefined ? undefined : { mimeType: picture.format, data: picture.data };
}
