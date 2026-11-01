/**
 * Plain-text helpers for Lyric Studio: turning pasted / found lyrics into lines to time, and timed lines into `.lrc` text.
 * Pure functions, no I/O. Reading `.lrc` files stays in the domain package (main); this module only cleans pasted text
 * and writes the finished lines out.
 */

export interface PlainLine {
  readonly text: string;
  /** A blank line (verse break) came right before this line. Used as a hint that a pause is likely here. */
  readonly breakBefore: boolean;
}

export interface TimedLine {
  readonly timeMs: number;
  readonly text: string;
}

export const MAX_STUDIO_LINES = 400;

const STAMP_TAG = /\[\s*\d{1,3}\s*:\s*\d{1,2}(?:[.:]\d{1,3})?\s*]/g;
const META_TAG = /^\s*\[(?:ti|ar|al|au|by|re|ve|length|offset|la|lang)\s*:[^\]]*\]\s*$/i;
const SECTION_TAG = /^\s*[[(]\s*(?:verse|chorus|bridge|intro|outro|hook|pre-?chorus|refrain|instrumental|solo|interlude)[^\])]*[\])]\s*$/i;

/** Splits pasted or found lyrics into the lines to be timed. Timestamps and `[ar:]`-style headers are dropped; blank lines become `breakBefore`. */
export function splitLyricsText(raw: string): PlainLine[] {
  const lines: PlainLine[] = [];
  let pendingBreak = false;
  for (const original of raw.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)) {
    if (META_TAG.test(original)) continue;
    const text = original.replace(STAMP_TAG, '').replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, '').replace(/\s+/g, ' ').trim();
    if (text === '') {
      pendingBreak = lines.length > 0;
      continue;
    }
    if (SECTION_TAG.test(text)) {
      pendingBreak = lines.length > 0; // a section label is a break, not a sung line
      continue;
    }
    lines.push({ text, breakBefore: pendingBreak });
    pendingBreak = false;
    if (lines.length >= MAX_STUDIO_LINES) break;
  }
  return lines;
}

/** Minutes:seconds.centiseconds (rounded) - the form every player reads. Minutes may exceed 59. */
export function formatLrcTime(ms: number): string {
  const centis = Math.max(0, Math.round(ms / 10));
  const minutes = Math.floor(centis / 6000);
  const seconds = Math.floor((centis % 6000) / 100);
  const hundredths = centis % 100;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}`;
}

/** Builds `.lrc` text. Times are forced to be non-decreasing; `header` entries become `[key:value]` lines first. */
export function buildLrc(lines: readonly TimedLine[], header: Readonly<Record<string, string>> = {}): string {
  const head = Object.entries(header)
    .filter(([key, value]) => /^[a-z]{2,6}$/.test(key) && value.trim() !== '')
    .map(([key, value]) => `[${key}:${value.replace(/[\r\n\]]+/g, ' ').replace(/\s+/g, ' ').trim()}]`);
  let last = 0;
  const body = lines.map((line) => {
    last = Math.max(last, Math.round(line.timeMs));
    return `[${formatLrcTime(last)}]${line.text}`;
  });
  return [...head, ...body].join('\n') + '\n';
}
