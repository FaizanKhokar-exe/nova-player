import { createStore, type StoreApi } from 'zustand/vanilla';
import type { CollectionsIpcContract, HistoryItemDto, IpcRequest, IpcResponse, NovaBridge, PlaylistDto, PlaylistEntryDto, TrackDto } from '@nova/shared';

/**
 * Renderer state for the listener's own collections: favourites, recently played and playlists. A thin mirror of
 * main (every rule - limits, names, what exists - is decided there); the only logic here is OPTIMISTIC favouriting, so a
 * heart responds instantly and is put back if main says no.
 */

type Channel = keyof CollectionsIpcContract;
export type Load = 'idle' | 'loading' | 'ready' | 'error';

export interface CollectionsState {
  readonly favoriteIds: ReadonlySet<string>;
  readonly favorites: { readonly status: Load; readonly tracks: readonly TrackDto[] };
  readonly history: { readonly status: Load; readonly items: readonly HistoryItemDto[] };
  readonly playlists: { readonly status: Load; readonly items: readonly PlaylistDto[] };
  readonly playlist: { readonly status: Load; readonly playlistId: string | undefined; readonly playlist: PlaylistDto | undefined; readonly entries: readonly PlaylistEntryDto[] };
  /** One-line confirmation or problem for a toast. */
  readonly notice: { readonly text: string; readonly tone: 'ok' | 'error'; readonly id: number } | undefined;

  /** Loads the favourite ids and the playlist list (cheap; the heart state and the sidebar need them everywhere). */
  connect(): void;
  toggleFavorite(trackId: string): Promise<void>;
  loadFavorites(): Promise<void>;
  loadHistory(): Promise<void>;
  clearHistory(): Promise<void>;
  loadPlaylists(): Promise<void>;
  createPlaylist(name: string, trackIds?: readonly string[]): Promise<PlaylistDto | undefined>;
  renamePlaylist(playlistId: string, name: string): Promise<boolean>;
  deletePlaylist(playlistId: string): Promise<boolean>;
  addToPlaylist(playlistId: string, trackIds: readonly string[], playlistName?: string): Promise<boolean>;
  loadPlaylist(playlistId: string): Promise<void>;
  removeEntries(playlistId: string, entryIds: readonly string[]): Promise<void>;
  moveEntry(playlistId: string, entryId: string, toIndex: number): Promise<void>;
  dismissNotice(): void;
}
export type CollectionsStoreApi = StoreApi<CollectionsState>;

