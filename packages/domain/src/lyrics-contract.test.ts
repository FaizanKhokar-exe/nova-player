import { describe, expect, it } from 'vitest';
import { getActiveLyric, getActiveLyricIndex, getLyricSeekTime } from './active-lyric.js';
import { parseLyrics } from './lrc.js';

/**
 * Phase 6 regression protection. The sidecar-lyrics IPC ships `parseLyrics(...).lines` unchanged and the
 * renderer drives the active line and click-to-seek from `getActiveLyricIndex` / `getLyricSeekTime`.
 * These pin the exact semantics that path relies on, so a change in the domain cannot silently shift
 * what the UI shows.
 */
describe('what the lyrics IPC and the Now Playing UI rely on', () => {
  const parsed = parseLyrics('[offset:+250]\n[00:05.00][00:01.00]chorus\n[00:03.00]\n[00:03.00]tie\n[00:09.5]late\nnot a lyric\n');

  it('lines are integer milliseconds, offset already applied, sorted by time', () => {
    expect(parsed.lines.map((l) => l.timeMs)).toEqual([1250, 3250, 3250, 5250, 9750]);
    expect(parsed.lines.every((l) => Number.isInteger(l.timeMs))).toBe(true);
    expect(parsed.offsetMs).toBe(250);
  });

  it('equal times keep file order, and an empty timed line is kept as an empty line', () => {
    expect(parsed.lines.slice(1, 3)).toEqual([
      { timeMs: 3250, text: '' },
      { timeMs: 3250, text: 'tie' },
    ]);
  });

  it('a negative offset never produces a negative time', () => {
    expect(parseLyrics('[offset:-5000]\n[00:01.00]x').lines).toEqual([{ timeMs: 0, text: 'x' }]);
  });

  it('active line: none before the first line, exactly-at-time is active, the later of equal times wins, the last line stays active', () => {
    const lines = parsed.lines;
    expect(getActiveLyricIndex(lines, 0)).toBeUndefined();
    expect(getActiveLyricIndex(lines, 1249)).toBeUndefined();
    expect(getActiveLyricIndex(lines, 1250)).toBe(0);
    expect(getActiveLyricIndex(lines, 3249)).toBe(0);
    expect(getActiveLyricIndex(lines, 3250)).toBe(2);
    expect(getActiveLyricIndex(lines, 9749)).toBe(3);
    expect(getActiveLyricIndex(lines, 9750)).toBe(4);
    expect(getActiveLyricIndex(lines, 3_600_000)).toBe(4);
    expect(getActiveLyric(lines, 5250)?.text).toBe('chorus');
  });

  it('seeking to a line is exactly its time, so the line is then active', () => {
    for (const line of parsed.lines) {
      const index = getActiveLyricIndex(parsed.lines, getLyricSeekTime(line));
      expect(parsed.lines[index ?? -1]?.timeMs).toBe(line.timeMs);
    }
  });

  it('no usable lines, or garbage input, is simply empty and never throws', () => {
    for (const text of ['', '   ', '[ar:Only a header]', 'plain words', '\u0000\uFFFD[00:99', '[00:01.00'.repeat(1000)]) {
      expect(() => parseLyrics(text)).not.toThrow();
    }
    expect(parseLyrics('').lines).toEqual([]);
    expect(parseLyrics('[ar:x]\nwords only').lines).toEqual([]);
    expect(getActiveLyricIndex([], 5000)).toBeUndefined();
    expect(getActiveLyricIndex(parsed.lines, Number.NaN)).toBeUndefined();
  });
});
