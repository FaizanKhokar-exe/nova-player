import { normalizeWhitespace, normalizeForComparison } from './text-normalization.js';

/**
 * Strips a file extension from the last path segment, without depending on
 * `node:path` (this package must not depend on any single runtime's path
 * semantics - see the architectural boundary this phase enforces). Handles
 * both `/` and `\` separators since a `sourcePath` may originate from
 * either a POSIX or a Windows filesystem.
 *
 * Guards against dotfiles (a leading dot with nothing meaningful before it,
 * or a trailing dot with nothing after it) being mistaken for "no
 * extension" - `.mp3` alone is not treated as an extension-less name called
 * "", and `track.` is not truncated to an empty string.
 */
export function extractFileNameWithoutExtension(sourcePath: string): string {
  const normalizedSeparators = sourcePath.replace(/\\/g, '/');
  const segments = normalizedSeparators.split('/');
  const lastSegment = segments[segments.length - 1] ?? '';

  const lastDotIndex = lastSegment.lastIndexOf('.');
  const hasRealExtension = lastDotIndex > 0 && lastDotIndex < lastSegment.length - 1;

  return hasRealExtension ? lastSegment.slice(0, lastDotIndex) : lastSegment;
}

/**
 * A deliberately small, exact-match list of near-universally meaningless
 * filename tokens left behind by manual downloads/rips - never legitimate
 * song content. Kept small on purpose (see the Phase 1A brief): every entry
 * here is something that would look absurd as an actual song or album
 * title, so removing it can't plausibly destroy real information.
 *
 * This list is intentionally NOT used for fuzzy/partial matching - see
 * `stripJunkBracketGroups` below, which only removes a bracketed group when
 * its ENTIRE trimmed content matches one of these phrases exactly. That is
 * what keeps this conservative: "(Remix)", "(feat. Drake)", and "(Live at
 * Wembley)" are all left completely alone, because none of them exactly
 * equal an entry here.
 */
const KNOWN_JUNK_PHRASES = new Set<string>([
  'official video',
  'official audio',
  'official music video',
  'lyrics video',
  'lyric video',
  'hq',
  'hd',
  '320kbps',
  '256kbps',
  '192kbps',
  '128kbps',
]);

/**
 * Removes a `[...]` or `(...)` group only when its entire trimmed,
 * comparison-normalized content exactly matches a known junk phrase.
 * Anything else inside brackets or parentheses - featured artists, remix
 * credits, live venue notes, years, legitimate subtitles - is left
 * untouched.
 *
 * Uses the same `normalizeForComparison` used everywhere else in this
 * domain for case-insensitive matching (Phase 1E consistency fix: this
 * previously did its own separate `.trim().toLowerCase()`, which - unlike
 * every other comparison in the domain - did not collapse internal
 * whitespace, so a sloppily-tagged "[ Official   Video ]" would not have
 * matched the known-junk list).
 */
export function stripJunkBracketGroups(value: string): string {
  return value.replace(/[[(]([^\])]*)[\])]/g, (whole, inner: string) => {
    const normalizedInner = normalizeForComparison(inner);
    return KNOWN_JUNK_PHRASES.has(normalizedInner) ? ' ' : whole;
  });
}

export interface FileNameFallbackResult {
  readonly title: string;
  readonly artist: string | undefined;
}

/**
 * Derives a fallback title (and, when the filename follows the common
 * "Artist - Title" convention, a fallback artist) from a filename that has
 * already had its extension removed.
 *
 * The Artist/Title split only fires on " - " - a hyphen with a real space
 * on BOTH sides. This is the deliberate, conservative line: someone naming
 * a file "Artist - Title.mp3" always visually separates the two halves like
 * that, while a hyphen that's actually part of a word or title never has
 * space on both sides ("Anti-Hero", "T-Shirt", "Well-Known", "Spider-Man
 * Theme" all pass through completely unsplit, exactly as they should).
 *
 * If either side of a detected split would be empty after trimming, the
 * split is discarded and the whole cleaned string is used as the title
 * instead - a defensive fallback for filenames like " - Interlude.mp3".
 */
export function parseArtistTitleFromFileName(nameWithoutExtension: string): FileNameFallbackResult {
  const cleaned = normalizeWhitespace(stripJunkBracketGroups(nameWithoutExtension));

  const separatorIndex = cleaned.indexOf(' - ');
  if (separatorIndex === -1) {
    return { title: cleaned, artist: undefined };
  }

  const left = cleaned.slice(0, separatorIndex).trim();
  const right = cleaned.slice(separatorIndex + 3).trim();

  if (left.length === 0 || right.length === 0) {
    return { title: cleaned, artist: undefined };
  }

  return { title: right, artist: left };
}
