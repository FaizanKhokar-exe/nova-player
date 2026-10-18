/**
 * Phase 11: the typed IPC surface for the listener's own collections (favourites, recently played,
 * playlists), cover thumbnails and the custom wallpaper. Like the other IPC files this is plain,
 * serializable data with no runtime imports; optional fields are ABSENT keys, never `null`; no file
 * path ever crosses this boundary (tracks are named by id, images travel as small `data:` URLs).
 */

import type { TrackDto } from './library-ipc.js';

/* ------------------------------ lists ------------------------------ */

/** A list main can build a queue from by itself, so no long list of ids crosses IPC. */
export type ListSourceDto = { readonly kind: 'favorites' } | { readonly kind: 'history' } | { readonly kind: 'playlist'; readonly playlistId: string };

export interface PlayListRequest {
  readonly source: ListSourceDto;
  /** Start here (must be in the list); default: the first track, or a random one when `shuffle`. */
  readonly startTrackId?: string;
  /** Turn shuffle on before starting. */
  readonly shuffle?: boolean;
}

/* ---------------------------- favourites --------------------------- */

export interface FavoritesListResponse {
  /** Most recently favourited first. */
  readonly tracks: readonly TrackDto[];
  readonly total: number;
}
export interface FavoriteIdsResponse {
  readonly trackIds: readonly string[];
}
export interface SetFavoriteRequest {
  readonly trackId: string;
  readonly favorite: boolean;
}
export interface SetFavoriteResponse {
  readonly trackId: string;
  readonly favorite: boolean;
}

/* ------------------------- recently played ------------------------- */

export interface HistoryItemDto {
  readonly track: TrackDto;
  /** When it was last played (ms since the Unix epoch). */
  readonly playedAtMs: number;
}
export interface HistoryListRequest {
  /** Default 50, at most 200. */
  readonly limit?: number;
}
export interface HistoryListResponse {
  /** Each track once, most recently played first. */
  readonly items: readonly HistoryItemDto[];
}
export interface HistoryClearResponse {
  readonly cleared: number;
}

/* ----------------------------- playlists --------------------------- */

export const PLAYLIST_LIMITS = { maxPlaylists: 200, maxEntries: 10_000, maxNameLength: 80 } as const;

export interface PlaylistDto {
  readonly id: string;
  readonly name: string;
  readonly trackCount: number;
  /** Seconds; absent when no track has a duration. */
  readonly durationSeconds?: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  /** Up to four track ids (distinct covers preferred) to build a mosaic cover from. */
  readonly coverTrackIds: readonly string[];
}

/** One row of a playlist. The same track may appear twice; `entryId` tells the rows apart. */
export interface PlaylistEntryDto {
  readonly entryId: string;
  readonly track: TrackDto;
}

export interface PlaylistRefRequest {
  readonly playlistId: string;
}
export interface PlaylistsListResponse {
  readonly playlists: readonly PlaylistDto[];
}
export interface CreatePlaylistRequest {
  readonly name: string;
  /** Optionally start with these tracks. */
  readonly trackIds?: readonly string[];
}
export interface RenamePlaylistRequest extends PlaylistRefRequest {
  readonly name: string;
}
export interface PlaylistResponse {
  readonly playlist: PlaylistDto;
}
export interface DeletePlaylistResponse {
  readonly removed: boolean;
}
export interface GetPlaylistResponse {
  readonly playlist: PlaylistDto;
  readonly entries: readonly PlaylistEntryDto[];
}
export interface AddToPlaylistRequest extends PlaylistRefRequest {
  readonly trackIds: readonly string[];
}
export interface AddToPlaylistResponse {
  readonly playlist: PlaylistDto;
  /** How many were added (unknown ids are skipped; the limit may cut the list short). */
  readonly added: number;
}
export interface RemoveFromPlaylistRequest extends PlaylistRefRequest {
  readonly entryIds: readonly string[];
}
export interface MovePlaylistEntryRequest extends PlaylistRefRequest {
  readonly entryId: string;
  /** 0-based position the entry ends up at. */
  readonly toIndex: number;
}

/* ---------------------------- thumbnails --------------------------- */

/** `sm` = 128 px (rows, tiles), `md` = 384 px (headers, cards). JPEG, produced and cached in main. */
export type ThumbnailSizeDto = 'sm' | 'md';
export interface GetThumbnailRequest {
  readonly trackId: string;
  readonly size: ThumbnailSizeDto;
}
export type ThumbnailDto = { readonly status: 'found'; readonly dataUrl: string } | { readonly status: 'none' };

/* ---------------------------- wallpaper ---------------------------- */

/** What a chosen picture must satisfy (main enforces it; the settings page shows it). */
export const WALLPAPER_LIMITS = {
  maxBytes: 12 * 1024 * 1024,
  minWidth: 800,
  minHeight: 450,
  maxDimension: 10_000,
  extensions: ['png', 'jpg', 'jpeg'],
  /** The stored copy is scaled down to fit this box and re-encoded as JPEG. */
  storedMaxWidth: 1920,
  storedMaxHeight: 1080,
} as const;

export type WallpaperDto = { readonly status: 'none' } | { readonly status: 'set'; readonly dataUrl: string; readonly width: number; readonly height: number };

/**
 *  - `set`: the picture is now the wallpaper
 *  - `cancelled`: the dialog was closed
 *  - `unsupported-type`: not a real PNG / JPEG / WebP (judged by content, not just the name)
 *  - `too-large`: over `WALLPAPER_LIMITS.maxBytes`
 *  - `too-small` / `too-big-dimensions`: outside the pixel limits
 *  - `unreadable`: could not be read or decoded
 */
export type ChooseWallpaperResponse =
  | { readonly outcome: 'set'; readonly wallpaper: Extract<WallpaperDto, { status: 'set' }> }
  | { readonly outcome: 'cancelled' | 'unsupported-type' | 'too-large' | 'too-small' | 'too-big-dimensions' | 'unreadable' };
export interface ClearWallpaperResponse {
  readonly removed: boolean;
}
