import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { useStore } from 'zustand';
import type { PlaybackStore, PlaybackStoreApi } from './playback-store.js';

const PlaybackStoreContext = createContext<PlaybackStoreApi | undefined>(undefined);

/**
 * Makes one playback store available to the tree and ties its subscriptions
 * (main's playback events and the audio element's events) to this component's
 * lifetime. The store and the audio element are created by the application
 * entry point, so the provider owns no global. `connect()` is
 * reference-counted, so React Strict Mode's extra mount/unmount/mount does
 * not duplicate listeners.
 *
 * Phase 8: it also saves the playback position when the page is hidden for good (`pagehide`).
 */
export function PlaybackStoreProvider({ store, children }: { store: PlaybackStoreApi; children: ReactNode }) {
  useEffect(() => {
    const disconnect = store.getState().connect();
    // Closing the window (or reloading the page) ends the page without running React's cleanup. While playing, the
    // position is only checkpointed every few seconds, so it is also saved as the page goes away.
    const flush = (): void => store.getState().flushPosition();
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      disconnect();
    };
  }, [store]);
  return <PlaybackStoreContext.Provider value={store}>{children}</PlaybackStoreContext.Provider>;
}

/** The store, or `undefined` when the tree has no playback (the Phase 3 library tests render without it). */
export function usePlaybackStoreApi(): PlaybackStoreApi | undefined {
  return useContext(PlaybackStoreContext);
}

export function usePlaybackStore<T>(selector: (state: PlaybackStore) => T): T {
  const store = useContext(PlaybackStoreContext);
  if (store === undefined) throw new Error('usePlaybackStore must be used inside <PlaybackStoreProvider>.');
  return useStore(store, selector);
}

/** The playback position in whole ms. ONLY the progress display should use this: it changes several times a second. */
export function usePlaybackPositionMs(): number {
  const store = useContext(PlaybackStoreContext);
  if (store === undefined) throw new Error('usePlaybackPositionMs must be used inside <PlaybackStoreProvider>.');
  return useStore(store.getState().positionStore, (state) => state.positionMs);
}

/**
 * A value DERIVED from the playback position (e.g. which lyric line is active). The component re-renders
 * only when the derived primitive changes - a lyric view updates a few times a minute, not several times
 * a second - while the position itself stays isolated from everything else.
 */
export function usePlaybackPositionSelector<T extends string | number | boolean | undefined>(selector: (positionMs: number) => T): T {
  const store = useContext(PlaybackStoreContext);
  if (store === undefined) throw new Error('usePlaybackPositionSelector must be used inside <PlaybackStoreProvider>.');
  return useStore(store.getState().positionStore, (state) => selector(state.positionMs));
}

const noSubscription = (): (() => void) => () => undefined;

/**
 * Like `usePlaybackStore`, but returns `undefined` when the tree has no
 * playback instead of throwing - for UI (the track list) that must also work
 * as a plain library view. The selector must return a primitive (a string,
 * boolean or undefined), so the snapshot is stable between renders.
 */
export function useOptionalPlayback<T extends string | number | boolean | undefined>(selector: (state: PlaybackStore) => T): T | undefined {
  const store = useContext(PlaybackStoreContext);
  return useSyncExternalStore(
    store === undefined ? noSubscription : store.subscribe,
    () => (store === undefined ? undefined : selector(store.getState())),
    () => undefined,
  );
}
