import { normalizeForComparison } from './text-normalization.js';

/**
 * Library sorting (Phase 5). One pure, deterministic implementation used by
 * every list the application serves (All Tracks, album/artist/genre detail
 * lists, the order a queue is built in), so a list on screen and the queue
 * made from it can never disagree.
 *
 * Rules (all pinned by tests):
 *  - Text is compared after `normalizeForComparison` (case-insensitive,
 *    whitespace-collapsed) by plain UTF-16 code-unit order - never locale
 *    dependent, so the result is identical on every machine.
 *  - A MISSING value (no album, no genre, no year, no duration, or text that
 *    is blank after normalization) sorts LAST in BOTH directions. "Descending"
 *    reverses the order of the values that exist; it never floats the
 *    unknowns to the top.
 *  - `direction` flips only the primary comparison. The tie-break chain that
 *    follows is always ascending, so two equal-key tracks never swap places
 *    when the user flips the direction.
 *  - The chain always ends with the TrackId, so the order is total: the same
 *    input always yields the same output, whatever order it arrived in.
 */

export const TRACK_SORT_FIELDS = ['title', 'artist', 'album', 'albumArtist', 'genre', 'year', 'duration'] as const;
export type TrackSortField = (typeof TRACK_SORT_FIELDS)[number];
export type SortDirection = 'asc' | 'desc';

export interface TrackSort {
  readonly field: TrackSortField;
  readonly direction: SortDirection;
}

/** The library's default order: title, ascending (the same order the Phase 3 list always had). */
export const DEFAULT_TRACK_SORT: TrackSort = { field: 'title', direction: 'asc' };

/** The fields sorting reads. Both the domain `Track` and the IPC `TrackDto` fit. */
export interface SortableTrack {
  readonly id: string;
  readonly title: string;
  readonly artist: string;
  readonly album?: string | undefined;
  readonly albumArtist?: string | undefined;
  readonly genre?: string | undefined;
  readonly trackNumber?: number | undefined;
  readonly discNumber?: number | undefined;
  readonly year?: number | undefined;
  readonly durationSeconds?: number | undefined;
}

export function isTrackSortField(value: unknown): value is TrackSortField {
  return typeof value === 'string' && (TRACK_SORT_FIELDS as readonly string[]).includes(value);
}

export function isSortDirection(value: unknown): value is SortDirection {
  return value === 'asc' || value === 'desc';
}

type Key = string | number | undefined;

function textKey(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = normalizeForComparison(value);
  return normalized === '' ? undefined : normalized;
}

function numberKey(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) ? value : undefined;
}

/** Ascending comparison where a missing key is greater than any present key. */
function compareKeys(a: Key, b: Key): number {
  if (a === undefined) return b === undefined ? 0 : 1;
  if (b === undefined) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

interface Keyed<T> {
  readonly track: T;
  readonly keys: Record<'title' | 'artist' | 'album' | 'albumArtist' | 'genre' | 'year' | 'duration' | 'disc' | 'number' | 'id', Key>;
}

function keyed<T extends SortableTrack>(track: T): Keyed<T> {
  return {
    track,
    keys: {
      title: textKey(track.title),
      artist: textKey(track.artist),
      album: textKey(track.album),
      albumArtist: textKey(track.albumArtist),
      genre: textKey(track.genre),
      year: numberKey(track.year),
      duration: numberKey(track.durationSeconds),
      // A numbered track with no disc tag is on disc 1; a track with neither number stays last.
      disc: numberKey(track.discNumber) ?? (numberKey(track.trackNumber) !== undefined ? 1 : undefined),
      number: numberKey(track.trackNumber),
      id: track.id,
    },
  };
}

type KeyName = keyof Keyed<SortableTrack>['keys'];

const TITLE_CHAIN: readonly KeyName[] = ['artist', 'id'];
const ALBUM_ORDER_CHAIN: readonly KeyName[] = ['artist', 'album', 'disc', 'number', 'title', 'id'];

function chainFor(field: TrackSortField): readonly KeyName[] {
  switch (field) {
    case 'title':
    case 'duration':
      return field === 'title' ? TITLE_CHAIN : ['title', 'artist', 'id'];
    default:
      return ALBUM_ORDER_CHAIN;
  }
}

function comparatorFor<T>(sort: TrackSort): (a: Keyed<T>, b: Keyed<T>) => number {
  const chain = chainFor(sort.field);
  return (a, b) => {
    const primaryA = a.keys[sort.field];
    const primaryB = b.keys[sort.field];
    if (primaryA !== primaryB) {
      // Missing values stay last whatever the direction.
      if (primaryA === undefined) return 1;
      if (primaryB === undefined) return -1;
      const result = compareKeys(primaryA, primaryB);
      if (result !== 0) return sort.direction === 'asc' ? result : -result;
    }
    for (const name of chain) {
      const result = compareKeys(a.keys[name], b.keys[name]);
      if (result !== 0) return result;
    }
    return 0;
  };
}

/** A new array in `sort` order; the input is not modified. */
export function sortTracks<T extends SortableTrack>(tracks: readonly T[], sort: TrackSort = DEFAULT_TRACK_SORT): T[] {
  const compare = comparatorFor<T>(sort);
  return tracks
    .map(keyed)
    .sort(compare)
    .map((entry) => entry.track);
}

/**
 * The natural order of an album: disc, track number, then title. Tracks with
 * no disc/track number come after numbered ones. Used for album detail lists
 * and for the queue an album is played from.
 */
export function sortTracksInAlbumOrder<T extends SortableTrack>(tracks: readonly T[]): T[] {
  return tracks
    .map(keyed)
    .sort((a, b) => {
      for (const name of ['disc', 'number', 'title', 'artist', 'id'] as const) {
        const result = compareKeys(a.keys[name], b.keys[name]);
        if (result !== 0) return result;
      }
      return 0;
    })
    .map((entry) => entry.track);
}
