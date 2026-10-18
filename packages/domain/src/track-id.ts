/**
 * The stable identity of a track once it enters the library.
 *
 * This is intentionally just a branded UUID string - see Phase 0's product
 * decision 2 (crypto.randomUUID(), never the `uuid` package) - and it is
 * intentionally NOT derived from anything about the file itself (not a
 * filename hash, not a path hash). A file can be renamed or moved without
 * losing its TrackId; only re-linking logic (a later phase's concern, once
 * a real repository exists) decides when a moved file is "the same track."
 *
 * This is one of three distinct identity concepts in this domain - do not
 * collapse them:
 *   1. TrackId (this type)      - the permanent domain/database identity.
 *   2. sourcePath (on `Track`)  - where the file currently lives on disk;
 *                                 can change without changing the TrackId.
 *   3. DeduplicationKey         - see deduplication.ts; an advisory "this
 *                                 looks like a duplicate" signal, used only
 *                                 to catch a duplicate BEFORE assigning a
 *                                 new TrackId, never a substitute for one.
 */
declare const trackIdBrand: unique symbol;
export type TrackId = string & { readonly [trackIdBrand]: true };

// crypto.randomUUID() always produces a version-4 UUID in this exact,
// case-insensitive form. Validating against that shape (rather than any
// string) is what makes `isValidTrackId` a meaningful invariant rather than
// a no-op.
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The only sanctioned way to mint a brand-new TrackId. */
export function createTrackId(): TrackId {
  return crypto.randomUUID() as TrackId;
}

export function isValidTrackId(value: string): value is TrackId {
  return UUID_V4_PATTERN.test(value);
}

/**
 * Validates and brands an existing string (e.g. one read back from a
 * database in a later phase) as a TrackId. Returns `undefined` rather than
 * throwing on an invalid value - a corrupt or foreign ID in imported data is
 * an infrastructure-level concern to handle, not a reason for the domain
 * layer to throw.
 */
export function parseTrackId(value: string): TrackId | undefined {
  return isValidTrackId(value) ? (value as TrackId) : undefined;
}
