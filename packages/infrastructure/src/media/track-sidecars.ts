import path from 'node:path';
import { parseLyrics, parseTrackId, type LibraryRootRepository, type LyricLine } from '@nova/domain';
import { FileSystemError } from '../filesystem/file-system-error.js';
import type { FileSystem } from '../filesystem/file-system.js';
import { isPathWithin, type CanonicalPath } from '../filesystem/path-policy.js';
import type { MediaAccess } from './media-access.js';

/**
 * Per-track lyrics and artwork (Phase 6), found through the SAME door as the audio: the track's
 * file must already pass `MediaAccess.resolveTrack` (registered root, still the folder that was
 * registered, real path inside it, a real audio file). Nothing is looked up by a renderer-supplied
 * path, nothing is searched recursively, and no path is ever returned.
 *
 * LYRICS POLICY (deterministic, conservative): the sidecar of `<dir>/<name>.<audio ext>` is
 * `<dir>/<name>.lrc`; if that does not exist, `<dir>/<name>.LRC`. In that order, first hit wins.
 * The candidate's REAL path (links followed) must stay inside the track's real root - a `.lrc`
 * that is a link to a file elsewhere is ignored as if absent. Files over 1 MiB are `unreadable`.
 * Text is decoded as UTF-8 and parsed by the Phase 1D domain parser (`parseLyrics`); a BOM,
 * malformed lines and enhanced word timings are the parser's concern, not duplicated here.
 */

export const MAX_LYRICS_BYTES = 1024 * 1024;
export const MAX_ARTWORK_BYTES = 5 * 1024 * 1024;
/**
 * FOLDER COVER POLICY (Phase 11): when a file has no usable embedded picture, the cover is a picture in the SAME
 * folder named (any letter case) cover / folder / front / album / albumart / albumartsmall with the extension
 * .jpg / .jpeg / .png / .webp. Names are tried in that order, then extensions in that order; the first candidate that
 * is a real file, resolves (links followed) inside the track's registered root, is 1..MAX_ARTWORK_BYTES, and whose
 * CONTENT really is a JPEG / PNG / WebP wins. Nothing is searched recursively. (The scanner never produces
 * `artwork: 'external'`, so a track with only a folder cover still reports `artwork: 'none'` in its DTO; this lookup
 * is what finds the picture anyway.)
 */
export const FOLDER_COVER_NAMES: readonly string[] = ['cover', 'folder', 'front', 'album', 'albumart', 'albumartsmall'];
export const FOLDER_COVER_EXTENSIONS: readonly string[] = ['jpg', 'jpeg', 'png', 'webp'];

/** The image type of `bytes` judged by its first bytes (never by a name), or `undefined`. */
export function sniffImageType(bytes: Uint8Array): 'image/jpeg' | 'image/png' | 'image/webp' | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png';
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  return undefined;
}

const ARTWORK_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp'];

export type LyricsResult =
  | { readonly status: 'found'; readonly lines: readonly LyricLine[]; /** Present (true) only when these lyrics were attached by hand rather than found next to the file. */ readonly attached?: true }
  | { readonly status: 'empty' | 'none' | 'unavailable' | 'unreadable'; readonly lines: readonly [] };

/** What happened when the listener tried to attach a lyrics file to a track. */
export type AttachLyricsResult =
  | { readonly outcome: 'attached'; readonly lines: readonly LyricLine[] }
  | { readonly outcome: 'empty' | 'unreadable' | 'too-large' | 'unavailable' };

/** Where lyrics attached by hand are kept (the SQLite repository in the app; a fake in tests). */
export interface AttachedLyricsStore {
  get(trackId: string): string | undefined;
  /** `sourcePath` (main-only) is the file the text was read from, so later edits to it can be picked up. */
  set(trackId: string, lrcText: string, sourcePath?: string): void;
  delete(trackId: string): boolean;
  /** Where the attached text came from, when known. Optional so older stores / fakes keep working. */
  getSource?(trackId: string): string | undefined;
}

