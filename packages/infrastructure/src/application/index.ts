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
} from './library-application.js';

// --- Phase 4: playback ---
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
} from './playback-application.js';

// --- Phase 11: favourites, recently played, playlists ---
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
} from './collections-application.js';

export { createHistoryRecorder, HISTORY_MIN_PLAYED_MS, type HistoryRecorderDependencies } from './history-recorder.js';
