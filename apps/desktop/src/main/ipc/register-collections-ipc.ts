import type { CollectionsApplication, PlaybackApplication, PlaylistDetailView, PlaylistView, TrackThumbnails, WallpaperStore } from '@nova/infrastructure';
import type { CollectionsIpcContract, GetPlaylistResponse, IpcResult, PlaylistDto } from '@nova/shared';
import { toTrackDto } from './dto-mappers.js';
import {
  validateAddToPlaylist,
  validateCreatePlaylist,
  validateGetThumbnail,
  validateHistoryList,
  validateMovePlaylistEntry,
  validatePlayList,
  validatePlaylistRef,
  validateRemoveFromPlaylist,
  validateRenamePlaylist,
  validateSetFavorite,
} from './collections-validation.js';
import { ForbiddenSenderError, toIpcError } from './ipc-errors.js';
import { toPlaybackCommandResultDto } from './playback-dto-mappers.js';
import type { IpcRegistrar } from './register-library-ipc.js';
import { validateNoRequest } from './validation.js';

export interface CollectionsIpcDependencies {
  readonly registrar: IpcRegistrar;
  readonly collections: CollectionsApplication;
  readonly playback: PlaybackApplication;
  readonly thumbnails: TrackThumbnails;
  readonly wallpaper: WallpaperStore;
  /** The native "choose a picture" dialog: the chosen path, or `undefined` when cancelled. The renderer never supplies a path. */
  readonly pickWallpaperFile: () => Promise<string | undefined>;
  readonly isTrustedSender: (event: unknown) => boolean;
  readonly log: (message: string, error: unknown) => void;
}

type Channel = keyof CollectionsIpcContract;
type Value<K extends Channel> = Extract<CollectionsIpcContract[K]['response'], { ok: true }>['value'];

export function toPlaylistDto(view: PlaylistView): PlaylistDto {
  return {
    id: view.id,
    name: view.name,
    trackCount: view.trackCount,
    ...(view.durationSeconds !== undefined && { durationSeconds: view.durationSeconds }),
    createdAtMs: view.createdAtMs,
    updatedAtMs: view.updatedAtMs,
    coverTrackIds: view.coverTrackIds,
  };
}

function toPlaylistDetailDto(detail: PlaylistDetailView): GetPlaylistResponse {
  return { playlist: toPlaylistDto(detail.playlist), entries: detail.entries.map((entry) => ({ entryId: entry.entryId, track: toTrackDto(entry.track) })) };
}

/**
 * Registers the Phase 11 channels. The same shape as the library and playback handlers: check the sender, validate,
 * call ONE application service, map to a DTO. The wallpaper dialog lives here in main; the renderer only ever gets
 * the stored picture back as a data URL and never sees a path.
 */
export function registerCollectionsIpc(dependencies: CollectionsIpcDependencies): void {
  const { registrar, collections, playback, thumbnails, wallpaper, pickWallpaperFile, isTrustedSender, log } = dependencies;

  function register<K extends Channel, R>(channel: K, validate: (raw: unknown) => R, run: (request: R) => Promise<Value<K>> | Value<K>): void {
    registrar.handle(channel, async (event, raw): Promise<IpcResult<Value<K>>> => {
      try {
        if (!isTrustedSender(event)) throw new ForbiddenSenderError();
        const request = validate(raw);
        return { ok: true, value: await run(request) };
      } catch (error) {
        return { ok: false, error: toIpcError(error, channel, log) };
      }
    });
  }

  register('favorites:list', validateNoRequest, () => {
    const tracks = collections.listFavorites();
    return { tracks: tracks.map(toTrackDto), total: tracks.length };
  });
  register('favorites:ids', validateNoRequest, () => ({ trackIds: collections.listFavoriteIds() }));
  register('favorites:set', validateSetFavorite, (request) => ({ trackId: request.trackId, favorite: collections.setFavorite(request.trackId, request.favorite) }));

  register('history:list', validateHistoryList, (request) => ({
    items: collections.listHistory(request.limit).map((item) => ({ track: toTrackDto(item.track), playedAtMs: item.playedAtMs })),
  }));
  register('history:clear', validateNoRequest, () => ({ cleared: collections.clearHistory() }));

  register('playlists:list', validateNoRequest, () => ({ playlists: collections.listPlaylists().map(toPlaylistDto) }));
  register('playlists:create', validateCreatePlaylist, (request) => ({ playlist: toPlaylistDto(collections.createPlaylist(request.name, request.trackIds)) }));
  register('playlists:rename', validateRenamePlaylist, (request) => ({ playlist: toPlaylistDto(collections.renamePlaylist(request.playlistId, request.name)) }));
  register('playlists:delete', validatePlaylistRef, (request) => ({ removed: collections.deletePlaylist(request.playlistId) }));
  register('playlists:get', validatePlaylistRef, (request) => toPlaylistDetailDto(collections.getPlaylist(request.playlistId)));
  register('playlists:addTracks', validateAddToPlaylist, (request) => {
    const result = collections.addToPlaylist(request.playlistId, request.trackIds);
    return { playlist: toPlaylistDto(result.playlist), added: result.added };
  });
  register('playlists:removeEntries', validateRemoveFromPlaylist, (request) => toPlaylistDetailDto(collections.removeFromPlaylist(request.playlistId, request.entryIds)));
  register('playlists:moveEntry', validateMovePlaylistEntry, (request) => toPlaylistDetailDto(collections.movePlaylistEntry(request.playlistId, request.entryId, request.toIndex)));

  register('playback:playList', validatePlayList, (request) =>
    toPlaybackCommandResultDto(
      playback.playList({
        source: request.source,
        ...(request.startTrackId !== undefined && { startTrackId: request.startTrackId }),
        ...(request.shuffle !== undefined && { shuffle: request.shuffle }),
      }),
    ),
  );

  register('track:getThumbnail', validateGetThumbnail, (request) => thumbnails.get(request.trackId, request.size));

  register('wallpaper:get', validateNoRequest, () => wallpaper.get());
  register('wallpaper:choose', validateNoRequest, async () => {
    const chosen = await pickWallpaperFile();
    if (chosen === undefined) return { outcome: 'cancelled' as const };
    return wallpaper.setFromFile(chosen);
  });
  register('wallpaper:clear', validateNoRequest, async () => ({ removed: await wallpaper.clear() }));
}
