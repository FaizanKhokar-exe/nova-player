/**
 * Single source of truth for the IPC boundary.
 *
 * Every channel has exactly one request type and one response type, defined
 * once here and imported by both the main process and the preload bridge.
 * This is what gives the IPC boundary compile-time checking instead of the
 * reference app's implicit, comment-only channel contracts.
 *
 * Phase 0 intentionally defines only the channels needed to prove the
 * round trip and the infrastructure spikes work. Real feature channels
 * (library scan, playback, playlists, ...) are added starting Phase 1.
 */

/**
 * Minimal placeholder DTO, used only so the domain and UI packages have a
 * real cross-package type to exercise in their Phase 0 smoke tests. The
 * actual Track entity (with its full field set) is defined in Phase 1
 * alongside the SQLite schema, not here.
 */
export interface TrackSummary {
  readonly id: string;
  readonly title: string;
}

export * from './library-ipc.js';
export * from './browse-ipc.js';
export * from './track-detail-ipc.js';
export * from './playback-ipc.js';
export * from './collections-ipc.js';
import type {
  AddToPlaylistRequest,
  AddToPlaylistResponse,
  ChooseWallpaperResponse,
  ClearWallpaperResponse,
  CreatePlaylistRequest,
  DeletePlaylistResponse,
  FavoriteIdsResponse,
  FavoritesListResponse,
  GetPlaylistResponse,
  GetThumbnailRequest,
  HistoryClearResponse,
  HistoryListRequest,
  HistoryListResponse,
  MovePlaylistEntryRequest,
  PlayListRequest,
  PlaylistRefRequest,
  PlaylistResponse,
  PlaylistsListResponse,
  RemoveFromPlaylistRequest,
  RenamePlaylistRequest,
  SetFavoriteRequest,
  SetFavoriteResponse,
  ThumbnailDto,
  WallpaperDto,
} from './collections-ipc.js';
import type { ArtworkDto, AttachLyricsResultDto, DetachLyricsResultDto, LyricsDto, TrackRefRequest } from './track-detail-ipc.js';
import type {
  EnqueueRequest,
  GetGroupRequest,
  GetGroupResponse,
  GetQueueRequest,
  LibrarySummaryDto,
  ListGroupsRequest,
  ListGroupsResponse,
  MoveQueueItemRequest,
  PlayGroupRequest,
  QueueDto,
  QueueItemRequest,
} from './browse-ipc.js';
import type {
  DiagnoseSourceRequest,
  DiagnoseSourceResponse,
  PlaybackCommandResultDto,
  PlaybackStateDto,
  PlayTrackRequest,
  PositionedRequest,
  ReportPositionRequest,
  ReportPositionResponse,
  SetRepeatModeRequest,
  SetShuffleRequest,
  TrackFinishedRequest,
} from './playback-ipc.js';
import type {
  AddRootResponse,
  CancelScanResponse,
  IpcEventChannel,
  IpcEventPayload,
  IpcResult,
  ListRootsResponse,
  ListTracksRequest,
  ListTracksResponse,
  RemoveRootRequest,
  RemoveRootResponse,
  ScanStateDto,
  SearchTracksRequest,
  SearchTracksResponse,
  StartScanRequest,
  StartScanResponse,
  WatcherStatusDto,
} from './library-ipc.js';

/** The library channels (Phase 3 half 1). Every one answers with an `IpcResult`. */
export interface LibraryIpcContract {
  'library:listRoots': { request: void; response: IpcResult<ListRootsResponse> };
  /** Opens the OS folder picker in the main process; the renderer supplies no path. */
  'library:addRoot': { request: void; response: IpcResult<AddRootResponse> };
  'library:removeRoot': { request: RemoveRootRequest; response: IpcResult<RemoveRootResponse> };
  /** Starts a scan in the background and returns at once; follow it with the scan events. */
  'library:startScan': { request: StartScanRequest; response: IpcResult<StartScanResponse> };
  'library:cancelScan': { request: void; response: IpcResult<CancelScanResponse> };
  /** The current/last scan, for a renderer that (re)loaded mid-scan. */
  'library:getScanState': { request: void; response: IpcResult<ScanStateDto> };
  'library:listTracks': { request: ListTracksRequest; response: IpcResult<ListTracksResponse> };
  'library:search': { request: SearchTracksRequest; response: IpcResult<SearchTracksResponse> };
  'library:getSummary': { request: void; response: IpcResult<LibrarySummaryDto> };
  'library:listGroups': { request: ListGroupsRequest; response: IpcResult<ListGroupsResponse> };
  'library:getGroup': { request: GetGroupRequest; response: IpcResult<GetGroupResponse> };
  'library:startWatching': { request: void; response: IpcResult<WatcherStatusDto> };
  'library:stopWatching': { request: void; response: IpcResult<WatcherStatusDto> };
  'library:getWatcherStatus': { request: void; response: IpcResult<WatcherStatusDto> };
}

