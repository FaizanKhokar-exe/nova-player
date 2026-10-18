/**
 * Collapses leading/trailing and repeated internal whitespace down to
 * single spaces. Safe to apply to any display string - it never changes
 * meaningful content, only incidental whitespace (the kind that shows up
 * from sloppy tagging tools or filenames with double spaces/underscores
 * left over from a batch rename).
 */
export function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/**
 * Produces a comparison form of a display string: whitespace-normalized AND
 * lowercased. This is deliberately a SEPARATE function from
 * `normalizeWhitespace`, not a flag on it, so that call sites are forced to
 * be explicit about which one they want.
 *
 * NEVER use this output for display - "Daft Punk" must never be shown to a
 * user as "daft punk". This form exists only as the basis for equality
 * checks, sorting keys, search matching (Phase 1C), and deduplication (see
 * deduplication.ts) - contexts that need two differently-cased or
 * differently-spaced strings to be treated as "the same," never contexts
 * that render text on screen.
 */
export function normalizeForComparison(value: string): string {
  return normalizeWhitespace(value).toLowerCase();
}