/** Pictures attached by hand (stored in the database). Optional: without it only embedded and folder covers are used. */
export interface CustomCoverStore {
  get(trackId: string): { readonly mimeType: string; readonly bytes: Uint8Array } | undefined;
  set(trackId: string, mimeType: string, bytes: Uint8Array): void;
  delete(trackId: string): boolean;
}

export type AttachArtworkResult = { readonly outcome: 'attached' } | { readonly outcome: 'not-an-image' | 'unreadable' | 'too-large' | 'unavailable' };

/**
 * Decodes the bytes of a lyrics file the way real-world `.lrc` files need: UTF-8 (with or without a BOM),
 * UTF-16 (detected by its BOM), and - because many older tools save plain ANSI with no BOM - Windows-1252
 * when the bytes are not valid UTF-8.
 */
export function decodeLyricsBytes(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3));
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    // Not valid UTF-8 and no BOM: an old ANSI file. Windows-1252 is what such files nearly always are.
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

export type ArtworkResult =
  | { readonly status: 'found'; readonly mimeType: string; readonly bytes: Uint8Array; /** True when this is a picture the listener attached by hand (it can be removed again). */ readonly custom?: true }
  | { readonly status: 'none' | 'unavailable' };

export class TrackSidecarError extends Error {
  readonly code: 'track-not-found' | 'invalid-id';
  constructor(code: 'track-not-found' | 'invalid-id', message: string) {
    super(message);
    this.name = 'TrackSidecarError';
    this.code = code;
  }
}

export interface TrackSidecars {
  /** @throws TrackSidecarError `invalid-id` | `track-not-found`; everything else is a status. */
  getLyrics(trackId: string): Promise<LyricsResult>;
  getArtwork(trackId: string): Promise<ArtworkResult>;
  /**
   * Attaches the lyrics file at `filePath` (a path main got from a native file dialog - never from the
   * renderer) to the track: the text is parsed, and when it holds at least one timed line it is COPIED
   * into the attached-lyrics store. @throws TrackSidecarError `invalid-id` | `track-not-found`.
   */
  attachLyricsFromFile(trackId: string, filePath: string): Promise<AttachLyricsResult>;
  /** Removes lyrics attached by hand (the sidecar file, if any, shows again). `true` when one was removed. */
  detachLyrics(trackId: string): Promise<boolean>;
  /** Attaches the picture at `filePath` (chosen in a dialog by main) as this track's cover. @throws TrackSidecarError `invalid-id` | `track-not-found`. */
  attachArtworkFromFile(trackId: string, filePath: string): Promise<AttachArtworkResult>;
  /** Removes a picture attached by hand (embedded / folder covers show again). `true` when one was removed. */
  detachArtwork(trackId: string): Promise<boolean>;
}

export interface TrackSidecarsDependencies {
  readonly mediaAccess: MediaAccess;
  readonly libraryRootRepository: Pick<LibraryRootRepository, 'list'>;
  readonly fileSystem: Pick<FileSystem, 'realPath' | 'statFile'> & Partial<Pick<FileSystem, 'readDirectory'>>;
  /** Reads a whole file; the implementation (not this service) must not read past `maxBytes`. */
  readonly readFile: (path: string, maxBytes: number) => Promise<Uint8Array>;
  /** The best embedded picture of an audio file, or `undefined`. */
  readonly readEmbeddedArtwork: (path: string) => Promise<{ readonly mimeType: string; readonly data: Uint8Array } | undefined>;
  /** Lyrics attached by hand. Without it (older callers, tests) only sidecar files are used. */
  readonly attachedLyrics?: AttachedLyricsStore;
  /** Pictures attached by hand. */
  readonly customCovers?: CustomCoverStore;
}

function stripExtension(filePath: string): string {
  const slash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  const dot = filePath.lastIndexOf('.');
  return dot > slash + 1 ? filePath.slice(0, dot) : filePath;
}

function inside(root: string, candidate: string): boolean {
  try {
    return isPathWithin(root, candidate);
  } catch {
    return false;
  }
}

