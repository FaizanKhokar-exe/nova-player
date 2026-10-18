import { normalizeForComparison, normalizeWhitespace } from './text-normalization.js';
import { sortTracks, sortTracksInAlbumOrder, type SortableTrack } from './track-sorting.js';

/**
 * Album / artist / genre grouping (Phase 5) - pure and deterministic.
 *
 * It reuses Phase 1A's canonical comparison (`normalizeForComparison`), so two
 * spellings that differ only in case or whitespace are the SAME group. It
 * invents no second normalization policy.
 *
 * Grouping semantics (every one pinned by tests):
 *
 *  ARTIST  A track belongs to the artist group of its ALBUM ARTIST when it has
 *          one, otherwise of its track ARTIST. That is what keeps a compilation
 *          ("Various Artists") or a featured-artist track with the album it
 *          belongs to. Artist strings are never split ("A feat. B" is one
 *          name): the metadata carries one string and guessing separators
 *          would split real names ("Earth, Wind & Fire").
 *  ALBUM   An album is identified by its artist group AND its title, so
 *          "Greatest Hits" by two artists are two albums. A track with no album
 *          joins that artist's "Unknown Album".
 *  GENRE   The genre text may list several genres (the metadata reader joins
 *          multi-valued tags with ", "); it is split on commas and semicolons
 *          and the track appears in EACH genre. Slashes and ampersands are not
 *          separators ("R&B/Soul" is one genre). No genre means "Unknown Genre".
 *  MISSING Blank-after-normalization counts as missing. The Phase 1 "Unknown
 *          Artist" fallback and a really missing artist form ONE unknown
 *          group. Unknown groups are always listed last.
 *  NAMES   The display name of a group is its most frequent whitespace-
 *          normalized spelling (ties: smallest by code-unit order), so it does
 *          not depend on input order.
 */

export type GroupKind = 'album' | 'artist' | 'genre';
export const GROUP_KINDS: readonly GroupKind[] = ['album', 'artist', 'genre'];

export function isGroupKind(value: unknown): value is GroupKind {
  return value === 'album' || value === 'artist' || value === 'genre';
}

export const UNKNOWN_ARTIST_NAME = 'Unknown Artist';
export const UNKNOWN_ALBUM_NAME = 'Unknown Album';
export const UNKNOWN_GENRE_NAME = 'Unknown Genre';

/** The key of the unknown group (artist / genre) or the unknown part of an album key. */
const UNKNOWN_PART = 'unknown';

export interface GroupableTrack extends SortableTrack {
  readonly id: string;
  /** Only used to pick a group's cover track; a track without it counts as having no artwork. */
  readonly artwork?: { readonly kind: string };
}

export interface LibraryGroup {
  readonly kind: GroupKind;
  /** Opaque and stable for the same data; safe to pass back to `selectGroup`. */
  readonly key: string;
  readonly name: string;
  /** True for the "Unknown ..." group. */
  readonly unknown: boolean;
  readonly trackCount: number;
  /** Sum of the known durations, in seconds; absent when no track has one. */
  readonly durationSeconds: number | undefined;
  /** Albums: the artist group's display name. */
  readonly artist: string | undefined;
  /** Albums: the earliest known year. */
  readonly year: number | undefined;
  /** Artists: how many albums (including "Unknown Album") they have. */
  readonly albumCount: number | undefined;
  /**
   * A track to take the group's cover from: the first track in natural order that has artwork, else the first track
   * (it may still have a cover file in its folder). Always a member of the group.
   */
  readonly coverTrackId: string | undefined;
}

export interface SelectedGroup<T> {
  readonly group: LibraryGroup;
  /** The group's tracks in their natural order (see `selectGroup`). */
  readonly tracks: T[];
}

/* ------------------------------ keys ------------------------------ */

function keyPart(value: string | undefined, unknownName: string): string {
  if (value === undefined) return UNKNOWN_PART;
  const normalized = normalizeForComparison(value);
  if (normalized === '' || normalized === normalizeForComparison(unknownName)) return UNKNOWN_PART;
  return `n:${normalized}`;
}

