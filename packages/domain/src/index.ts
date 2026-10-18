import type { TrackSummary } from '@nova/shared';

/**
 * Phase 0 smoke-test logic only.
 *
 * This is deliberately trivial - a pure, dependency-free function - so that
 * it can prove three things about the workspace before any real domain
 * logic (queue/shuffle/repeat, search scoring, LRC parsing, ...) is written
 * in Phase 1:
 *   1. `@nova/domain` can import a type from `@nova/shared` via the
 *      `workspace:*` protocol and have it type-check.
 *   2. The domain package has zero I/O and zero framework dependency
 *      (no Electron, no DOM, no React) - the architectural rule from the
 *      accepted review.
 *   3. Vitest can resolve and run tests across the workspace.
 */
export function sortTrackSummariesByTitle(tracks: readonly TrackSummary[]): TrackSummary[] {
  return [...tracks].sort((a, b) => a.title.localeCompare(b.title));
}

// --- Phase 1A: domain models + metadata policy ---
// Added alongside the Phase 0 smoke-test export above, which is left
// untouched per the instruction not to redo or replace working Phase 0
// code.
export { createTrackId, isValidTrackId, parseTrackId, type TrackId } from './track-id.js';
export { normalizeWhitespace, normalizeForComparison } from './text-normalization.js';
export {
  extractFileNameWithoutExtension,
  stripJunkBracketGroups,
  parseArtistTitleFromFileName,
  type FileNameFallbackResult,
} from './filename-fallback.js';
export {
  createTrack,
  type Track,
  type RawTrackMetadata,
  type CreateTrackInput,
  type ArtworkReference,
  type MetadataFieldSource,
} from './track.js';
export {
  computeDeduplicationKey,
  type DeduplicationKey,
  type DeduplicationInput,
} from './deduplication.js';

// --- Phase 1B: queue + playback rules ---
// Added alongside Phase 0/1A exports above, which are left untouched.
export {
  EMPTY_QUEUE,
  getCurrentTrackId,
  replaceQueue,
  appendToQueue,
  playNext,
  removeFromQueue,
  reorderQueue,
  jumpToIndex,
  setRepeatMode,
  clearQueue,
  type QueueState,
  type RepeatMode,
} from './queue.js';
export {
  fisherYatesShuffle,
  isShuffleEnabled,
  enableShuffle,
  disableShuffle,
  type RandomSource,
} from './shuffle.js';
export {
  decideOnTrackFinished,
  decideOnNextPressed,
  decideOnPreviousPressed,
  PREVIOUS_RESTART_THRESHOLD_MS,
  type PlaybackDecision,
} from './playback-decisions.js';

// --- Phase 1C: search ---
export {
  searchTracks,
  type SearchResult,
  type SearchMatch,
  type SearchField,
  type FieldMatchQuality,
} from './search.js';

// --- Phase 1D: lyrics ---
export { parseLyrics, type LyricLine, type LyricsMetadata, type ParsedLyrics } from './lrc.js';
export { getActiveLyric, getActiveLyricIndex, getLyricSeekTime } from './active-lyric.js';

// --- Phase 2B: persistence port ---
export {
  TrackRepositoryError,
  type TrackRepository,
  type TrackRecord,
  type TrackFileState,
  type TrackRepositoryErrorCode,
} from './track-repository.js';

// --- Phase 3 (half 1): library root persistence port ---
export {
  LibraryRootRepositoryError,
  type LibraryRoot,
  type LibraryRootRepository,
  type LibraryRootRepositoryErrorCode,
} from './library-root-repository.js';

// --- Phase 4: playback session persistence port ---
export type { PersistedPlaybackSession, PlaybackSessionRepository } from './playback-session-repository.js';

// --- Phase 5: library grouping + sorting ---
export {
  TRACK_SORT_FIELDS,
  DEFAULT_TRACK_SORT,
  isTrackSortField,
  isSortDirection,
  sortTracks,
  sortTracksInAlbumOrder,
  type TrackSort,
  type TrackSortField,
  type SortDirection,
  type SortableTrack,
} from './track-sorting.js';
export {
  GROUP_KINDS,
  UNKNOWN_ARTIST_NAME,
  UNKNOWN_ALBUM_NAME,
  UNKNOWN_GENRE_NAME,
  isGroupKind,
  genreNamesOf,
  groupTracks,
  selectGroup,
  type GroupKind,
  type GroupableTrack,
  type LibraryGroup,
  type SelectedGroup,
} from './library-grouping.js';
