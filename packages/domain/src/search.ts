import type { Track } from './track.js';
import { normalizeForComparison } from './text-normalization.js';

/**
 * The metadata fields search looks at, and nothing else.
 *
 * `albumArtist` is included alongside the four required fields for one
 * concrete reason: on compilations and featured-artist releases the
 * per-track `artist` can differ from the name a user actually knows the
 * release by (e.g. "Various Artists", or a lead artist with guests), and
 * searching for that name should still find the tracks.
 */
export type SearchField = 'title' | 'artist' | 'albumArtist' | 'album' | 'genre';

/**
 * How directly a query matched a single field's comparison value.
 *   exact     - the whole field equals the query
 *   prefix    - the field starts with the query
 *   substring - the field contains the query somewhere
 */
export type FieldMatchQuality = 'exact' | 'prefix' | 'substring';

/**
 * Why a track matched. Deliberately descriptive rather than numeric: a
 * future UI can use it (e.g. to highlight the matching field), while the
 * numeric rank used for ordering stays internal.
 *
 *   field - the whole normalized query matched inside one field
 *   words - a multi-word query where no single field contained the full
 *           phrase, but every word was found somewhere in the track's
 *           searchable fields (e.g. "weeknd after hours" = artist + album)
 */
export type SearchMatch =
  | { readonly kind: 'field'; readonly field: SearchField; readonly quality: FieldMatchQuality }
  | { readonly kind: 'words' };

export interface SearchResult {
  /** The original, unmodified Track - never a normalized copy. */
  readonly track: Track;
  readonly match: SearchMatch;
}

/**
 * Field priority - a deterministic product search policy, not a claim about
 * what is objectively "best". A match in an earlier field always outranks a
 * match in a later one, regardless of match quality: a title that merely
 * CONTAINS the query outranks an artist that EXACTLY equals it. Quality only
 * orders matches within the same field.
 */
const FIELD_PRIORITY: readonly SearchField[] = ['title', 'artist', 'albumArtist', 'album', 'genre'];

const QUALITY_RANK: Record<FieldMatchQuality, number> = { exact: 0, prefix: 1, substring: 2 };
const QUALITIES_PER_FIELD = 3;

/** Multi-word "every word found somewhere" matches rank below every
 *  single-field phrase match. */
const WORDS_RANK = FIELD_PRIORITY.length * QUALITIES_PER_FIELD;

function fieldValue(track: Track, field: SearchField): string {
  switch (field) {
    case 'title':
      return comparisonValue(track.title);
    case 'artist':
      return comparisonValue(track.artist);
    case 'albumArtist':
      return comparisonValue(track.albumArtist);
    case 'album':
      return comparisonValue(track.album);
    case 'genre':
      return comparisonValue(track.genre);
  }
}

/**
 * The comparison form of a display value, tolerant of absent or malformed
 * metadata: anything that isn't a string becomes an empty string, which
 * never matches a non-empty query. Search must never throw because a track
 * has a missing or odd field.
 */
function comparisonValue(value: string | undefined): string {
  return typeof value === 'string' ? normalizeForComparison(value) : '';
}

function matchQuality(value: string, query: string): FieldMatchQuality | undefined {
  if (value.length === 0) return undefined;
  if (value === query) return 'exact';
  if (value.startsWith(query)) return 'prefix';
  if (value.includes(query)) return 'substring';
  return undefined;
}

interface RankedMatch {
  readonly match: SearchMatch;
  readonly rank: number;
}

function findMatch(track: Track, query: string, words: readonly string[]): RankedMatch | undefined {
  const values = FIELD_PRIORITY.map((field) => fieldValue(track, field));

  // 1. The whole normalized phrase, checked field by field in priority
  //    order. The first field that matches wins.
  for (const [index, field] of FIELD_PRIORITY.entries()) {
    const quality = matchQuality(values[index] ?? '', query);
    if (quality !== undefined) {
      return {
        match: { kind: 'field', field, quality },
        rank: index * QUALITIES_PER_FIELD + QUALITY_RANK[quality],
      };
    }
  }

  // 2. Multi-word fallback: only reached when no single field contained the
  //    whole phrase. Every word must be found (as a substring) in at least
  //    one searchable field - different words may match different fields,
  //    and word order does not matter.
  if (words.length > 1 && words.every((word) => values.some((value) => value.includes(word)))) {
    return { match: { kind: 'words' }, rank: WORDS_RANK };
  }

  return undefined;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

interface RankedResult {
  readonly result: SearchResult;
  readonly rank: number;
  readonly titleKey: string;
  readonly artistKey: string;
  readonly id: string;
}

/**
 * Searches tracks by a user-typed query. Pure and deterministic: the same
 * tracks and query always produce the same results in the same order, and
 * neither the input array nor any Track is modified.
 *
 * Query handling:
 *   - The query is normalized with the same `normalizeForComparison` used
 *     everywhere else (trimmed, whitespace collapsed, lowercased), so
 *     surrounding/repeated whitespace and letter case never matter.
 *   - Punctuation is significant and matched literally ("ac/dc" finds
 *     "AC/DC"; "dont" does not find "Don't"). Accent folding and other
 *     transliteration are deliberately not attempted in this phase.
 *   - An empty or whitespace-only query returns NO results. Search never
 *     returns an arbitrary slice of the library for "no query"; deciding
 *     what to show when the search box is empty (usually the unfiltered
 *     library) is the caller's job, since the caller already knows the
 *     query was empty.
 *
 * Ordering: relevance rank, then title, then artist (both compared in
 * normalized form by plain code-unit order, so results never depend on the
 * runtime's locale), then track ID. Tracks that are still tied after all
 * four keep their input order (Array.prototype.sort is stable).
 *
 * This is a straightforward linear scan - no index. Indexing belongs to
 * the infrastructure/library phases.
 */
export function searchTracks(tracks: readonly Track[], query: string): SearchResult[] {
  const normalizedQuery = normalizeForComparison(query);
  if (normalizedQuery.length === 0) return [];

  const words = normalizedQuery.split(' ');

  const ranked: RankedResult[] = [];
  for (const track of tracks) {
    const found = findMatch(track, normalizedQuery, words);
    if (found === undefined) continue;
    ranked.push({
      result: { track, match: found.match },
      rank: found.rank,
      titleKey: comparisonValue(track.title),
      artistKey: comparisonValue(track.artist),
      id: String(track.id),
    });
  }

  ranked.sort(
    (a, b) =>
      a.rank - b.rank ||
      compareStrings(a.titleKey, b.titleKey) ||
      compareStrings(a.artistKey, b.artistKey) ||
      compareStrings(a.id, b.id),
  );

  return ranked.map((entry) => entry.result);
}