function artistGroupText(track: GroupableTrack): string | undefined {
  const albumArtist = track.albumArtist;
  if (albumArtist !== undefined && normalizeForComparison(albumArtist) !== '') return albumArtist;
  return track.artist;
}

function artistKeyOf(track: GroupableTrack): string {
  return keyPart(artistGroupText(track), UNKNOWN_ARTIST_NAME);
}

function albumKeyOf(track: GroupableTrack): string {
  return JSON.stringify([artistKeyOf(track), keyPart(track.album, UNKNOWN_ALBUM_NAME)]);
}

/** The genres a track is listed under, deduplicated, in the order written. */
export function genreNamesOf(track: GroupableTrack): string[] {
  const text = track.genre;
  if (text === undefined) return [];
  const seen = new Set<string>();
  const names: string[] = [];
  for (const piece of text.split(/[,;]/)) {
    const display = normalizeWhitespace(piece);
    const key = normalizeForComparison(display);
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    names.push(display);
  }
  return names;
}

function genreKeysOf(track: GroupableTrack): { key: string; display: string | undefined }[] {
  const names = genreNamesOf(track);
  if (names.length === 0) return [{ key: UNKNOWN_PART, display: undefined }];
  return names.map((display) => ({ key: keyPart(display, UNKNOWN_GENRE_NAME), display }));
}

/* ----------------------------- building ----------------------------- */

interface Bucket<T> {
  readonly key: string;
  readonly members: T[];
  readonly spellings: Map<string, number>;
  /** Albums: spellings of the artist. */
  readonly artistSpellings: Map<string, number>;
  readonly albumKeys: Set<string>;
}

function tally(map: Map<string, number>, spelling: string | undefined): void {
  if (spelling === undefined) return;
  const display = normalizeWhitespace(spelling);
  if (display === '') return;
  map.set(display, (map.get(display) ?? 0) + 1);
}

function mostCommon(map: Map<string, number>): string | undefined {
  let best: string | undefined;
  let bestCount = 0;
  for (const [spelling, count] of map) {
    if (count > bestCount || (count === bestCount && best !== undefined && spelling < best)) {
      best = spelling;
      bestCount = count;
    }
  }
  return best;
}

function bucketFor<T>(buckets: Map<string, Bucket<T>>, key: string): Bucket<T> {
  let bucket = buckets.get(key);
  if (bucket === undefined) {
    bucket = { key, members: [], spellings: new Map(), artistSpellings: new Map(), albumKeys: new Set() };
    buckets.set(key, bucket);
  }
  return bucket;
}

function buildBuckets<T extends GroupableTrack>(tracks: readonly T[], kind: GroupKind): Map<string, Bucket<T>> {
  const buckets = new Map<string, Bucket<T>>();
  for (const track of tracks) {
    switch (kind) {
      case 'artist': {
        const bucket = bucketFor(buckets, artistKeyOf(track));
        bucket.members.push(track);
        tally(bucket.spellings, artistGroupText(track));
        bucket.albumKeys.add(albumKeyOf(track));
        break;
      }
      case 'album': {
        const bucket = bucketFor(buckets, albumKeyOf(track));
        bucket.members.push(track);
        tally(bucket.spellings, track.album);
        tally(bucket.artistSpellings, artistGroupText(track));
        break;
      }
      case 'genre':
        for (const genre of genreKeysOf(track)) {
          const bucket = bucketFor(buckets, genre.key);
          bucket.members.push(track);
          tally(bucket.spellings, genre.display);
        }
        break;
    }
  }
  return buckets;
}

function isUnknownKey(kind: GroupKind, key: string): boolean {
  if (kind !== 'album') return key === UNKNOWN_PART;
  try {
    const parsed: unknown = JSON.parse(key);
    return Array.isArray(parsed) && parsed[1] === UNKNOWN_PART;
  } catch {
    return false;
  }
}

function coverTrackOf<T extends GroupableTrack>(kind: GroupKind, members: readonly T[]): string | undefined {
  const withArtwork = members.filter((track) => track.artwork !== undefined && track.artwork.kind !== 'none');
  return orderMembers(kind, withArtwork.length > 0 ? withArtwork : members)[0]?.id;
}

