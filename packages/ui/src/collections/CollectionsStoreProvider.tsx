import { createContext, useContext, type ReactNode } from 'react';
import { useStore } from 'zustand';
import type { CollectionsState, CollectionsStoreApi } from './collections-store.js';

const Context = createContext<CollectionsStoreApi | undefined>(undefined);

export function CollectionsStoreProvider({ store, children }: { store: CollectionsStoreApi; children: ReactNode }) {
  return <Context.Provider value={store}>{children}</Context.Provider>;
}

export function useCollectionsApi(): CollectionsStoreApi {
  const store = useContext(Context);
  if (store === undefined) throw new Error('useCollections must be used inside a CollectionsStoreProvider.');
  return store;
}

export function useCollections<T>(selector: (state: CollectionsState) => T): T {
  return useStore(useCollectionsApi(), selector);
}
