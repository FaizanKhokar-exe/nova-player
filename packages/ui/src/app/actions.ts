import { useMemo } from 'react';
import type { GroupDto, GroupKindDto, ListSourceDto, PlaybackContextDto, PlaylistDto, TrackDto } from '@nova/shared';
import type { AppServices } from './services.js';
import { useServices } from './services.js';
import type { MenuItem, Route } from './ui-store.js';

/**
 * The things a listener can DO, in one place, so every screen (rows, tiles, menus, the dock, keyboard shortcuts) does
 * them the same way. Each action calls a store; none contains a rule.
 */

export interface TrackMenuOptions {
  /** The list the track is shown in; playing from the menu continues in that list. */
  readonly context?: PlaybackContextDto;
  /** When shown inside a playlist: the entry to offer "Remove from this playlist" for. */
  readonly playlist?: { readonly id: string; readonly name: string; readonly entryId: string };
}

export interface Actions {
  playTrack(trackId: string, context?: PlaybackContextDto): void;
  playNext(trackId: string, label?: string): void;
  addToQueue(trackId: string, label?: string): void;
  playGroup(group: Pick<GroupDto, 'kind' | 'key'>): void;
  queueGroup(group: Pick<GroupDto, 'kind' | 'key' | 'name'>, position: 'next' | 'last'): void;
  playList(source: ListSourceDto, options?: { startTrackId?: string; shuffle?: boolean }): void;
  queueList(source: ListSourceDto, position: 'next' | 'last', label: string): void;
  go(route: Route): void;
  goToGroupByName(kind: Extract<GroupKindDto, 'album' | 'artist'>, name: string, artist?: string): void;
  trackMenu(track: TrackDto, options?: TrackMenuOptions): readonly MenuItem[];
  groupMenu(group: GroupDto): readonly MenuItem[];
  playlistMenu(playlist: PlaylistDto): readonly MenuItem[];
  showTrackMenu(event: { clientX: number; clientY: number; preventDefault(): void }, track: TrackDto, options?: TrackMenuOptions): void;
  showMenuAt(x: number, y: number, items: readonly MenuItem[]): void;
  askCreatePlaylist(trackIds?: readonly string[]): void;
  askAddToPlaylist(trackIds: readonly string[]): void;
  askDeletePlaylist(playlist: PlaylistDto): void;
  askClear(): void;
  confirmRemoveRoot(rootId: string, name: string): void;
}