function describe<T extends GroupableTrack>(kind: GroupKind, bucket: Bucket<T>): LibraryGroup {
  const unknown = isUnknownKey(kind, bucket.key);
  const unknownName = kind === 'album' ? UNKNOWN_ALBUM_NAME : kind === 'artist' ? UNKNOWN_ARTIST_NAME : UNKNOWN_GENRE_NAME;
  const name = unknown ? unknownName : (mostCommon(bucket.spellings) ?? unknownName);

  let durationSeconds: number | undefined;
  let year: number | undefined;
  for (const track of bucket.members) {
    if (track.durationSeconds !== undefined && Number.isFinite(track.durationSeconds)) {
      durationSeconds = (durationSeconds ?? 0) + track.durationSeconds;
    }
    if (track.year !== undefined && Number.isFinite(track.year)) year = year === undefined ? track.year : Math.min(year, track.year);
  }

  let artist: string | undefined;
  if (kind === 'album') {
    const artistKey = bucket.key.length > 0 ? firstPartOfAlbumKey(bucket.key) : UNKNOWN_PART;
    artist = artistKey === UNKNOWN_PART ? UNKNOWN_ARTIST_NAME : (mostCommon(bucket.artistSpellings) ?? UNKNOWN_ARTIST_NAME);
  }

  return {
    kind,
    key: bucket.key,
    name,
    unknown,
    trackCount: bucket.members.length,
    durationSeconds,
    artist,
    year: kind === 'album' ? year : undefined,
    albumCount: kind === 'artist' ? bucket.albumKeys.size : undefined,
    coverTrackId: coverTrackOf(kind, bucket.members),
  };
}

function firstPartOfAlbumKey(key: string): string {
  try {
    const parsed: unknown = JSON.parse(key);
    return Array.isArray(parsed) && typeof parsed[0] === 'string' ? parsed[0] : UNKNOWN_PART;
  } catch {
    return UNKNOWN_PART;
  }
}

/** Groups are listed by name (case-insensitive, code-unit order), unknown last, ties by key. */
function compareGroups(a: LibraryGroup, b: LibraryGroup): number {
  if (a.unknown !== b.unknown) return a.unknown ? 1 : -1;
  const byName = normalizeForComparison(a.name);
  const otherName = normalizeForComparison(b.name);
  if (byName !== otherName) return byName < otherName ? -1 : 1;
  if (a.kind === 'album' && a.artist !== undefined && b.artist !== undefined) {
    const byArtist = normalizeForComparison(a.artist);
    const otherArtist = normalizeForComparison(b.artist);
    if (byArtist !== otherArtist) return byArtist < otherArtist ? -1 : 1;
  }
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/** Every group of `kind`, with counts, in a deterministic order. */
export function groupTracks<T extends GroupableTrack>(tracks: readonly T[], kind: GroupKind): LibraryGroup[] {
  const groups: LibraryGroup[] = [];
  for (const bucket of buildBuckets(tracks, kind).values()) groups.push(describe(kind, bucket));
  return groups.sort(compareGroups);
}

/** The natural order of the tracks inside a group. */
function orderMembers<T extends GroupableTrack>(kind: GroupKind, members: readonly T[]): T[] {
  switch (kind) {
    case 'album':
      return sortTracksInAlbumOrder(members);
    case 'artist':
      // Album by album (unknown album last), each in album order.
      return sortTracks(members, { field: 'album', direction: 'asc' });
    case 'genre':
      return sortTracks(members, { field: 'artist', direction: 'asc' });
  }
}

/** One group and its tracks in natural order, or `undefined` when no such group exists (now). */
export function selectGroup<T extends GroupableTrack>(tracks: readonly T[], kind: GroupKind, key: string): SelectedGroup<T> | undefined {
  const bucket = buildBuckets(tracks, kind).get(key);
  if (bucket === undefined) return undefined;
  return { group: describe(kind, bucket), tracks: orderMembers(kind, bucket.members) };
}
