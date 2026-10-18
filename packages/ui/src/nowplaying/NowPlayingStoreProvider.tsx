import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useStore } from 'zustand';
import type { NowPlayingState, NowPlayingStoreApi } from './now-playing-store.js';

const NowPlayingContext = createContext<NowPlayingStoreApi | undefined>(undefined);

/** Ties the now-playing store's following of the playback store to this component's lifetime (reference-counted). */
export function NowPlayingStoreProvider({ store, children }: { store: NowPlayingStoreApi; children: ReactNode }) {
  useEffect(() => store.getState().connect(), [store]);
  return <NowPlayingContext.Provider value={store}>{children}</NowPlayingContext.Provider>;
}

export function useNowPlayingStoreApi(): NowPlayingStoreApi | undefined {
  return useContext(NowPlayingContext);
}

export function useNowPlaying<T>(selector: (state: NowPlayingState) => T): T {
  const store = useContext(NowPlayingContext);
  if (store === undefined) throw new Error('useNowPlaying must be used inside <NowPlayingStoreProvider>.');
  return useStore(store, selector);
}
