import type { LyricLine } from './lrc.js';

/**
 * Index of the lyric line that is active at `currentTimeMs`, or
 * `undefined` if playback hasn't reached the first line yet (or the list
 * is empty, or the time is NaN).
 *
 * The active line is the LAST line whose `timeMs` is at or before the
 * current time:
 *   - exactly on a line's timestamp -> that line is active
 *   - between two lines             -> the earlier one stays active
 *   - after the final line          -> the final line stays active
 *   - several lines share the winning timestamp -> the last of them (in
 *     source order) is active
 *
 * Precondition: `lines` is sorted by `timeMs` ascending, as returned by
 * `parseLyrics`. Uses binary search, since a UI calls this on every
 * playback time update.
 *
 * The active line's `text` can be empty (a preserved empty timed line,
 * i.e. an instrumental gap) - callers should treat that as "nothing to
 * highlight", not as "no active line".
 */
export function getActiveLyricIndex(
  lines: readonly LyricLine[],
  currentTimeMs: number,
): number | undefined {
  if (Number.isNaN(currentTimeMs)) return undefined;

  let low = 0;
  let high = lines.length - 1;
  let found = -1;

  while (low <= high) {
    const mid = (low + high) >>> 1;
    const line = lines[mid];
    if (line !== undefined && line.timeMs <= currentTimeMs) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return found === -1 ? undefined : found;
}

/** The lyric line active at `currentTimeMs`; see `getActiveLyricIndex`. */
export function getActiveLyric(
  lines: readonly LyricLine[],
  currentTimeMs: number,
): LyricLine | undefined {
  const index = getActiveLyricIndex(lines, currentTimeMs);
  return index === undefined ? undefined : lines[index];
}

/**
 * The playback position, in milliseconds, that seeking to this lyric line
 * should jump to. Deliberately trivial: a line's seek position IS its
 * normalized `timeMs` (offset already applied by the parser). Actually
 * performing the seek is the audio layer's job in a later phase.
 */
export function getLyricSeekTime(line: LyricLine): number {
  return line.timeMs;
}