export function createCollectionsStore(bridge: NovaBridge): CollectionsStoreApi {
  type Failure = { readonly ok: false; readonly error: { readonly message: string } };
  async function call<K extends Channel>(channel: K, request: IpcRequest<K>): Promise<IpcResponse<K> | Failure> {
    try {
      return await bridge.invoke(channel, request);
    } catch {
      return { ok: false, error: { message: 'Could not reach the application. Try restarting Nova Player.' } };
    }
  }

  return createStore<CollectionsState>((set, get) => {
    let noticeId = 0;
    let playlistSequence = 0;
    let connected = false;
    const say = (text: string, tone: 'ok' | 'error' = 'ok'): void => set({ notice: { text, tone, id: ++noticeId } });

    return {
      favoriteIds: new Set<string>(),
      favorites: { status: 'idle', tracks: [] },
      history: { status: 'idle', items: [] },
      playlists: { status: 'idle', items: [] },
      playlist: { status: 'idle', playlistId: undefined, playlist: undefined, entries: [] },
      notice: undefined,

      connect() {
        if (connected) return;
        connected = true;
        void (async () => {
          const ids = await call('favorites:ids', undefined);
          if (ids.ok) set({ favoriteIds: new Set(ids.value.trackIds) });
          await get().loadPlaylists();
        })();
      },

      async toggleFavorite(trackId) {
        const wanted = !get().favoriteIds.has(trackId);
        const apply = (value: boolean): void => {
          const next = new Set(get().favoriteIds);
          if (value) next.add(trackId);
          else next.delete(trackId);
          set({ favoriteIds: next });
        };
        apply(wanted);
        const result = await call('favorites:set', { trackId, favorite: wanted });
        if (!result.ok) {
          apply(!wanted);
          say(result.error.message, 'error');
          return;
        }
        say(wanted ? 'Added to Favorites' : 'Removed from Favorites');
        // A shown favourites list follows the change on its next load; if it is on screen, refresh it now.
        if (get().favorites.status === 'ready') void get().loadFavorites();
      },

      async loadFavorites() {
        if (get().favorites.status !== 'ready') set({ favorites: { status: 'loading', tracks: get().favorites.tracks } });
        const result = await call('favorites:list', undefined);
        if (result.ok) set({ favorites: { status: 'ready', tracks: result.value.tracks }, favoriteIds: new Set(result.value.tracks.map((t) => t.id)) });
        else set({ favorites: { status: 'error', tracks: get().favorites.tracks } });
      },

      async loadHistory() {
        if (get().history.status !== 'ready') set({ history: { status: 'loading', items: get().history.items } });
        const result = await call('history:list', { limit: 100 });
        set({ history: result.ok ? { status: 'ready', items: result.value.items } : { status: 'error', items: get().history.items } });
      },

      async clearHistory() {
        const result = await call('history:clear', undefined);
        if (!result.ok) return say(result.error.message, 'error');
        set({ history: { status: 'ready', items: [] } });
        say('Recently played cleared');
      },

      async loadPlaylists() {
        if (get().playlists.status !== 'ready') set({ playlists: { status: 'loading', items: get().playlists.items } });
        const result = await call('playlists:list', undefined);
        set({ playlists: result.ok ? { status: 'ready', items: result.value.playlists } : { status: 'error', items: get().playlists.items } });
      },

      async createPlaylist(name, trackIds) {
        const result = await call('playlists:create', trackIds === undefined ? { name } : { name, trackIds });
        if (!result.ok) {
          say(result.error.message, 'error');
          return undefined;
        }
        await get().loadPlaylists();
        say(`Created "${result.value.playlist.name}"`);
        return result.value.playlist;
      },

      async renamePlaylist(playlistId, name) {
        const result = await call('playlists:rename', { playlistId, name });
        if (!result.ok) {
          say(result.error.message, 'error');
          return false;
        }
        await get().loadPlaylists();
        if (get().playlist.playlistId === playlistId) set({ playlist: { ...get().playlist, playlist: result.value.playlist } });
        return true;
      },

      async deletePlaylist(playlistId) {
        const result = await call('playlists:delete', { playlistId });
        if (!result.ok) {
          say(result.error.message, 'error');
          return false;
        }
        await get().loadPlaylists();
        say('Playlist deleted');
        return true;
      },

      async addToPlaylist(playlistId, trackIds, playlistName) {
        const result = await call('playlists:addTracks', { playlistId, trackIds });
        if (!result.ok) {
          say(result.error.message, 'error');
          return false;
        }
        const where = playlistName ?? result.value.playlist.name;
        say(result.value.added === 0 ? `Nothing new to add to "${where}"` : `Added ${result.value.added} ${result.value.added === 1 ? 'song' : 'songs'} to "${where}"`);
        void get().loadPlaylists();
        if (get().playlist.playlistId === playlistId) void get().loadPlaylist(playlistId);
        return true;
      },

      async loadPlaylist(playlistId) {
        const sequence = ++playlistSequence;
        const same = get().playlist.playlistId === playlistId;
        set({ playlist: { status: same && get().playlist.status === 'ready' ? 'ready' : 'loading', playlistId, playlist: same ? get().playlist.playlist : undefined, entries: same ? get().playlist.entries : [] } });
        const result = await call('playlists:get', { playlistId });
        if (sequence !== playlistSequence) return;
        set({ playlist: result.ok ? { status: 'ready', playlistId, playlist: result.value.playlist, entries: result.value.entries } : { status: 'error', playlistId, playlist: undefined, entries: [] } });
      },

      async removeEntries(playlistId, entryIds) {
        const result = await call('playlists:removeEntries', { playlistId, entryIds });
        if (!result.ok) return say(result.error.message, 'error');
        set({ playlist: { status: 'ready', playlistId, playlist: result.value.playlist, entries: result.value.entries } });
        void get().loadPlaylists();
      },

      async moveEntry(playlistId, entryId, toIndex) {
        const result = await call('playlists:moveEntry', { playlistId, entryId, toIndex });
        if (!result.ok) return say(result.error.message, 'error');
        set({ playlist: { status: 'ready', playlistId, playlist: result.value.playlist, entries: result.value.entries } });
      },

      dismissNotice() {
        set({ notice: undefined });
      },
    };
  });
}