/** The playback channels (Phase 4). Every one answers with an `IpcResult`. */
export interface PlaybackIpcContract {
  'playback:getState': { request: void; response: IpcResult<PlaybackStateDto> };
  /** Replaces the queue with a list (the library, or a search) and starts the given track. */
  'playback:playTrack': { request: PlayTrackRequest; response: IpcResult<PlaybackCommandResultDto> };
  'playback:next': { request: PositionedRequest; response: IpcResult<PlaybackCommandResultDto> };
  'playback:previous': { request: PositionedRequest; response: IpcResult<PlaybackCommandResultDto> };
  /** The current track ended on its own; main decides what plays next. */
  'playback:trackFinished': { request: TrackFinishedRequest; response: IpcResult<PlaybackCommandResultDto> };
  'playback:setRepeatMode': { request: SetRepeatModeRequest; response: IpcResult<PlaybackStateDto> };
  'playback:setShuffle': { request: SetShuffleRequest; response: IpcResult<PlaybackStateDto> };
  /** Saves the current position (whole ms) so a restart can resume. */
  'playback:reportPosition': { request: ReportPositionRequest; response: IpcResult<ReportPositionResponse> };
  /** Asks main why a track's media failed to load, so the UI can say something useful. */
  'playback:diagnoseSource': { request: DiagnoseSourceRequest; response: IpcResult<DiagnoseSourceResponse> };
  'playback:playGroup': { request: PlayGroupRequest; response: IpcResult<PlaybackCommandResultDto> };
  'playback:enqueue': { request: EnqueueRequest; response: IpcResult<PlaybackCommandResultDto> };
  'playback:getQueue': { request: GetQueueRequest; response: IpcResult<QueueDto> };
  'playback:playQueueItem': { request: QueueItemRequest; response: IpcResult<PlaybackCommandResultDto> };
  'playback:removeFromQueue': { request: QueueItemRequest; response: IpcResult<PlaybackCommandResultDto> };
  'playback:moveQueueItem': { request: MoveQueueItemRequest; response: IpcResult<PlaybackCommandResultDto> };
  'playback:clearQueue': { request: void; response: IpcResult<PlaybackCommandResultDto> };
  'track:getLyrics': { request: TrackRefRequest; response: IpcResult<LyricsDto> };
  'track:getArtwork': { request: TrackRefRequest; response: IpcResult<ArtworkDto> };
  /** Asks main to show a file dialog and attach the chosen `.lrc` file to the track as its lyrics. */
  'track:attachLyrics': { request: TrackRefRequest; response: IpcResult<AttachLyricsResultDto> };
  /** Removes lyrics attached by hand. */
  'track:detachLyrics': { request: TrackRefRequest; response: IpcResult<DetachLyricsResultDto> };
}

export interface PingRequest {
  readonly nonce: string;
}

export interface PingResponse {
  readonly nonce: string;
  readonly pong: true;
  readonly receivedAtMs: number;
}

export interface DatabaseDiagnosticsResponse {
  readonly ok: boolean;
  readonly driver: 'better-sqlite3';
  readonly sqliteVersion: string;
  readonly rowCountAfterInsert: number;
  readonly insertDurationMs: number;
  readonly error?: string;
}

/**
 * Request/response channels (renderer calls, main answers).
 */
export interface SeekSpikeMediaUrlResponse {
  readonly url: string;
  readonly absolutePath: string;
}

