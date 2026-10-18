import type { ListSourceDto } from './collections-ipc.js';
import type { TrackDto } from './library-ipc.js';

/**
 * Phase 5: library browsing (album / artist / genre groups and sorting) and the
 * queue view/editing payloads. Like `library-ipc.ts`, this file imports no
 * runtime code: plain serializable data, optional fields are ABSENT keys, no
 * file paths anywhere. The grouping and sorting rules themselves live in the
 * domain and run in the main process; the renderer only displays the result.
 */

export type TrackSortFieldDto = 'title' | 'artist' | 'album' | 'albumArtist' | 'genre' | 'year' | 'duration';
export type SortDirectionDto = 'asc' | 'desc';

export interface TrackSortDto {
  readonly field: TrackSortFieldDto;
  readonly direction: SortDirectionDto;
}

export type GroupKindDto = 'album' | 'artist' | 'genre';

/** An album, artist or genre, with counts. `key` is opaque: pass it back unchanged. */
export interface GroupDto {
  readonly kind: GroupKindDto;
  readonly key: string;
  readonly name: string;
  /** The "Unknown Album/Artist/Genre" group. */
  readonly unknown: boolean;
  readonly trackCount: number;
  /** Seconds; absent when no track in the group has a duration. */
  readonly durationSeconds?: number;
  /** Albums only: who the album is by. */
  readonly artist?: string;
  /** Albums only: the earliest known year. */
  readonly year?: number;
  /** Artists only: number of albums. */
  readonly albumCount?: number;
  /** A track of the group to take its cover from (one with artwork when there is one). */
  readonly coverTrackId?: string;
}

export interface GroupRefDto {
  readonly kind: GroupKindDto;
  readonly key: string;
}

export interface LibrarySummaryDto {
  readonly trackCount: number;
  readonly albumCount: number;
  readonly artistCount: number;
  readonly genreCount: number;
}

export interface ListGroupsRequest {
  readonly kind: GroupKindDto;
}
export interface ListGroupsResponse {
  readonly kind: GroupKindDto;
  readonly groups: readonly GroupDto[];
}

export interface GetGroupRequest {
  readonly kind: GroupKindDto;
  readonly key: string;
  /** Omit for the group's natural order (albums: disc/track; artists: album by album). */
  readonly sort?: TrackSortDto;
}
export interface GetGroupResponse {
  readonly group: GroupDto;
  readonly tracks: readonly TrackDto[];
}

/* ------------------------------ queue ------------------------------ */

export interface QueueItemDto {
  /** Absolute position in the queue (0-based). */
  readonly position: number;
  readonly track: TrackDto;
}

export interface GetQueueRequest {
  /** Default 0. */
  readonly offset?: number;
  /** Default 200, maximum 1 000. */
  readonly limit?: number;
}
export interface QueueDto {
  /** The playback revision this window was read at. */
  readonly revision: number;
  readonly total: number;
  readonly currentIndex?: number;
  readonly offset: number;
  readonly items: readonly QueueItemDto[];
}

export type EnqueuePosition = 'next' | 'last';

/** Exactly one of `trackId` / `group`. */
export interface EnqueueRequest {
  readonly position: EnqueuePosition;
  readonly trackId?: string;
  readonly group?: GroupRefDto;
  /** Phase 11: a whole favourites / recently-played / playlist list. Exactly one of `trackId`, `group`, `source`. */
  readonly source?: ListSourceDto;
}

export interface PlayGroupRequest {
  readonly group: GroupRefDto;
  readonly sort?: TrackSortDto;
}

/** Queue edits name the item by position AND track id: if the queue changed since the
 *  renderer last looked (the ids no longer match), main does nothing and answers with the
 *  current state, so a stale click can never remove or move the wrong track. */
export interface QueueItemRequest {
  readonly index: number;
  readonly trackId: string;
}
export interface MoveQueueItemRequest extends QueueItemRequest {
  readonly toIndex: number;
}
