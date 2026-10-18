export { TrackTitle } from './TrackTitle.js';
export { usePhase0CounterStore } from './phase0-counter-store.js';

// --- Phase 3 half 2: library shell + renderer state ---
export {
  createLibraryStore,
  type LibraryStore,
  type LibraryStoreApi,
  type LibraryState,
  type LibraryActions,
  type LibraryStoreOptions,
  type UiError,
  type ScanPhase,
  type LoadStatus,
  type LibraryView,
  type GroupsSlice,
  type DetailSlice,
} from './library/library-store.js';
export { LibraryStoreProvider, useLibraryStore } from './library/LibraryStoreProvider.js';

// --- Phase 4: playback ---
export {
  createPlaybackStore,
  type AudioLike,
  type PlaybackStore,
  type PlaybackStoreApi,
  type PlaybackState,
  type PlaybackActions,
  type PlaybackStoreOptions,
  type PlaybackUiError,
  type EngineState,
  type QueueSlice,
} from './playback/playback-store.js';
export { PlaybackStoreProvider, usePlaybackStore, usePlaybackPositionMs } from './playback/PlaybackStoreProvider.js';

// --- Phase 6: lyrics, artwork, Now Playing ---
export { createNowPlayingStore, type NowPlayingState, type NowPlayingStoreApi, type LyricsSlice, type ArtworkSlice, type LyricsActionSlice } from './nowplaying/now-playing-store.js';
export { NowPlayingStoreProvider, useNowPlaying, useNowPlayingStoreApi } from './nowplaying/NowPlayingStoreProvider.js';
export { Artwork } from './nowplaying/Artwork.js';

// --- Phase 10: theming (dark/light, dynamic album-art accents) ---
export { createThemeStore, SWATCHES, type ThemeState, type ThemeStoreApi, type ThemeMode, type AccentChoice } from './theme/theme-store.js';
export { ThemeStoreProvider, ThemeController, useThemeStoreApi } from './theme/ThemeProvider.js';
export { extractAccents, DEFAULT_ACCENTS, type Accents } from './theme/palette.js';

// --- Nova Player 2: new UI (v0.11) ---
export { AppProviders, AppRoot } from './app/AppRoot.js';
export { createAppServices } from './app/create-services.js';
export { ServicesProvider, useServices, type AppServices } from './app/services.js';
export { createUiStore, type UiState, type UiStoreApi, type Route } from './app/ui-store.js';
export { createPrefsStore, type PrefsState, type PrefsStoreApi } from './prefs/prefs-store.js';
export { createAudioEngine, type AudioEngine } from './audio/audio-engine.js';
export { createAudioControls, type AudioControlsApi } from './audio/audio-controls.js';
export { createCollectionsStore, type CollectionsStoreApi } from './collections/collections-store.js';
export { CollectionsStoreProvider } from './collections/CollectionsStoreProvider.js';
export { createThumbnailCache, type ThumbnailCache } from './media/thumbnail-cache.js';
export { createWallpaperStore, type WallpaperStoreApi } from './media/wallpaper-store.js';
export { createVisualBus, type VisualBus } from './visuals/visual-bus.js';
