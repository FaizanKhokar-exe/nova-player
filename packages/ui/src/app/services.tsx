import { createContext, useContext, type ReactNode } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';
import type { NovaBridge } from '@nova/shared';
import type { AudioControlsApi, AudioControlsState } from '../audio/audio-controls.js';
import type { AudioEngine } from '../audio/audio-engine.js';
import type { CollectionsStoreApi } from '../collections/collections-store.js';
import type { LibraryStoreApi } from '../library/library-store.js';
import type { ThumbnailCache } from '../media/thumbnail-cache.js';
import type { WallpaperStoreApi } from '../media/wallpaper-store.js';
import type { StudioStoreApi } from '../lyricstudio/studio-store.js';
import type { NowPlayingStoreApi } from '../nowplaying/now-playing-store.js';
import type { PlaybackStoreApi } from '../playback/playback-store.js';
import type { PrefsStoreApi, PrefsState } from '../prefs/prefs-store.js';
import type { ThemeStoreApi } from '../theme/theme-store.js';
import type { VisualBus } from '../visuals/visual-bus.js';
import type { UiState, UiStoreApi } from './ui-store.js';

/**
 * Everything the screens need, created ONCE by the renderer entry point and handed down through context. Components
 * never create stores or touch `window`; tests build the same object from fakes.
 */
export interface AppServices {
  readonly bridge: NovaBridge;
  readonly library: LibraryStoreApi;
  readonly playback: PlaybackStoreApi;
  readonly nowPlaying: NowPlayingStoreApi;
  readonly theme: ThemeStoreApi;
  readonly prefs: PrefsStoreApi;
  readonly collections: CollectionsStoreApi;
  readonly wallpaper: WallpaperStoreApi;
  readonly audioControls: AudioControlsApi;
  readonly engine: AudioEngine;
  readonly visuals: VisualBus;
  readonly thumbnails: ThumbnailCache;
  readonly ui: UiStoreApi;
  readonly studio: StudioStoreApi;
}

export const ServicesContext = createContext<AppServices | undefined>(undefined);

export function useServices(): AppServices {
  const services = useContext(ServicesContext);
  if (services === undefined) throw new Error('This component must be rendered inside <AppProviders>.');
  return services;
}

export function useUi<T>(selector: (state: UiState) => T): T {
  return useStore(useServices().ui, selector);
}
export function usePrefs<T>(selector: (state: PrefsState) => T): T {
  return useStore(useServices().prefs, selector);
}
export function useAudioControls<T>(selector: (state: AudioControlsState) => T): T {
  return useStore(useServices().audioControls as StoreApi<AudioControlsState>, selector);
}

export function ServicesProvider({ services, children }: { services: AppServices; children: ReactNode }) {
  return <ServicesContext.Provider value={services}>{children}</ServicesContext.Provider>;
}
