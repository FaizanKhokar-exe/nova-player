import type { TrackId } from './track-id.js';
import { normalizeWhitespace } from './text-normalization.js';
import { extractFileNameWithoutExtension, parseArtistTitleFromFileName } from './filename-fallback.js';

/**
 * What a track's artwork situation is, in domain terms. This is a
 * REFERENCE, never the image bytes themselves - actual extraction/caching
 * of artwork is infrastructure's job in a later phase.
 */
export type ArtworkReference =
  | { readonly kind: 'embedded' }
  | { readonly kind: 'external'; readonly path: string }
  | { readonly kind: 'none' };

/**
 * External/raw metadata, as some future infrastructure adapter (built in a
 * later phase, likely wrapping `music-metadata`) will have read it from a
 * file's tags. Every field is optional because real-world tags are
 * inconsistent - that inconsistency is exactly what `createTrack` below
 * exists to resolve into something usable.
 *
 * Deliberately shaped around domain concepts (title/artist/album/...), NOT
 * around `music-metadata`'s actual output shape - so a future adapter
 * translates into this, and swapping the tag-reading library later never
 * touches this type or anything that depends on it.
 */
export interface RawTrackMetadata {
  readonly title?: string;
  readonly artist?: string;
  readonly album?: string;
  readonly albumArtist?: string;
  readonly genre?: string;
  readonly trackNumber?: number;
  readonly discNumber?: number;
  readonly year?: number;
  readonly durationSeconds?: number;
  readonly hasEmbeddedArtwork?: boolean;
  readonly externalArtworkPath?: string;
}

/**
 * Where a track's display title/artist actually came from. Mirrors the
 * `tag_source` column in the accepted architecture review's data model
 * (§7.2) - directly useful later for the "self-healing metadata" policy
 * that document describes (a record whose stored value still looks
 * filename-derived can be transparently re-read on next library load).
 */
export type MetadataFieldSource = 'tag' | 'filename' | 'unknown';

export interface Track {
  readonly id: TrackId;
  /** Where the file currently lives. See track-id.ts for why this is kept
   *  separate from TrackId rather than used to derive it. */
  readonly sourcePath: string;
  readonly title: string;
  readonly titleSource: MetadataFieldSource;
  readonly artist: string;
  readonly artistSource: MetadataFieldSource;
  readonly album: string | undefined;
  readonly albumArtist: string | undefined;
  readonly genre: string | undefined;
  readonly trackNumber: number | undefined;
  readonly discNumber: number | undefined;
  readonly year: number | undefined;
  readonly durationSeconds: number | undefined;
  readonly artwork: ArtworkReference;
}

export interface CreateTrackInput {
  readonly id: TrackId;
  readonly sourcePath: string;
  readonly raw: RawTrackMetadata;
}

/**
 * Deterministic fallback used only in the pathological case where a track
 * has neither a usable tag title nor any usable filename content at all
 * (e.g. an empty string path segment). Not a display string that's expected
 * to appear in practice - a defensive floor so `createTrack` is a total
 * function that never throws on bad input.
 */
const UNTITLED_TRACK_FALLBACK = 'Untitled Track';

/**
 * Deterministic fallback for a track with no usable artist information from
 * either its tags or its filename. Deliberately a fixed, non-random,
 * documented value rather than an empty string - an empty artist would
 * break sorting/grouping in every later phase that assumes artist is always
 * a non-empty, displayable string.
 */
const UNKNOWN_ARTIST = 'Unknown Artist';

/**
 * Normalizes an optional display field (album / album artist / genre):
 * whitespace-cleaned, and treated as absent if that leaves nothing. Unlike
 * title/artist, these are left `undefined` rather than given a synthesized
 * "Unknown ..." value - deliberately deferring that decision. A missing
 * genre or album is common and legitimate in real libraries, and how to
 * bucket untagged albums for display/grouping is explicitly later work
 * (§8 of the Phase 1A brief), not something this phase should presuppose.
 */
function normalizeOptionalField(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const cleaned = normalizeWhitespace(value);
  return cleaned.length > 0 ? cleaned : undefined;
}

function sanitizePositiveInteger(value: number | undefined): number | undefined {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** A plausible 4-digit calendar year. Anything else is treated as absent
 *  rather than displayed as-is - a tag with `year: -1` or `year: 30000` is
 *  more likely corrupt data than a real release date. */
function sanitizeYear(value: number | undefined): number | undefined {
  return value !== undefined && Number.isInteger(value) && value >= 1000 && value <= 9999
    ? value
    : undefined;
}

/** Duration cannot be negative, and a non-finite value (NaN/Infinity from a
 *  malformed tag) is not a duration at all. */
function sanitizeDurationSeconds(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function resolveArtworkReference(raw: RawTrackMetadata): ArtworkReference {
  if (raw.hasEmbeddedArtwork === true) return { kind: 'embedded' };
  if (raw.externalArtworkPath !== undefined && raw.externalArtworkPath.length > 0) {
    return { kind: 'external', path: raw.externalArtworkPath };
  }
  return { kind: 'none' };
}

/**
 * The core metadata-resolution policy: turns whatever a tag reader found
 * (possibly nothing at all) into a fully-resolved `Track`. This is the
 * function a future infrastructure adapter calls after reading a file's
 * tags - the policy itself lives here, in the domain layer, not in
 * whichever library ends up doing the actual tag reading.
 *
 * Title/artist resolution both follow the same three-step fallback chain:
 * a real tag value, then a filename-derived value, then a fixed documented
 * constant - so every Track always has a non-empty, displayable title and
 * artist, and callers never need to null-check them.
 */
export function createTrack(input: CreateTrackInput): Track {
  const { id, sourcePath, raw } = input;

  const cleanRawTitle = raw.title !== undefined ? normalizeWhitespace(raw.title) : '';
  const cleanRawArtist = raw.artist !== undefined ? normalizeWhitespace(raw.artist) : '';

  const fileNameFallback = parseArtistTitleFromFileName(extractFileNameWithoutExtension(sourcePath));

  let title: string;
  let titleSource: MetadataFieldSource;
  if (cleanRawTitle.length > 0) {
    title = cleanRawTitle;
    titleSource = 'tag';
  } else if (fileNameFallback.title.length > 0) {
    title = fileNameFallback.title;
    titleSource = 'filename';
  } else {
    title = UNTITLED_TRACK_FALLBACK;
    titleSource = 'unknown';
  }

  let artist: string;
  let artistSource: MetadataFieldSource;
  if (cleanRawArtist.length > 0) {
    artist = cleanRawArtist;
    artistSource = 'tag';
  } else if (fileNameFallback.artist !== undefined && fileNameFallback.artist.length > 0) {
    artist = fileNameFallback.artist;
    artistSource = 'filename';
  } else {
    artist = UNKNOWN_ARTIST;
    artistSource = 'unknown';
  }

  return {
    id,
    sourcePath,
    title,
    titleSource,
    artist,
    artistSource,
    album: normalizeOptionalField(raw.album),
    albumArtist: normalizeOptionalField(raw.albumArtist),
    genre: normalizeOptionalField(raw.genre),
    trackNumber: sanitizePositiveInteger(raw.trackNumber),
    discNumber: sanitizePositiveInteger(raw.discNumber),
    year: sanitizeYear(raw.year),
    durationSeconds: sanitizeDurationSeconds(raw.durationSeconds),
    artwork: resolveArtworkReference(raw),
  };
}