export function createActions(services: AppServices): Actions {
  const { playback, library, collections, ui } = services;
  const state = {
    ui: () => ui.getState(),
    playback: () => playback.getState(),
    collections: () => collections.getState(),
  };

  const playlistSubmenu = (trackIds: readonly string[]): readonly MenuItem[] => {
    const lists = state.collections().playlists.items;
    return [
      { kind: 'item', id: 'new-playlist', label: 'New playlist…', icon: 'plus', run: () => state.ui().openModal({ kind: 'create-playlist', trackIds }) },
      ...(lists.length === 0 ? [] : ([{ kind: 'sep' }] as const)),
      ...lists.map((list): MenuItem => ({ kind: 'item', id: `pl-${list.id}`, label: list.name, icon: 'playlist', run: () => void state.collections().addToPlaylist(list.id, trackIds, list.name) })),
    ];
  };

  const actions: Actions = {
    playTrack: (trackId, context) => void state.playback().playTrack(trackId, context),
    playNext: (trackId, label) => void state.playback().enqueue({ position: 'next', trackId }, label),
    addToQueue: (trackId, label) => void state.playback().enqueue({ position: 'last', trackId }, label),
    playGroup: (group) => void state.playback().playGroup({ kind: group.kind, key: group.key }),
    queueGroup: (group, position) => void state.playback().enqueue({ position, group: { kind: group.kind, key: group.key } }, group.name),
    playList: (source, options) => void state.playback().playList(source, options),
    queueList: (source, position, label) => void state.playback().enqueue({ position, source }, label),
    go: (route) => state.ui().navigate(route),

    goToGroupByName(kind, name, artist) {
      const wanted = name.trim().toLowerCase();
      const view = kind === 'album' ? 'albums' : 'artists';
      library.getState().setView(view);
      const find = (): GroupDto | undefined => {
        const { groups } = library.getState();
        if (groups.kind !== kind || groups.status !== 'ready') return undefined;
        const named = groups.items.filter((item) => item.name.trim().toLowerCase() === wanted);
        return (artist === undefined ? named[0] : named.find((item) => item.artist?.trim().toLowerCase() === artist.trim().toLowerCase())) ?? named[0];
      };
      const open = (group: GroupDto): void => state.ui().navigate({ name: 'group', kind, key: group.key });
      const now = find();
      if (now !== undefined) return open(now);
      const stop = library.subscribe(() => {
        const found = find();
        if (found === undefined) return;
        stop();
        open(found);
      });
      setTimeout(stop, 5_000); // gave up: the group was not found
    },

    trackMenu(track, options = {}) {
      const favorite = state.collections().favoriteIds.has(track.id);
      const items: MenuItem[] = [
        { kind: 'item', id: 'play', label: 'Play', icon: 'play', run: () => actions.playTrack(track.id, options.context) },
        { kind: 'item', id: 'next', label: 'Play next', icon: 'nextUp', run: () => actions.playNext(track.id, track.title) },
        { kind: 'item', id: 'queue', label: 'Add to queue', icon: 'addQueue', run: () => actions.addToQueue(track.id, track.title) },
        { kind: 'sep' },
        { kind: 'item', id: 'fav', label: favorite ? 'Remove from Favorites' : 'Add to Favorites', icon: 'heart', run: () => void state.collections().toggleFavorite(track.id) },
        { kind: 'item', id: 'edit-info', label: 'Edit song info…', icon: 'edit', run: () => state.ui().openModal({ kind: 'edit-info', track }) },
        { kind: 'submenu', id: 'playlist', label: 'Add to playlist', icon: 'playlist', build: () => playlistSubmenu([track.id]) },
      ];
      if (options.playlist !== undefined) {
        const { id, name, entryId } = options.playlist;
        items.push({ kind: 'item', id: 'remove', label: `Remove from "${name}"`, icon: 'trash', danger: true, run: () => void state.collections().removeEntries(id, [entryId]) });
      }
      items.push({ kind: 'sep' });
      if (track.album !== undefined) items.push({ kind: 'item', id: 'album', label: 'Go to album', icon: 'albums', run: () => actions.goToGroupByName('album', track.album as string, track.albumArtist ?? track.artist) });
      items.push({ kind: 'item', id: 'artist', label: 'Go to artist', icon: 'artists', run: () => actions.goToGroupByName('artist', track.albumArtist ?? track.artist) });
      return items;
    },

    groupMenu(group) {
      return [
        { kind: 'item', id: 'play', label: 'Play', icon: 'play', run: () => actions.playGroup(group) },
        { kind: 'item', id: 'next', label: 'Play next', icon: 'nextUp', run: () => actions.queueGroup(group, 'next') },
        { kind: 'item', id: 'queue', label: 'Add to queue', icon: 'addQueue', run: () => actions.queueGroup(group, 'last') },
        { kind: 'sep' },
        { kind: 'item', id: 'open', label: 'Open', icon: group.kind === 'artist' ? 'artists' : group.kind === 'genre' ? 'genres' : 'albums', run: () => actions.go({ name: 'group', kind: group.kind, key: group.key }) },
      ];
    },

    playlistMenu(playlist) {
      const source: ListSourceDto = { kind: 'playlist', playlistId: playlist.id };
      return [
        { kind: 'item', id: 'play', label: 'Play', icon: 'play', disabled: playlist.trackCount === 0, run: () => actions.playList(source) },
        { kind: 'item', id: 'shuffle', label: 'Shuffle play', icon: 'shuffle', disabled: playlist.trackCount === 0, run: () => actions.playList(source, { shuffle: true }) },
        { kind: 'item', id: 'next', label: 'Play next', icon: 'nextUp', disabled: playlist.trackCount === 0, run: () => actions.queueList(source, 'next', playlist.name) },
        { kind: 'item', id: 'queue', label: 'Add to queue', icon: 'addQueue', disabled: playlist.trackCount === 0, run: () => actions.queueList(source, 'last', playlist.name) },
        { kind: 'sep' },
        { kind: 'item', id: 'rename', label: 'Rename', icon: 'edit', run: () => state.ui().openModal({ kind: 'rename-playlist', playlist }) },
        { kind: 'item', id: 'delete', label: 'Delete playlist', icon: 'trash', danger: true, run: () => actions.askDeletePlaylist(playlist) },
      ];
    },

    showTrackMenu(event, track, options) {
      event.preventDefault();
      actions.showMenuAt(event.clientX, event.clientY, actions.trackMenu(track, options));
    },
    showMenuAt: (x, y, items) => state.ui().openMenu({ x, y, items }),

    askCreatePlaylist: (trackIds = []) => state.ui().openModal({ kind: 'create-playlist', trackIds }),
    askAddToPlaylist: (trackIds) => state.ui().openModal({ kind: 'add-to-playlist', trackIds }),
    confirmRemoveRoot(rootId, name) {
      state.ui().openModal({ kind: 'confirm', title: `Remove "${name}"?`, body: 'The folder and its files stay on your computer. Its songs are removed from your library.', confirmLabel: 'Remove', danger: true, onConfirm: () => void library.getState().removeRoot(rootId) });
    },
    askClear() {
      state.ui().openModal({ kind: 'confirm', title: 'Clear recently played?', body: 'This only clears the list. Your music is not touched.', confirmLabel: 'Clear', danger: true, onConfirm: () => void state.collections().clearHistory() });
    },
    askDeletePlaylist(playlist) {
      state.ui().openModal({
        kind: 'confirm',
        title: `Delete "${playlist.name}"?`,
        body: 'The songs stay in your library; only the playlist is removed.',
        confirmLabel: 'Delete',
        danger: true,
        onConfirm: () => {
          void state.collections().deletePlaylist(playlist.id).then((removed) => {
            const route = state.ui().route;
            if (removed && route.name === 'playlist' && route.id === playlist.id) state.ui().navigate({ name: 'playlists' });
          });
        },
      });
    },
  };
  return actions;
}

export function useActions(): Actions {
  const services = useServices();
  return useMemo(() => createActions(services), [services]);
}

/** Adds a music folder and, if one was really added, scans it straight away so songs show up without another click. */
export async function addFolderAndScan(library: AppServices['library']): Promise<void> {
  const before = library.getState().roots.length;
  await library.getState().addRoot();
  if (library.getState().roots.length > before) await library.getState().startScan();
}
