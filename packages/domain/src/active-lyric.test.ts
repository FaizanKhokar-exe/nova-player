import { describe, expect, it } from 'vitest';
import { getActiveLyric, getActiveLyricIndex, getLyricSeekTime } from './active-lyric.js';
import { parseLyrics, type LyricLine } from './lrc.js';

const lines: readonly LyricLine[] = [
  { timeMs: 10_000, text: 'First' },
  { timeMs: 20_000, text: 'Second' },
  { timeMs: 30_000, text: 'Third' },
];

describe('getActiveLyric', () => {
  it('has no active lyric before the first line', () => {
    expect(getActiveLyric(lines, 0)).toBeUndefined();
    expect(getActiveLyric(lines, 9999)).toBeUndefined();
  });

  it('activates a line exactly at its timestamp', () => {
    expect(getActiveLyric(lines, 10_000)?.text).toBe('First');
    expect(getActiveLyric(lines, 20_000)?.text).toBe('Second');
  });

  it('keeps the most recent line active between two lines', () => {
    expect(getActiveLyric(lines, 15_000)?.text).toBe('First');
    expect(getActiveLyric(lines, 29_999)?.text).toBe('Second');
  });

  it('keeps the final line active after the end', () => {
    expect(getActiveLyric(lines, 30_000)?.text).toBe('Third');
    expect(getActiveLyric(lines, 9_999_999)?.text).toBe('Third');
    expect(getActiveLyric(lines, Number.POSITIVE_INFINITY)?.text).toBe('Third');
  });

  it('returns undefined for an empty lyric list', () => {
    expect(getActiveLyric([], 5000)).toBeUndefined();
  });

  it('activates a line at 0 ms when playback is at 0', () => {
    expect(getActiveLyric([{ timeMs: 0, text: 'Intro' }], 0)?.text).toBe('Intro');
  });

  it('returns undefined for a negative or NaN time', () => {
    expect(getActiveLyric(lines, -1)).toBeUndefined();
    expect(getActiveLyric(lines, Number.NaN)).toBeUndefined();
  });

  it('works with a single line', () => {
    const single = [{ timeMs: 5000, text: 'Only' }];
    expect(getActiveLyric(single, 4999)).toBeUndefined();
    expect(getActiveLyric(single, 5000)?.text).toBe('Only');
    expect(getActiveLyric(single, 60_000)?.text).toBe('Only');
  });

  it('activates the last of several lines that share a timestamp', () => {
    const shared: LyricLine[] = [
      { timeMs: 10_000, text: 'A' },
      { timeMs: 10_000, text: 'B' },
      { timeMs: 20_000, text: 'C' },
    ];
    expect(getActiveLyric(shared, 10_000)?.text).toBe('B');
    expect(getActiveLyric(shared, 15_000)?.text).toBe('B');
    expect(getActiveLyric(shared, 20_000)?.text).toBe('C');
  });

  it('can return a preserved empty line, representing an instrumental gap', () => {
    const withGap: LyricLine[] = [
      { timeMs: 5000, text: 'Sing' },
      { timeMs: 10_000, text: '' },
      { timeMs: 20_000, text: 'Sing again' },
    ];
    expect(getActiveLyric(withGap, 12_000)).toEqual({ timeMs: 10_000, text: '' });
  });

  it('does not mutate a frozen lyric list or its lines', () => {
    const frozen = Object.freeze(lines.map((line) => Object.freeze({ ...line })));
    expect(() => getActiveLyric(frozen, 25_000)).not.toThrow();
    expect(getActiveLyric(frozen, 25_000)).toBe(frozen[1]);
  });

  it('returns the original line object, not a copy', () => {
    expect(getActiveLyric(lines, 20_000)).toBe(lines[1]);
  });
});

describe('getActiveLyricIndex', () => {
  it('returns the index of the active line', () => {
    expect(getActiveLyricIndex(lines, 15_000)).toBe(0);
    expect(getActiveLyricIndex(lines, 20_000)).toBe(1);
    expect(getActiveLyricIndex(lines, 99_000)).toBe(2);
  });

  it('returns undefined when nothing is active', () => {
    expect(getActiveLyricIndex(lines, 100)).toBeUndefined();
    expect(getActiveLyricIndex([], 100)).toBeUndefined();
  });

  it('agrees with a naive linear scan across many times and duplicate timestamps', () => {
    const many: LyricLine[] = Array.from({ length: 2000 }, (_, i) => ({
      timeMs: Math.floor(i / 2) * 1000, // every timestamp appears twice
      text: `line ${i}`,
    }));

    const linear = (t: number): number | undefined => {
      let found: number | undefined;
      for (const [i, line] of many.entries()) {
        if (line.timeMs <= t) found = i;
        else break;
      }
      return found;
    };

    for (let t = -500; t < 1_100_000; t += 777) {
      expect(getActiveLyricIndex(many, t)).toBe(linear(t));
    }
  });
});

describe('getLyricSeekTime', () => {
  it('returns the line timestamp in milliseconds', () => {
    expect(getLyricSeekTime({ timeMs: 62_500, text: 'x' })).toBe(62_500);
  });

  it('returns 0 for a line at the start', () => {
    expect(getLyricSeekTime({ timeMs: 0, text: 'x' })).toBe(0);
  });

  it('makes the sought line the active one', () => {
    const target = lines[1] as LyricLine;
    expect(getActiveLyric(lines, getLyricSeekTime(target))).toBe(target);
  });
});

describe('parser + lookup together', () => {
  it('uses offset-adjusted times for lookup and seek', () => {
    const { lines: parsed } = parseLyrics('[offset:500]\n[00:10.00]First\n[00:20.00]Second');

    expect(getActiveLyric(parsed, 10_499)).toBeUndefined();
    expect(getActiveLyric(parsed, 10_500)?.text).toBe('First');
    expect(getLyricSeekTime(parsed[1] as LyricLine)).toBe(20_500);
  });

  it('handles a parsed file with an instrumental gap end to end', () => {
    const { lines: parsed } = parseLyrics('[00:05.00]Sing\n[00:10.00]\n[00:20.00]Again');

    expect(getActiveLyric(parsed, 7000)?.text).toBe('Sing');
    expect(getActiveLyric(parsed, 12_000)?.text).toBe('');
    expect(getActiveLyric(parsed, 25_000)?.text).toBe('Again');
  });
});