/** Phase 11 channels: favourites, recently played, playlists, thumbnails, wallpaper. */
export interface CollectionsIpcContract {
  'favorites:list': { request: void; response: IpcResult<FavoritesListResponse> };
  'favorites:ids': { request: void; response: IpcResult<FavoriteIdsResponse> };
  'favorites:set': { request: SetFavoriteRequest; response: IpcResult<SetFavoriteResponse> };
  'history:list': { request: HistoryListRequest; response: IpcResult<HistoryListResponse> };
  'history:clear': { request: void; response: IpcResult<HistoryClearResponse> };
  'playlists:list': { request: void; response: IpcResult<PlaylistsListResponse> };
  'playlists:create': { request: CreatePlaylistRequest; response: IpcResult<PlaylistResponse> };
  'playlists:rename': { request: RenamePlaylistRequest; response: IpcResult<PlaylistResponse> };
  'playlists:delete': { request: PlaylistRefRequest; response: IpcResult<DeletePlaylistResponse> };
  'playlists:get': { request: PlaylistRefRequest; response: IpcResult<GetPlaylistResponse> };
  'playlists:addTracks': { request: AddToPlaylistRequest; response: IpcResult<AddToPlaylistResponse> };
  'playlists:removeEntries': { request: RemoveFromPlaylistRequest; response: IpcResult<GetPlaylistResponse> };
  'playlists:moveEntry': { request: MovePlaylistEntryRequest; response: IpcResult<GetPlaylistResponse> };
  'playback:playList': { request: PlayListRequest; response: IpcResult<PlaybackCommandResultDto> };
  'track:getThumbnail': { request: GetThumbnailRequest; response: IpcResult<ThumbnailDto> };
  /** The stored wallpaper (a downscaled copy), if any. */
  'wallpaper:get': { request: void; response: IpcResult<WallpaperDto> };
  /** Shows a file dialog in main and, if the picture passes `WALLPAPER_LIMITS`, stores it as the wallpaper. */
  'wallpaper:choose': { request: void; response: IpcResult<ChooseWallpaperResponse> };
  'wallpaper:clear': { request: void; response: IpcResult<ClearWallpaperResponse> };
}

export interface IpcContract extends LibraryIpcContract, PlaybackIpcContract, CollectionsIpcContract {
  'app:ping': { request: PingRequest; response: PingResponse };
  'diagnostics:checkDatabase': { request: void; response: DatabaseDiagnosticsResponse };
  /**
   * Phase 0 spike only (validation item J / objective I). Returns the
   * nova-media:// URL for the one fixture file the main process allowlists
   * for this spike, so the E2E test and the main process build the URL via
   * the exact same code path instead of duplicating the encoding logic.
   */
  'diagnostics:getSeekSpikeMediaUrl': { request: void; response: SeekSpikeMediaUrlResponse };
}

export type IpcChannel = keyof IpcContract;

/** Every request/response channel, at runtime. The preload refuses to invoke
 *  anything not listed here, so the bridge stays exactly this contract. */
export const IPC_INVOKE_CHANNELS = [
  'app:ping',
  'diagnostics:checkDatabase',
  'diagnostics:getSeekSpikeMediaUrl',
  'library:listRoots',
  'library:addRoot',
  'library:removeRoot',
  'library:startScan',
  'library:cancelScan',
  'library:getScanState',
  'library:listTracks',
  'library:search',
  'library:getSummary',
  'library:listGroups',
  'library:getGroup',
  'library:startWatching',
  'library:stopWatching',
  'library:getWatcherStatus',
  'playback:getState',
  'playback:playTrack',
  'playback:next',
  'playback:previous',
  'playback:trackFinished',
  'playback:setRepeatMode',
  'playback:setShuffle',
  'playback:reportPosition',
  'playback:diagnoseSource',
  'playback:playGroup',
  'playback:enqueue',
  'playback:getQueue',
  'playback:playQueueItem',
  'playback:removeFromQueue',
  'playback:moveQueueItem',
  'playback:clearQueue',
  'track:getLyrics',
  'track:getArtwork',
  'track:attachLyrics',
  'track:detachLyrics',
  'favorites:list',
  'favorites:ids',
  'favorites:set',
  'history:list',
  'history:clear',
  'playlists:list',
  'playlists:create',
  'playlists:rename',
  'playlists:delete',
  'playlists:get',
  'playlists:addTracks',
  'playlists:removeEntries',
  'playlists:moveEntry',
  'playback:playList',
  'track:getThumbnail',
  'wallpaper:get',
  'wallpaper:choose',
  'wallpaper:clear',
] as const satisfies readonly IpcChannel[];

// Compile-time guarantee that the list above is complete.
type MissingInvokeChannel = Exclude<IpcChannel, (typeof IPC_INVOKE_CHANNELS)[number]>;
export const invokeChannelListIsComplete: MissingInvokeChannel extends never ? true : never = true;

export type IpcRequest<K extends IpcChannel> = IpcContract[K]['request'];
export type IpcResponse<K extends IpcChannel> = IpcContract[K]['response'];

/**
 * The exact shape of the API the preload script exposes on
 * `window.nova`. Deliberately narrow: no filesystem access, no raw
 * ipcRenderer, no Node globals - only this one typed invoke function.
 */
export interface NovaBridge {
  invoke<K extends IpcChannel>(channel: K, request: IpcRequest<K>): Promise<IpcResponse<K>>;
  /**
   * Subscribes to a main-process event (see `IpcEventContract`). The listener
   * receives only the payload - never the Electron event object. Returns the
   * function that unsubscribes.
   */
  subscribe<E extends IpcEventChannel>(event: E, listener: (payload: IpcEventPayload<E>) => void): () => void;
}
