/**
 * Phase 3 (half 1): the typed IPC surface for the library.
 *
 * Everything in this file is a DTO - plain, serializable data that is safe to
 * hand to the renderer. None of it is a database row, a domain object, a Node
 * or Electron type, an Error, a callback or a class instance. The main
 * process builds these from the application layer's results (see
 * apps/desktop/src/main/ipc/dto-mappers.ts); the renderer only ever sees them.
 *
 * Conventions
 *  - Every library channel answers with an `IpcResult`: `{ ok: true, value }`
 *    or `{ ok: false, error }`. Failures never travel as thrown `Error`s, so no
 *    stack trace, Node internals or SQLite detail can leak.
 *  - Optional fields are simply ABSENT when there is no value (never `null`).
 *  - Times are whole milliseconds since the Unix epoch; durations of tracks
 *    are in seconds (the domain's unit).
 *  - Paths appear only for the library folders the user chose themselves
 *    (`RootDto.path`, for display). Track file paths never cross this boundary.
 */

import type { TrackSortDto } from './browse-ipc.js';
import type { PlaybackStateChangedEvent } from './playback-ipc.js';

/* ------------------------------------------------------------------ *
 * Errors and results
 * ------------------------------------------------------------------ */

/** Stable, machine-readable failure identifiers a renderer may branch on. */
export type IpcErrorCode =
  /** The request was malformed (wrong shape or out-of-range value). */
  | 'invalid-request'
  /** The call did not come from the application's own window. */
  | 'forbidden'
  /** A path string was unusable. */
  | 'invalid-path'
  | 'root-unavailable'
  | 'root-not-directory'
  | 'root-exists'
  | 'root-overlaps'
  | 'root-not-found'
  | 'no-roots'
  | 'scan-running'
  /** Playback: that track is not in the library. */
  | 'track-not-found'
  /** Browsing: that album/artist/genre no longer exists (the library changed). */
  | 'group-not-found'
  /** Playlists: that playlist no longer exists. */
  | 'playlist-not-found'
  /** A playlist name was empty or too long. */
  | 'name-invalid'
  /** A limit (playlists, entries) was reached. */
  | 'limit-reached'
  /** The disk refused something; the message says what, in plain words. */
  | 'filesystem-error'
  /** Anything unexpected. The details were logged in the main process only. */
  | 'internal';

export interface IpcError {
  readonly code: IpcErrorCode;
  /** Human-readable, safe to show to the user. */
  readonly message: string;
  /** The channel that failed. */
  readonly operation: string;
}

export type IpcResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: IpcError };

/* ------------------------------------------------------------------ *
 * DTOs
 * ------------------------------------------------------------------ */

export interface RootDto {
  readonly id: string;
  /** The folder the user chose, for display. */
  readonly path: string;
  readonly addedAtMs: number;
  /** The folder currently exists and can be opened. */
  readonly available: boolean;
  readonly trackCount: number;
  /** The folder watcher is currently watching it. */
  readonly watched: boolean;
}

export type ArtworkKindDto = 'embedded' | 'external' | 'none';

export interface TrackDto {
  readonly id: string;
  readonly title: string;
  readonly artist: string;
  readonly album?: string;
  readonly albumArtist?: string;
  readonly genre?: string;
  readonly trackNumber?: number;
  readonly discNumber?: number;
  readonly year?: number;
  /** Seconds. */
  readonly durationSeconds?: number;
  readonly artwork: ArtworkKindDto;
}

export type SearchMatchDto =
  | {
      readonly kind: 'field';
      readonly field: 'title' | 'artist' | 'albumArtist' | 'album' | 'genre';
      readonly quality: 'exact' | 'prefix' | 'substring';
    }
  | { readonly kind: 'words' };

export interface SearchResultDto {
  readonly track: TrackDto;
  readonly match: SearchMatchDto;
}

export interface ScanCountsDto {
  /** Audio files found. */
  readonly discovered: number;
  /** Unchanged files left alone. */
  readonly skipped: number;
  readonly added: number;
  readonly updated: number;
  /** Tracks removed because their file is gone. */
  readonly removed: number;
  readonly failed: number;
  /** New tracks that look like ones already stored (kept, not merged). */
  readonly possibleDuplicates: number;
}

export type ScanPhaseDto = 'discovering' | 'reading' | 'removing' | 'completed' | 'cancelled';

/** One progress update. Sent as an event while a scan runs. */
export interface ScanProgressDto extends ScanCountsDto {
  readonly scanId: string;
  readonly rootId: string;
  /** 0-based position of the root being scanned within this scan. */
  readonly rootIndex: number;
  readonly rootCount: number;
  readonly phase: ScanPhaseDto;
  /** Files dealt with so far (skipped + added + updated + failed). */
  readonly processed: number;
  /** Total files to deal with; absent until discovery has finished. */
  readonly total?: number;
  /** The file or folder being worked on. A path inside a library folder the user chose. */
  readonly currentPath?: string;
}

export type ScanFailureKindDto = 'unreadable-media' | 'filesystem' | 'persistence';

export interface ScanFailureDto {
  readonly path: string;
  readonly kind: ScanFailureKindDto;
  readonly message: string;
}

export interface ScanRootResultDto {
  readonly rootId: string;
  readonly rootPath: string;
  readonly status: 'completed' | 'cancelled' | 'failed';
  readonly counts: ScanCountsDto;
  /** The first few failures; `failureCount` is the real total. */
  readonly failures: readonly ScanFailureDto[];
  readonly failureCount: number;
  /** Present when removals were skipped because the whole root looked empty (e.g. an unmounted drive). */
  readonly removalWithheld?: 'root-appears-empty';
  /** Present when the root could not be scanned at all. */
  readonly error?: { readonly code: string; readonly message: string };
}