export function createTrackSidecars(dependencies: TrackSidecarsDependencies): TrackSidecars {
  const { mediaAccess, libraryRootRepository, fileSystem, readFile, readEmbeddedArtwork, attachedLyrics, customCovers } = dependencies;

  async function resolve(rawId: string): Promise<{ filePath: CanonicalPath; realRoot: string } | 'unavailable'> {
    if (typeof rawId !== 'string' || parseTrackId(rawId) === undefined) throw new TrackSidecarError('invalid-id', 'That is not a valid track id.');
    const resolution = await mediaAccess.resolveTrack(rawId);
    if (!resolution.ok) {
      if (resolution.denial === 'track-not-found' || resolution.denial === 'invalid-id') {
        throw new TrackSidecarError('track-not-found', 'That track is not in the library.');
      }
      return 'unavailable';
    }
    // `resolveTrack` guarantees the registered root equals its real path, so the root that contains the real file is the real root.
    const root = libraryRootRepository.list().find((candidate) => inside(candidate.path, resolution.filePath));
    if (root === undefined) return 'unavailable';
    return { filePath: resolution.filePath, realRoot: root.path };
  }

  async function findFolderCover(filePath: string, realRoot: string): Promise<ArtworkResult | undefined> {
    if (fileSystem.readDirectory === undefined) return undefined;
    try {
      const entries = await fileSystem.readDirectory(path.dirname(filePath));
      const rank = (name: string): number => {
        const dot = name.lastIndexOf('.');
        if (dot <= 0) return -1;
        const base = FOLDER_COVER_NAMES.indexOf(name.slice(0, dot).toLowerCase());
        const ext = FOLDER_COVER_EXTENSIONS.indexOf(name.slice(dot + 1).toLowerCase());
        return base === -1 || ext === -1 ? -1 : base * FOLDER_COVER_EXTENSIONS.length + ext;
      };
      const candidates = entries
        .filter((entry) => (entry.kind === 'file' || entry.kind === 'symlink') && rank(entry.name) >= 0)
        .sort((a, b) => rank(a.name) - rank(b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const candidate of candidates) {
        try {
          const real = await fileSystem.realPath(candidate.path);
          if (!inside(realRoot, real)) continue; // a link out of the library is treated as absent
          const stats = await fileSystem.statFile(real);
          if (stats.sizeBytes === 0 || stats.sizeBytes > MAX_ARTWORK_BYTES) continue;
          const bytes = await readFile(real, MAX_ARTWORK_BYTES);
          const mimeType = sniffImageType(bytes);
          if (mimeType !== undefined) return { status: 'found', mimeType, bytes };
        } catch {
          // this candidate is unreadable: try the next
        }
      }
    } catch {
      // an unreadable folder simply has no cover
    }
    return undefined;
  }

  return {
    async getLyrics(rawId) {
      const located = await resolve(rawId);
      if (located === 'unavailable') return { status: 'unavailable', lines: [] };

      // Lyrics the listener attached by hand win over a sidecar file. A stored text that no longer parses
      // (it was valid when attached, so this is only a damaged row) is ignored rather than hiding the sidecar.
      let attached = attachedLyrics?.get(rawId);
      if (attached !== undefined) {
        // v0.11.3: if the file the lyrics were attached from still exists and has changed, the NEW text is used (and stored).
        // When it is gone or unreadable, or now has no timed lines, the stored copy keeps working.
        const source = attachedLyrics?.getSource?.(rawId);
        if (source !== undefined) {
          try {
            const real = await fileSystem.realPath(source);
            const stats = await fileSystem.statFile(real);
            if (stats.sizeBytes <= MAX_LYRICS_BYTES) {
              const fresh = decodeLyricsBytes(await readFile(real, MAX_LYRICS_BYTES));
              if (fresh !== attached && parseLyrics(fresh).lines.length > 0) {
                attachedLyrics?.set(rawId, fresh, source);
                attached = fresh;
              }
            }
          } catch {
            // the source moved or cannot be read: keep the stored copy
          }
        }
        const parsedAttached = parseLyrics(attached);
        if (parsedAttached.lines.length > 0) return { status: 'found', lines: parsedAttached.lines, attached: true };
      }
      const base = stripExtension(located.filePath);

      for (const candidate of [`${base}.lrc`, `${base}.LRC`]) {
        let real: CanonicalPath;
        try {
          real = await fileSystem.realPath(candidate);
        } catch (error) {
          if (error instanceof FileSystemError) continue; // not there (or not reachable): try the next candidate
          throw error;
        }
        if (!inside(located.realRoot, real)) continue; // a link out of the library: treated as absent
        try {
          const stats = await fileSystem.statFile(real);
          if (stats.sizeBytes > MAX_LYRICS_BYTES) return { status: 'unreadable', lines: [] };
          const bytes = await readFile(real, MAX_LYRICS_BYTES);
          const parsed = parseLyrics(decodeLyricsBytes(bytes));
          return parsed.lines.length === 0 ? { status: 'empty', lines: [] } : { status: 'found', lines: parsed.lines };
        } catch (error) {
          if (error instanceof FileSystemError && error.code === 'not-found') continue;
          return { status: 'unreadable', lines: [] };
        }
      }
      return { status: 'none', lines: [] };
    },

    async attachLyricsFromFile(rawId, filePath) {
      const located = await resolve(rawId); // throws for an invalid or unknown track
      if (located === 'unavailable') return { outcome: 'unavailable' };
      if (attachedLyrics === undefined) return { outcome: 'unavailable' };
      let bytes: Uint8Array;
      try {
        const real = await fileSystem.realPath(filePath);
        const stats = await fileSystem.statFile(real);
        if (stats.sizeBytes > MAX_LYRICS_BYTES) return { outcome: 'too-large' };
        bytes = await readFile(real, MAX_LYRICS_BYTES);
      } catch {
        return { outcome: 'unreadable' };
      }
      const text = decodeLyricsBytes(bytes);
      const parsed = parseLyrics(text);
      if (parsed.lines.length === 0) return { outcome: 'empty' };
      attachedLyrics.set(rawId, text, filePath);
      return { outcome: 'attached', lines: parsed.lines };
    },

    async detachLyrics(rawId) {
      if (typeof rawId !== 'string' || parseTrackId(rawId) === undefined) throw new TrackSidecarError('invalid-id', 'That is not a valid track id.');
      return attachedLyrics?.delete(rawId) ?? false;
    },

    async attachArtworkFromFile(rawId, filePath) {
      const located = await resolve(rawId); // throws for an invalid or unknown track
      if (located === 'unavailable' || customCovers === undefined) return { outcome: 'unavailable' };
      let bytes: Uint8Array;
      try {
        const real = await fileSystem.realPath(filePath);
        const stats = await fileSystem.statFile(real);
        if (stats.sizeBytes > MAX_ARTWORK_BYTES) return { outcome: 'too-large' };
        bytes = await readFile(real, MAX_ARTWORK_BYTES);
      } catch {
        return { outcome: 'unreadable' };
      }
      const mimeType = sniffImageType(bytes);
      if (mimeType === undefined) return { outcome: 'not-an-image' };
      customCovers.set(rawId, mimeType, bytes);
      return { outcome: 'attached' };
    },

    async detachArtwork(rawId) {
      if (typeof rawId !== 'string' || parseTrackId(rawId) === undefined) throw new TrackSidecarError('invalid-id', 'That is not a valid track id.');
      return customCovers?.delete(rawId) ?? false;
    },

    async getArtwork(rawId) {
      const located = await resolve(rawId);
      if (located === 'unavailable') return { status: 'unavailable' };
      const custom = customCovers?.get(rawId);
      if (custom !== undefined) return { status: 'found', mimeType: custom.mimeType, bytes: custom.bytes, custom: true };
      try {
        const picture = await readEmbeddedArtwork(located.filePath);
        if (picture !== undefined && picture.data.byteLength > 0 && picture.data.byteLength <= MAX_ARTWORK_BYTES) {
          const mimeType = picture.mimeType.toLowerCase();
          if (ARTWORK_TYPES.includes(mimeType)) return { status: 'found', mimeType, bytes: picture.data };
        }
      } catch {
        // a file whose tags cannot be read has no embedded artwork; a folder cover may still exist
      }
      return (await findFolderCover(located.filePath, located.realRoot)) ?? { status: 'none' };
    },
  };
}
