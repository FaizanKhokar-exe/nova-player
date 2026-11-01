import type { NovaBridge } from '@nova/shared';
import { createAudioControls, type AudioElementLike } from '../audio/audio-controls.js';
import { createAudioEngine } from '../audio/audio-engine.js';
import { createCollectionsStore } from '../collections/collections-store.js';
import { createLibraryStore } from '../library/library-store.js';
import { createThumbnailCache } from '../media/thumbnail-cache.js';
import { createWallpaperStore } from '../media/wallpaper-store.js';
import { createStudioStore } from '../lyricstudio/studio-store.js';
import { createNowPlayingStore } from '../nowplaying/now-playing-store.js';
import { createPlaybackStore, type AudioLike } from '../playback/playback-store.js';
import { createPrefsStore } from '../prefs/prefs-store.js';
import { createThemeStore } from '../theme/theme-store.js';
import { createVisualBus } from '../visuals/visual-bus.js';
import type { AppServices } from './services.js';
import { createUiStore } from './ui-store.js';

/**
 * Builds every store and service the app needs from the bridge and the one audio element. This is the renderer's
 * composition point (called once by the entry point); tests call it with fakes.
 */
export function createAppServices(bridge: NovaBridge, audio: AudioLike & AudioElementLike): AppServices {
  const library = createLibraryStore(bridge);
  const playback = createPlaybackStore(bridge, audio);
  const nowPlaying = createNowPlayingStore(bridge, playback);
  const studio = createStudioStore(bridge, playback, () => void nowPlaying.getState().refreshLyrics(), () => {
    const lyrics = nowPlaying.getState().lyrics;
    return lyrics.status === 'ready' && lyrics.availability === 'found' ? lyrics.lines : [];
  });
  const prefs = createPrefsStore();
  const engine = createAudioEngine({ element: audio });
  const audioControls = createAudioControls({ audio, engine, prefs, playback });
  const visuals = createVisualBus({ engine });
  return {
    bridge,
    library,
    playback,
    nowPlaying,
    theme: createThemeStore(),
    prefs,
    collections: createCollectionsStore(bridge),
    wallpaper: createWallpaperStore(bridge),
    audioControls,
    engine,
    visuals,
    thumbnails: createThumbnailCache(bridge),
    ui: createUiStore(),
    studio,
  };
}