export interface ScanResultDto {
  readonly scanId: string;
  readonly status: 'completed' | 'cancelled' | 'failed';
  readonly startedAtMs: number;
  readonly finishedAtMs: number;
  readonly roots: readonly ScanRootResultDto[];
}

export interface ScanStateDto {
  /** Present while a scan is running. */
  readonly active?: {
    readonly scanId: string;
    readonly startedAtMs: number;
    /** The latest progress; absent until the first update. */
    readonly progress?: ScanProgressDto;
  };
  /** The most recent finished scan since the app started. */
  readonly last?: ScanResultDto;
}

export interface WatcherRootStatusDto {
  readonly rootId: string;
  readonly path: string;
  readonly state: 'watching' | 'unavailable';
}

export interface WatcherStatusDto {
  readonly running: boolean;
  readonly roots: readonly WatcherRootStatusDto[];
  readonly lastReconcile?: {
    readonly atMs: number;
    readonly rootId?: string;
    readonly counts: ScanCountsDto;
    readonly status: 'completed' | 'cancelled';
  };
  readonly lastError?: { readonly atMs: number; readonly rootId?: string; readonly message: string };
}

/* ------------------------------------------------------------------ *
 * Requests and responses (the payloads inside `IpcResult`)
 * ------------------------------------------------------------------ */

export interface ListRootsResponse {
  readonly roots: readonly RootDto[];
}

/** The renderer never supplies a path. The main process shows the operating
 *  system's folder picker and registers whatever the user picks. */
export type AddRootResponse = { readonly outcome: 'added'; readonly root: RootDto } | { readonly outcome: 'cancelled' };

export interface RemoveRootRequest {
  readonly rootId: string;
}
export interface RemoveRootResponse {
  readonly removedTracks: number;
}

export interface StartScanRequest {
  /** Omit to scan every library folder. */
  readonly rootId?: string;
}
export interface StartScanResponse {
  readonly scanId: string;
  readonly rootCount: number;
}
export interface CancelScanResponse {
  /** `false` when no scan was running. */
  readonly cancelled: boolean;
}

export interface ListTracksRequest {
  /** Default 0. */
  readonly offset?: number;
  /** Default: everything from `offset` on. Maximum 100 000. */
  readonly limit?: number;
  /** Default: title, ascending. Applied before `offset`/`limit`. */
  readonly sort?: TrackSortDto;
}
export interface ListTracksResponse {
  /** All tracks in the library, regardless of paging. */
  readonly total: number;
  readonly offset: number;
  readonly tracks: readonly TrackDto[];
}

export interface SearchTracksRequest {
  readonly query: string;
  /** Default 500, maximum 5 000. */
  readonly limit?: number;
}
export interface SearchTracksResponse {
  /** The query as received. An empty query has no results (the caller shows the unfiltered library). */
  readonly query: string;
  /** All matches, regardless of `limit`. */
  readonly total: number;
  readonly results: readonly SearchResultDto[];
}

/* ------------------------------------------------------------------ *
 * Events (main -> renderer)
 * ------------------------------------------------------------------ */

export type LibraryChangeReasonDto = 'scan' | 'watcher' | 'root-added' | 'root-removed';

export interface LibraryChangedEvent {
  /** Something changed that makes a previously fetched track or root list stale. */
  readonly reason: LibraryChangeReasonDto;
}

/**
 * Phase 7: a desktop-shell command (tray menu, media keys). Main only NAMES the command; the
 * renderer runs it through the same playback-store actions the on-screen buttons use, so the
 * queue rules and the real position still go through `playback:next` / `playback:previous`.
 */
export type ShellCommand = 'toggle-play' | 'next' | 'previous';
export const SHELL_COMMANDS = ['toggle-play', 'next', 'previous'] as const satisfies readonly ShellCommand[];

export type ShellCommandEvent =
  | { readonly command: ShellCommand }
  /** v0.11.3: the user opened an audio file with Nova Player (double-click / "Open with"). Main found (or added) it in the library and names its track; the renderer plays it like a click. */
  | { readonly command: 'play-track'; readonly trackId: string };

/** Channel name -> payload. Events are one-way notifications; there is no reply. */
export interface IpcEventContract {
  /** Throttled while a scan runs. */
  'library:scanProgress': ScanProgressDto;
  /** Exactly once per scan, when it ends (completed, cancelled or failed). */
  'library:scanFinished': ScanResultDto;
  'library:changed': LibraryChangedEvent;
  'library:watcherStatus': WatcherStatusDto;
  /** Phase 4: main changed the playback state on its own (library change). */
  'playback:stateChanged': PlaybackStateChangedEvent;
  /** Phase 7: the desktop shell (tray / media keys) asks the player to act. */
  'shell:command': ShellCommandEvent;
}

export type IpcEventChannel = keyof IpcEventContract;
export type IpcEventPayload<E extends IpcEventChannel> = IpcEventContract[E];

/** Every event channel, at runtime (the preload only subscribes to these). */
export const IPC_EVENT_CHANNELS = [
  'library:scanProgress',
  'library:scanFinished',
  'library:changed',
  'library:watcherStatus',
  'playback:stateChanged',
  'shell:command',
] as const satisfies readonly IpcEventChannel[];

// Compile-time guarantee that the list above is complete.
type MissingEventChannel = Exclude<IpcEventChannel, (typeof IPC_EVENT_CHANNELS)[number]>;
export const eventChannelListIsComplete: MissingEventChannel extends never ? true : never = true;
