import { getActiveLyricIndex, getLyricSeekTime } from '@nova/domain';
import type { LyricLineDto } from '@nova/shared';

/**
 * The renderer's ONE import from the domain (the boundary test pins it to exactly these two pure,
 * dependency-free functions and to this file): the Phase 1D lyric rules are CONSUMED here, not
 * re-implemented. Everything is canonical integer milliseconds, the same unit as the playback
 * position, so there is no second clock and no conversion.
 *
 * `LyricLineDto` is structurally the domain's `LyricLine` (timeMs + text); parsing, offsets and
 * ordering already happened in main, so the lines arrive sorted with the offset applied.
 */

/** Index of the line being sung at `positionMs`, or `undefined` before the first line. */
export function activeLyricIndex(lines: readonly LyricLineDto[], positionMs: number): number | undefined {
  return getActiveLyricIndex(lines, positionMs);
}

/** Where to seek when the user selects a line. */
export function lyricSeekMs(line: LyricLineDto): number {
  return getLyricSeekTime(line);
}
