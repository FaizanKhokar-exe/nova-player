import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useStore } from 'zustand';
import type { LibraryStore, LibraryStoreApi } from './library-store.js';

const LibraryStoreContext = createContext<LibraryStoreApi | undefined>(undefined);

/**
 * Makes one library store available to the tree and ties its event
 * subscriptions to this component's lifetime. The store itself is created by
 * the application entry point (not here), so the provider never owns a global.
 *
 * `connect()` is reference-counted, so React Strict Mode's extra
 * mount/unmount/mount in development does not duplicate subscriptions.
 */
export function LibraryStoreProvider({ store, children }: { store: LibraryStoreApi; children: ReactNode }) {
  useEffect(() => store.getState().connect(), [store]);
  return <LibraryStoreContext.Provider value={store}>{children}</LibraryStoreContext.Provider>;
}

export function useLibraryStore<T>(selector: (state: LibraryStore) => T): T {
  const store = useContext(LibraryStoreContext);
  if (store === undefined) throw new Error('useLibraryStore must be used inside <LibraryStoreProvider>.');
  return useStore(store, selector);
}
