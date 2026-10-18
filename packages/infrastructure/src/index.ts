export { runDatabaseDiagnostics } from './database-diagnostics.js';
export { readBasicTags, type BasicTags } from './metadata-reader.js';
export {
  NOVA_MEDIA_SCHEME,
  registerNovaMediaSchemeAsPrivileged,
  registerNovaMediaProtocolHandler,
  handleNovaMediaRequest,
  parseByteRange,
  buildNovaMediaUrl,
  type NovaMediaProtocolOptions,
  type NovaMediaRequestInfo,
  type ByteRangeResult,
} from './nova-media-protocol.js';

// --- Phase 2A: SQLite foundation ---
export {
  openDatabase,
  IN_MEMORY_DATABASE,
  runMigrations,
  MigrationError,
  MIGRATIONS,
  type NovaDatabase,
  type OpenDatabaseOptions,
  type Migration,
  type MigrationResult,
  type MigrationErrorCode,
} from './database/index.js';

// --- Phase 2B: SQLite implementation of the domain's TrackRepository port ---
export {
  SqliteTrackRepository,
  SqliteLibraryRootRepository,
  SqlitePlaybackSessionRepository,
  SqliteAttachedLyricsRepository,
  SqliteFavoritesRepository,
  SqliteHistoryRepository,
  SqlitePlaylistRepository,
  PlaybackSessionCorruptError,
  MAX_HISTORY_ROWS,
  pickCoverTrackIds,
  type PlaylistLimits,
  type PlaylistRow,
  type CoverCandidate,
} from './repositories/index.js';

// --- Phase 2C: filesystem abstraction + safe path handling ---
export {
  createNodeFileSystem,
  FileSystemError,
  canonicalizePath,
  pathComparisonKey,
  isPathWithin,
  resolveWithin,
  NATIVE_PATH_FLAVOR,
  type FileSystem,
  type FileStats,
  type FileKind,
  type DirectoryEntry,
  type DirectoryEntryKind,
  type FileSystemErrorCode,
  type CanonicalPath,
  type PathKey,
  type PathFlavor,
} from './filesystem/index.js';

// --- Phase 2D: music-metadata adapter (the only code that touches the library) ---
export {
  createMusicMetadataReader,
  SUPPORTED_AUDIO_EXTENSIONS,
  isSupportedAudioFile,
  type MetadataReader,
  type MetadataReadResult,
} from './metadata/index.js';

// --- Phase 2E: library scanning ---
export {
  createLibraryScanner,
  ScanError,
  type LibraryScanner,
  type LibraryScannerDependencies,
  type ScanRequest,
  type ScanResult,
  type ScanProgress,
  type ScanPhase,
  type ScanCounts,
  type ScanFailure,
  type ScanFailureKind,
  type ScanErrorCode,
} from './scanning/index.js';

// --- Phase 2F: folder watching ---
export {
  createFolderWatcher,
  type FolderWatcher,
  type FolderWatcherDependencies,
  type FolderWatcherStartReport,
  type FolderWatcherErrorEvent,
  type FolderWatcherReconciledEvent,
  type WatchFunction,
  type WatchHandle,
} from './watching/index.js';

// --- Phase 2G: composition root for the desktop main process ---
export { createLibraryServices, type LibraryServices, type LibraryServicesDiagnostic, type LibraryServicesOptions } from './composition/index.js';

// --- Phase 3 (half 1): the application layer the IPC handlers call ---
export {
  createLibraryApplication,
  LibraryApplicationError,
  type LibraryApplication,
  type LibraryApplicationDependencies,
  type LibraryApplicationErrorCode,
  type LibraryApplicationEvent,
  type LibraryChangeReason,
  type LibrarySummary,
  type StartupReport,
  type RootView,
  type ScanJobProgress,
  type ScanJobResult,
  type ScanRootOutcome,
  type ScanState,
  type WatcherStatusView,
} from './application/index.js';

// --- Phase 4: media access + playback ---
export {
  createMediaAccess,
  contentTypeForFile,
  MEDIA_CONTENT_TYPES,
  type MediaAccess,
  type MediaAccessDependencies,
  type MediaDenial,
  type MediaResolution,
} from './media/media-access.js';
export { buildTrackMediaUrl, parseNovaMediaUrl, type ParsedMediaUrl, type MediaUrlRejection } from './media/media-url.js';
export {
  createPlaybackApplication,
  PlaybackApplicationError,
  type PlaybackApplication,
  type PlaybackApplicationDependencies,
  type PlaybackApplicationErrorCode,
  type PlaybackApplicationEvent,
  type PlaybackActivityEvent,
  type PlaybackChangeReason,
  type PlaybackCommandResult,
  type PlaybackContext,
  type QueueItemView,
  type QueueView,
  type EnqueueCommandResult,
  type PlaybackOutcome,
  type PlaybackStateView,
} from './application/index.js';

// --- Phase 6: per-track lyrics and artwork ---
export {
  createTrackSidecars,
  TrackSidecarError,
  MAX_LYRICS_BYTES,
  MAX_ARTWORK_BYTES,
  type TrackSidecars,
  type TrackSidecarsDependencies,
  type LyricsResult,
  type ArtworkResult,
  type AttachLyricsResult,
  type AttachedLyricsStore,
  decodeLyricsBytes,
} from './media/track-sidecars.js';
export { readFileBounded } from './media/fs-readers.js';
export { readEmbeddedPicture } from './metadata/music-metadata-reader.js';

// --- Phase 11: collections ---
export {
  createCollectionsApplication,
  CollectionsApplicationError,
  normalizePlaylistName,
  DEFAULT_HISTORY_LIMIT,
  MAX_HISTORY_LIMIT,
  MAX_PLAYLIST_NAME_LENGTH,
  type CollectionsApplication,
  type CollectionsApplicationDependencies,
  type CollectionsErrorCode,
  type HistoryItemView,
  type ListSource,
  type PlaylistDetailView,
  type PlaylistEntryView,
  type PlaylistView,
} from './application/index.js';
export { createHistoryRecorder, HISTORY_MIN_PLAYED_MS, type HistoryRecorderDependencies } from './application/index.js';
export { FOLDER_COVER_NAMES, FOLDER_COVER_EXTENSIONS, sniffImageType } from './media/track-sidecars.js';
export {
  createTrackThumbnails,
  planThumbnail,
  THUMBNAIL_SPECS,
  type ImageResizer,
  type ThumbnailResult,
  type ThumbnailSize,
  type ThumbnailSpec,
  type TrackThumbnails,
  type TrackThumbnailsDependencies,
} from './media/track-thumbnails.js';
export { readImageHeader, detectImageType, type ImageHeader, type ImageType } from './media/image-header.js';
export { createWallpaperStore, type WallpaperStore, type WallpaperPorts, type WallpaperChosen, type WallpaperCurrent } from './media/wallpaper-store.js';
