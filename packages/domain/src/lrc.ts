import { normalizeWhitespace } from './text-normalization.js';

/**
 * One line of synced lyrics.
 *
 * `timeMs` is always a non-negative integer number of milliseconds - never
 * floating-point seconds - and already has the file's `[offset:]` applied.
 * `text` may be an empty string: a timed line with no text is preserved on
 * purpose (see `parseLyrics`).
 */
export interface LyricLine {
  readonly timeMs: number;
  readonly text: string;
}

/**
 * The small set of LRC header tags Nova Player keeps. Any other header tag
 * (`[re:]`, `[ve:]`, `[length:]`, ...) is recognized and discarded rather
 * than shown as lyric text.
 */
export interface LyricsMetadata {
  readonly artist: string | undefined;
  readonly title: string | undefined;
  readonly album: string | undefined;
  /** The `[by:]` tag - who created the LRC file. */
  readonly by: string | undefined;
}

export interface ParsedLyrics {
  /** Sorted by `timeMs`; see `parseLyrics` for tie-breaking. */
  readonly lines: readonly LyricLine[];
  readonly metadata: LyricsMetadata;
  /** The `[offset:]` value found in the file (0 if none), in ms. It has
   *  ALREADY been applied to every line in `lines`; it is reported so a
   *  caller can show or persist it, never re-apply it. */
  readonly offsetMs: number;
}

// [mm:ss], [mm:ss.x], [mm:ss.xx], [mm:ss.xxx], and the `:`-separated
// fraction variant [mm:ss:xx] that real-world files contain. Seconds are
// exactly two digits; a value like 75 is accepted arithmetically (this is a
// tolerant parser, not a validator).
const TIME_TAG = String.raw`\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]`;
const TIME_TAG_GLOBAL = new RegExp(TIME_TAG, 'g');

// One or more time tags at the very START of a line (optional whitespace
// between them). Only leading tags are line timestamps.
const LEADING_TIME_TAGS = new RegExp(`^(?:\\s*${TIME_TAG})+`);

// A whole-line header tag such as [ar:Artist]. The key is letters (or #)
// only, so a time tag like [00:12.34] can never be mistaken for one.
const METADATA_LINE = /^\[([A-Za-z#]+):([^\]]*)\]$/;

// Inline word-timing markers from "enhanced" LRC, e.g. <00:10.50>.
const INLINE_WORD_TIMING = /<\d{1,3}:\d{2}(?:[.:]\d{1,3})?>/g;

const OFFSET_VALUE = /^[+-]?\d+$/;

function tagToMs(tag: RegExpMatchArray): number {
  const minutes = Number(tag[1] ?? 0);
  const seconds = Number(tag[2] ?? 0);
  // "5" -> "500", "50" -> "500", "500" -> "500": a 1-3 digit fraction is
  // padded to milliseconds, keeping everything in integer arithmetic.
  const fractionMs = Number((tag[3] ?? '').padEnd(3, '0'));
  return minutes * 60_000 + seconds * 1000 + fractionMs;
}

function parseOffsetMs(value: string): number | undefined {
  const trimmed = value.trim();
  if (!OFFSET_VALUE.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function metadataValue(value: string): string | undefined {
  const cleaned = normalizeWhitespace(value);
  return cleaned.length > 0 ? cleaned : undefined;
}

interface RawEntry {
  readonly rawMs: number;
  readonly text: string;
  readonly sequence: number;
}

/**
 * Parses already-decoded LRC text. Decoding bytes to text (UTF-8/16/ANSI
 * detection) is infrastructure's job and deliberately not done here.
 *
 * Tolerance: this never throws on lyric content. A line that is not a
 * usable timed lyric (plain text, `[broken]`, `[99:xx]`, `[]`, section
 * labels like `[Chorus]`, unknown header tags) is skipped and parsing
 * continues with the next line.
 *
 * Timestamps: leading `[mm:ss.xx]` / `[mm:ss.xxx]` tags (also `[mm:ss]`,
 * `[mm:ss.x]`, `[mm:ss:xx]`). A line may start with several tags
 * (`[00:10.00][00:20.00]Chorus`) and produces one entry per tag. Tags in
 * the middle of a line are NOT treated as timestamps.
 *
 * Offset: `[offset:N]` is in milliseconds and is ADDED to every timestamp,
 * so a positive offset makes lyrics appear LATER and a negative one
 * EARLIER. This is Nova Player's established behavior, carried over from
 * the original implementation; note it is the opposite sign from the
 * original LRC spec's description. The offset applies to the whole file
 * regardless of where the tag appears, and if several valid offset tags
 * exist the last one wins. A malformed offset value is ignored. Timestamps
 * that would become negative are clamped to 0.
 *
 * Empty timed lines (`[00:10.00]` with no text) are PRESERVED with
 * `text: ''`. In LRC these mark instrumental breaks, and keeping them lets
 * a UI clear the highlighted line during a gap instead of leaving the
 * previous lyric lingering. (The original implementation dropped them.)
 * Rendering or skipping them is a UI decision.
 *
 * Inline `<mm:ss.xx>` word-timing markers are removed from the text; no
 * word-level timing is kept. Text whitespace is normalized with the same
 * `normalizeWhitespace` used for track metadata.
 *
 * Ordering: by final `timeMs`, then by the original (pre-offset,
 * pre-clamp) time, then by position in the source (line order, then tag
 * order within a line). Nothing is de-duplicated: two lines at the same
 * timestamp are both kept, in source order.
 *
 * Header tags: `ar`, `ti`, `al`, `by` are kept in `metadata` (names are
 * case-insensitive, values whitespace-normalized, last occurrence wins).
 */
export function parseLyrics(text: string): ParsedLyrics {
  let artist: string | undefined;
  let title: string | undefined;
  let album: string | undefined;
  let by: string | undefined;
  let offsetMs = 0;
  const entries: RawEntry[] = [];

  if (typeof text === 'string') {
    let sequence = 0;

    // String.prototype.trim() also removes a stray leading BOM (U+FEFF).
    for (const rawLine of text.split(/\r\n|\r|\n/)) {
      const line = rawLine.trim();
      if (line.length === 0) continue;

      const header = METADATA_LINE.exec(line);
      if (header !== null) {
        const key = (header[1] ?? '').toLowerCase();
        const value = header[2] ?? '';
        if (key === 'ar') artist = metadataValue(value);
        else if (key === 'ti') title = metadataValue(value);
        else if (key === 'al') album = metadataValue(value);
        else if (key === 'by') by = metadataValue(value);
        else if (key === 'offset') offsetMs = parseOffsetMs(value) ?? offsetMs;
        continue;
      }

      const leading = LEADING_TIME_TAGS.exec(line);
      if (leading === null) continue;

      const content = normalizeWhitespace(
        line.slice(leading[0].length).replace(INLINE_WORD_TIMING, ''),
      );

      for (const tag of leading[0].matchAll(TIME_TAG_GLOBAL)) {
        entries.push({ rawMs: tagToMs(tag), text: content, sequence });
        sequence += 1;
      }
    }
  }

  const lines: LyricLine[] = entries
    .map((entry) => ({ ...entry, timeMs: Math.max(0, entry.rawMs + offsetMs) }))
    .sort((a, b) => a.timeMs - b.timeMs || a.rawMs - b.rawMs || a.sequence - b.sequence)
    .map((entry) => ({ timeMs: entry.timeMs, text: entry.text }));

  return { lines, metadata: { artist, title, album, by }, offsetMs };
}
