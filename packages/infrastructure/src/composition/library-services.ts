import { PLAYLIST_LIMITS } from '@nova/shared';
import type { LibraryRootRepository, PlaybackSessionRepository, TrackRepository } from '@nova/domain';
import { openDatabase } from '../database/index.js';
import { createNodeFileSystem } from '../filesystem/node-file-system.js';
import type { FileSystem } from '../filesystem/file-system.js';
import { createMusicMetadataReader, type MetadataReader } from '../metadata/music-metadata-reader.js';
import { SqliteAttachedLyricsRepository } from '../repositories/sqlite-attached-lyrics-repository.js';
import { SqliteCustomCoverRepository } from '../repositories/sqlite-custom-cover-repository.js';
import { SqliteFavoritesRepository } from '../repositories/sqlite-favorites-repository.js';
import { SqliteHistoryRepository } from '../repositories/sqlite-history-repository.js';
import { SqlitePlaylistRepository } from '../repositories/sqlite-playlist-repository.js';
import { SqliteLibraryRootRepository } from '../repositories/sqlite-library-root-repository.js';
import { SqlitePlaybackSessionRepository } from '../repositories/sqlite-playback-session-repository.js';
import { SqliteTrackRepository, type UnreadableTrackRow } from '../repositories/sqlite-track-repository.js';
import { createLibraryScanner } from '../scanning/library-scanner.js';
import type { LibraryScanner } from '../scanning/scan-types.js';
import { createFolderWatcher, type FolderWatcher, type FolderWatcherDependencies } from '../watching/folder-watcher.js';

/**
 * Something `createLibraryServices` repaired or could not repair while opening the library. Reported through
 * `onDiagnostic` so the caller (the main process) logs it; the library itself keeps opening.
 */
export type LibraryServicesDiagnostic =
  /** Stored tracks that could not be read were removed (a re-scan restores them from their files). */
  | { readonly kind: 'unreadable-tracks-removed'; readonly rows: readonly UnreadableTrackRow[] }
  /** The repair itself failed; nothing was deleted and the library opens as it was (reads stay strict). */
  | { readonly kind: 'repair-failed'; readonly error: unknown };

export interface LibraryServicesOptions {
  /** Where the library database lives. The desktop app passes a file under
   *  `app.getPath('userData')`; tests pass a temp file. */
  readonly databasePath: string;
  readonly scanner?: { readonly concurrency?: number; readonly batchSize?: number };
  /** Told about repairs made while opening (Phase 8). A throwing listener is ignored. */
  readonly onDiagnostic?: (event: LibraryServicesDiagnostic) => void;
}

/**
 * The Phase 2 infrastructure, wired together once, explicitly. Created by the
 * Electron MAIN process (the only process that may touch the disk or the
 * database) and handed to whatever needs it - there is no module-level
 * instance, and nothing here is reachable from the renderer.
 *
 * The raw database connection is deliberately NOT part of this surface:
 * everything else goes through the domain-owned repository port.
 */
export interface LibraryServices {
  readonly databasePath: string;
  readonly trackRepository: TrackRepository;
  /** v0.15.0: the listener's corrected names (the same repository, seen through its edit methods). */
  readonly trackEdits: Pick<SqliteTrackRepository, 'setEdit' | 'clearEdit' | 'hasEdit'>;
  /** The folders the user has added to the library (Phase 3). */
  readonly libraryRootRepository: LibraryRootRepository;
  /** The one saved playback session (Phase 4). */
  readonly playbackSessionRepository: PlaybackSessionRepository;
  /** Lyrics the listener attached to tracks by hand (migration 5). */
  readonly attachedLyricsRepository: SqliteAttachedLyricsRepository;
  readonly customCoverRepository: SqliteCustomCoverRepository;
  /** Favourites, recently played and playlists (migration 6). */
  readonly favoritesRepository: SqliteFavoritesRepository;
  readonly historyRepository: SqliteHistoryRepository;
  readonly playlistRepository: SqlitePlaylistRepository;
  readonly fileSystem: FileSystem;
  readonly metadataReader: MetadataReader;
  /** Scans started through it are tracked, and are aborted by `close()`. */
  readonly scanner: LibraryScanner;
  /** Creates a watcher wired to this services' scanner. `close()` stops every
   *  watcher created here. Per-watcher overrides: debounce, interval, ... */
  createFolderWatcher(options?: Omit<FolderWatcherDependencies, 'scanner'>): FolderWatcher;
  /**
   * Orderly shutdown: stops every watcher, aborts and waits for any running
   * scan, then closes the database. Nothing writes after the database is
   * closed. Idempotent; every call resolves once shutdown has finished.
   */
  close(): Promise<void>;
}

export function createLibraryServices(options: LibraryServicesOptions): LibraryServices {
  const database = openDatabase({ filePath: options.databasePath });
  try {
    const trackRepository = new SqliteTrackRepository(database);
    const diagnose = (event: LibraryServicesDiagnostic): void => {
      try {
        options.onDiagnostic?.(event);
      } catch {
        // reporting must never stop the library from opening
      }
    };
    try {
      const removed = trackRepository.removeUnreadableRecords();
      if (removed.length > 0) diagnose({ kind: 'unreadable-tracks-removed', rows: removed });
    } catch (error) {
      diagnose({ kind: 'repair-failed', error });
    }
    const libraryRootRepository = new SqliteLibraryRootRepository(database);
    const playbackSessionRepository = new SqlitePlaybackSessionRepository(database);
    const attachedLyricsRepository = new SqliteAttachedLyricsRepository(database);
    const customCoverRepository = new SqliteCustomCoverRepository(database);
    const favoritesRepository = new SqliteFavoritesRepository(database);
    const historyRepository = new SqliteHistoryRepository(database);
    const playlistRepository = new SqlitePlaylistRepository(database, { limits: PLAYLIST_LIMITS });
    const fileSystem = createNodeFileSystem();
    const metadataReader = createMusicMetadataReader();
    const rawScanner = createLibraryScanner({ fileSystem, metadataReader, trackRepository, ...options.scanner });

    const shutdown = new AbortController();
    const runningScans = new Set<Promise<unknown>>();
    const watchers = new Set<FolderWatcher>();
    let closing: Promise<void> | undefined;

    const scanner: LibraryScanner = {
      scan(request) {
        const signal = request.signal === undefined ? shutdown.signal : AbortSignal.any([request.signal, shutdown.signal]);
        const run = rawScanner.scan({ ...request, signal });
        runningScans.add(run);
        void run.then(
          () => runningScans.delete(run),
          () => runningScans.delete(run),
        );
        return run;
      },
    };

    return {
      databasePath: options.databasePath,
      trackRepository,
      trackEdits: trackRepository,
      libraryRootRepository,
      playbackSessionRepository,
      attachedLyricsRepository,
      customCoverRepository,
      favoritesRepository,
      historyRepository,
      playlistRepository,
      fileSystem,
      metadataReader,
      scanner,
      createFolderWatcher(watcherOptions = {}) {
        if (closing !== undefined) throw new Error('LibraryServices is closed.');
        const watcher = createFolderWatcher({ ...watcherOptions, scanner });
        watchers.add(watcher);
        return watcher;
      },
      close() {
        closing ??= (async () => {
          shutdown.abort();
          await Promise.allSettled([...watchers].map((watcher) => watcher.stop()));
          await Promise.allSettled([...runningScans]);
          database.close();
        })();
        return closing;
      },
    };
  } catch (error) {
    database.close();
    throw error;
  }
}
