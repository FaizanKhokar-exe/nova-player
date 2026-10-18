/**
 * Phase 4: the typed IPC surface for playback.
 *
 * Same conventions as `library-ipc.ts`: everything here is a plain,
 * serializable DTO; every channel answers with an `IpcResult`; optional
 * fields are ABSENT rather than `null`; and NO file path ever crosses this
 * boundary. The renderer learns a track's `mediaUrl` - an opaque
 * `nova-media://track/<TrackId>` address that only the main process can
 * resolve (to a file inside a currently registered library folder) - and
 * nothing else about where the file lives.
 *
 * Positions are whole MILLISECONDS (the domain's canonical playback unit);
 * the browser's seconds are converted at the renderer's media boundary.
 *
 * Who owns what: the main process owns the queue (the Phase 1 domain rules
 * run there); the renderer's <audio> element owns the actual playback. The
 * renderer asks main what to play next and plays what it is told.
 */
import type { ListSourceDto } from './collections-ipc.js';
import type { GroupRefDto, TrackSortDto } from './browse-ipc.js';
import type { TrackDto } from './library-ipc.js';

export type RepeatModeDto = 'off' | 'all' | 'one';

export interface PlaybackCurrentDto {
  readonly track: TrackDto;
  /** Opaque media address for the <audio> element. Not a file path. */
  readonly mediaUrl: string;
}

export interface PlaybackStateDto {
  /** Increases with every change; lets a renderer drop an out-of-date snapshot. */
  readonly revision: number;
  /** Absent when nothing is queued. */
  readonly current?: PlaybackCurrentDto;
  /** The last known position of the current track (whole ms). 0 when there is none. */
  readonly positionMs: number;
  readonly repeatMode: RepeatModeDto;
  readonly shuffle: boolean;
  readonly queueLength: number;
  /** 0-based position of the current track in the active (possibly shuffled) order. */
  readonly queueIndex?: number;
  /** Whether pressing Next would go anywhere (decided by the domain rules). */
  readonly canNext: boolean;
}

/**
 * What the renderer must DO about the new state:
 *  - `started`: a different track became current - load its `mediaUrl` and play it.
 *  - `restart`: the same track again - seek to 0 and play.
 *  - `stop`: the queue is exhausted - stay stopped on the current track.
 *  - `none`: nothing to do (e.g. Next with no next track).
 */
export type PlaybackOutcomeDto = 'started' | 'restart' | 'stop' | 'none';

export interface PlaybackCommandResultDto {
  readonly outcome: PlaybackOutcomeDto;
  readonly state: PlaybackStateDto;
}

/** Which list a played track is queued from. The renderer names the list; main builds
 *  the queue from its own data, so no long list of ids crosses IPC. */
export type PlaybackContextDto =
  | { readonly kind: 'library'; readonly sort?: TrackSortDto }
  | { readonly kind: 'search'; readonly query: string }
  | { readonly kind: 'group'; readonly group: GroupRefDto; readonly sort?: TrackSortDto }
  /** Phase 11: favourites, recently played or a playlist. */
  | { readonly kind: 'list'; readonly source: ListSourceDto };

export interface PlayTrackRequest {
  readonly trackId: string;
  /** Default: the whole library. */
  readonly context?: PlaybackContextDto;
}
/** `positionMs` is where playback is right now (the domain's Previous rule depends on it). */
export interface PositionedRequest {
  readonly positionMs: number;
}
export interface TrackFinishedRequest {
  /** The track that finished. A report about a track that is no longer current is ignored. */
  readonly trackId: string;
}
export interface SetRepeatModeRequest {
  readonly mode: RepeatModeDto;
}
export interface SetShuffleRequest {
  readonly enabled: boolean;
}
export interface ReportPositionRequest {
  readonly trackId: string;
  readonly positionMs: number;
}
export interface ReportPositionResponse {
  /** `false` when the report was about a track that is no longer current. */
  readonly saved: boolean;
}

/** Why a track's media cannot be opened, in terms safe to show a user. */
export type MediaProblemDto =
  | 'not-in-library'
  | 'file-missing'
  | 'file-inaccessible'
  | 'folder-unavailable'
  | 'unsupported-format'
  | 'invalid-source';

export interface DiagnoseSourceRequest {
  readonly trackId: string;
}
export interface DiagnoseSourceResponse {
  /** Absent when main can open the file fine (so a failure is the decoder's: unsupported or damaged media). */
  readonly problem?: MediaProblemDto;
}

export type PlaybackChangeReasonDto =
  /** The track list changed; this is the refreshed snapshot (e.g. new metadata). */
  | 'library-changed'
  /** The current track left the library; the queue moved on but nothing is playing. */
  | 'track-removed';

export interface PlaybackStateChangedEvent {
  readonly reason: PlaybackChangeReasonDto;
  readonly state: PlaybackStateDto;
}
