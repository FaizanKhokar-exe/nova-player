import { parseTrackId, type LibraryRootRepository, type TrackRepository } from '@nova/domain';
import { FileSystemError } from '../filesystem/file-system-error.js';
import type { FileSystem } from '../filesystem/file-system.js';
import { isPathWithin, pathComparisonKey, type CanonicalPath } from '../filesystem/path-policy.js';
import { extensionOf } from '../metadata/supported-formats.js';

/** The audio types the protocol will serve, and what it calls them. Anything
 *  else is refused - the protocol is for playing music, not a file server. */
export const MEDIA_CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/opus',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wma': 'audio/x-ms-wma',
};

export function contentTypeForFile(filePath: string): string | undefined {
  return MEDIA_CONTENT_TYPES[extensionOf(filePath.slice(Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')) + 1))];
}

/** Why a track's file was NOT handed out. Each is deliberately specific so the
 *  protocol can answer precisely and the UI can explain; none carries a path. */
export type MediaDenial =
  /** The id is not a TrackId at all. */
  | 'invalid-id'
  /** No such track in the library. */
  | 'track-not-found'
  /** The track's file does not lie inside any CURRENTLY registered library folder. */
  | 'root-not-registered'
  /** Its library folder cannot be opened right now (unplugged, deleted, no access). */
  | 'root-unavailable'
  /** The library folder now resolves somewhere other than where it was registered (swapped for a link). */
  | 'root-changed'
  /** The file's REAL location (after following links) is outside its library folder. */
  | 'outside-root'
  | 'file-missing'
  | 'file-inaccessible'
  | 'not-a-file'
  | 'unsupported-format';

export type MediaResolution =
  | { readonly ok: true; readonly filePath: CanonicalPath; readonly contentType: string }
  | { readonly ok: false; readonly denial: MediaDenial };

/**
 * The single authority on "may the renderer hear this track?". It is asked on
 * EVERY request - nothing is cached and no grant outlives the data it was
 * based on - so removing a root, or a root going away, stops access at once.
 */
export interface MediaAccess {
  resolveTrack(trackId: string): Promise<MediaResolution>;
}

export interface MediaAccessDependencies {
  readonly trackRepository: Pick<TrackRepository, 'getById'>;
  readonly libraryRootRepository: Pick<LibraryRootRepository, 'list'>;
  readonly fileSystem: Pick<FileSystem, 'realPath' | 'statFile'>;
}

function lexicallyInside(root: string, candidate: string): boolean {
  try {
    return isPathWithin(root, candidate);
  } catch {
    return false; // a path the policy cannot read belongs to no root: fail closed
  }
}

function sameKey(a: string, b: string): boolean {
  try {
    return pathComparisonKey(a) === pathComparisonKey(b);
  } catch {
    return false;
  }
}

/**
 * Policy, in order (each step can only narrow what is served):
 *  1. The id must be a well-formed TrackId, and the track must exist.
 *  2. Its stored path must lie inside a root registered RIGHT NOW (a removed
 *     root, or an orphaned track, is refused here).
 *  3. That root must still resolve - via the real file system - to the very
 *     folder that was registered. A root that vanished is `root-unavailable`;
 *     one that now points elsewhere (replaced by a symlink/junction) is
 *     `root-changed`. Neither can be used to reach unrelated content.
 *  4. The file's REAL path (links followed) must be inside the root's real
 *     path. A symlink inside the library that points out of it is refused
 *     (`outside-root`) - the Phase 2 scanner never follows links, and neither
 *     does playback.
 *  5. It must be a regular file with an audio extension.
 * The path that is finally opened is the verified real path, not the stored one.
 *
 * Known limit: a file could be swapped for a link between this check and the
 * moment it is opened (a time-of-check/time-of-use gap); closing that needs
 * handle-based opens and is outside this phase.
 */
export function createMediaAccess(dependencies: MediaAccessDependencies): MediaAccess {
  const { trackRepository, libraryRootRepository, fileSystem } = dependencies;

  return {
    async resolveTrack(rawId) {
      const deny = (denial: MediaDenial): MediaResolution => ({ ok: false, denial });

      const trackId = typeof rawId === 'string' ? parseTrackId(rawId) : undefined;
      if (trackId === undefined) return deny('invalid-id');

      const track = trackRepository.getById(trackId);
      if (track === undefined) return deny('track-not-found');

      const root = libraryRootRepository.list().find((candidate) => lexicallyInside(candidate.path, track.sourcePath));
      if (root === undefined) return deny('root-not-registered');

      let realRoot: CanonicalPath;
      try {
        realRoot = await fileSystem.realPath(root.path);
      } catch (error) {
        if (error instanceof FileSystemError) return deny('root-unavailable');
        throw error;
      }
      if (!sameKey(realRoot, root.path)) return deny('root-changed');

      let realFile: CanonicalPath;
      try {
        realFile = await fileSystem.realPath(track.sourcePath);
      } catch (error) {
        if (error instanceof FileSystemError) return deny(error.code === 'not-found' ? 'file-missing' : 'file-inaccessible');
        throw error;
      }
      if (!lexicallyInside(realRoot, realFile)) return deny('outside-root');

      try {
        await fileSystem.statFile(realFile);
      } catch (error) {
        if (error instanceof FileSystemError) {
          if (error.code === 'not-found') return deny('file-missing');
          if (error.code === 'not-a-file') return deny('not-a-file');
          return deny('file-inaccessible');
        }
        throw error;
      }

      const contentType = contentTypeForFile(realFile);
      if (contentType === undefined) return deny('unsupported-format');
      return { ok: true, filePath: realFile, contentType };
    },
  };
}
