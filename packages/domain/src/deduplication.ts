import { normalizeForComparison } from './text-normalization.js';

declare const deduplicationKeyBrand: unique symbol;
export type DeduplicationKey = string & { readonly [deduplicationKeyBrand]: true };

export interface DeduplicationInput {
  readonly title: string;
  readonly artist: string;
  readonly sizeBytes: number;
}

/**
 * An advisory "this looks like a duplicate" signal - normalized title +
 * normalized artist + exact file size in bytes - carried forward from the
 * reference app's product requirement that the library should resist
 * obvious duplicate entries (the same song copied into a second folder, or
 * re-downloaded under a different filename).
 *
 * This is deliberately NOT a replacement for TrackId (see track-id.ts) and
 * is never used as one. It exists only so infrastructure can check "does
 * something like this already exist?" before minting a new TrackId for an
 * incoming file - what to actually do on a match (skip it, merge it, ask
 * the user) is an infrastructure/application-layer decision, not this
 * function's concern.
 *
 * Known, accepted limitations - do not "fix" these by making the key
 * fuzzier, which only trades one failure mode for the opposite one:
 *   - A re-encoded or re-downloaded copy of the same song at a different
 *     bitrate has a different file size and will NOT be caught (a false
 *     negative). Catching that would require decoding and comparing actual
 *     audio content, which the accepted architecture review explicitly
 *     rejected ("do not invent a complicated content-hashing system").
 *   - Two different, very short recordings that happen to share a generic
 *     normalized title/artist and land on the exact same byte size could
 *     theoretically collide (a false positive). Considered acceptably rare
 *     in a real music library.
 */
export function computeDeduplicationKey(input: DeduplicationInput): DeduplicationKey {
  const normalizedTitle = normalizeForComparison(input.title);
  const normalizedArtist = normalizeForComparison(input.artist);
  return `${normalizedTitle}|${normalizedArtist}|${input.sizeBytes}` as DeduplicationKey;
}
