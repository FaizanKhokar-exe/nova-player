import { describe, expect, it } from 'vitest';
import { parseLyrics } from './lrc.js';

function lines(text: string) {
  return parseLyrics(text).lines;
}

describe('basic parsing', () => {
  it('parses standard LRC into exact millisecond timestamps and text', () => {
    expect(lines('[00:12.34]Hello\n[01:02.500]World\n[12:34.56]Another line')).toEqual([
      { timeMs: 12_340, text: 'Hello' },
      { timeMs: 62_500, text: 'World' },
      { timeMs: 754_560, text: 'Another line' },
    ]);
  });

  it('returns nothing for an empty string', () => {
    expect(parseLyrics('')).toEqual({
      lines: [],
      metadata: { artist: undefined, title: undefined, album: undefined, by: undefined },
      offsetMs: 0,
    });
  });

  it('returns nothing for whitespace-only input', () => {
    expect(lines('  \n\t\n   ')).toEqual([]);
  });

  it('tolerates non-string input instead of throwing', () => {
    expect(parseLyrics(undefined as unknown as string).lines).toEqual([]);
  });

  it('ignores a leading BOM and leading whitespace on a line', () => {
    expect(lines('\uFEFF[00:01.00]First\n   [00:02.00]  Second  ')).toEqual([
      { timeMs: 1000, text: 'First' },
      { timeMs: 2000, text: 'Second' },
    ]);
  });

  it('normalizes repeated whitespace inside lyric text', () => {
    expect(lines('[00:01.00]Too    many   spaces')).toEqual([
      { timeMs: 1000, text: 'Too many spaces' },
    ]);
  });

  it('keeps punctuation and brackets that appear inside the text', () => {
    expect(lines('[00:01.00]Hey! (ooh) [aside: x]')).toEqual([
      { timeMs: 1000, text: 'Hey! (ooh) [aside: x]' },
    ]);
  });
});

describe('timestamp formats', () => {
  it('treats .xx as centiseconds', () => {
    expect(lines('[01:02.50]x')[0]?.timeMs).toBe(62_500);
  });

  it('treats .xxx as milliseconds, giving the same result for the same instant', () => {
    expect(lines('[01:02.500]x')[0]?.timeMs).toBe(62_500);
    expect(lines('[01:02.750]x')[0]?.timeMs).toBe(62_750);
    expect(lines('[01:02.005]x')[0]?.timeMs).toBe(62_005);
  });

  it('treats a single fraction digit as tenths', () => {
    expect(lines('[00:01.5]x')[0]?.timeMs).toBe(1500);
  });

  it('accepts a timestamp with no fraction', () => {
    expect(lines('[00:05]x')[0]?.timeMs).toBe(5000);
  });

  it('accepts a colon before the fraction', () => {
    expect(lines('[00:01:50]x')[0]?.timeMs).toBe(1500);
  });

  it('produces integer milliseconds', () => {
    for (const line of lines('[00:01.10]a\n[00:02.30]b\n[00:03.07]c')) {
      expect(Number.isInteger(line.timeMs)).toBe(true);
    }
  });

  it('does not accept a fraction longer than three digits', () => {
    expect(lines('[00:01.5000]x')).toEqual([]);
  });
});

describe('multiple timestamps on one line', () => {
  it('produces one entry per timestamp', () => {
    expect(lines('[00:10.00][00:20.00]Repeated lyric')).toEqual([
      { timeMs: 10_000, text: 'Repeated lyric' },
      { timeMs: 20_000, text: 'Repeated lyric' },
    ]);
  });

  it('sorts stacked timestamps that are listed out of order', () => {
    expect(lines('[00:20.00][00:10.00]X').map((l) => l.timeMs)).toEqual([10_000, 20_000]);
  });

  it('interleaves repeated lines correctly with other lines', () => {
    expect(lines('[00:10.00][00:30.00]Chorus\n[00:20.00]Verse')).toEqual([
      { timeMs: 10_000, text: 'Chorus' },
      { timeMs: 20_000, text: 'Verse' },
      { timeMs: 30_000, text: 'Chorus' },
    ]);
  });
});

describe('metadata tags', () => {
  const text = [
    '[ar:Chris Grey]',
    '[ti:  Let The   World Burn ]',
    '[al:Some Album]',
    '[by:Some Creator]',
    '[re:Some Tool]',
    '[ve:1.0]',
    '[00:01.00]First line',
  ].join('\n');

  it('captures artist, title, album, and by', () => {
    expect(parseLyrics(text).metadata).toEqual({
      artist: 'Chris Grey',
      title: 'Let The World Burn',
      album: 'Some Album',
      by: 'Some Creator',
    });
  });

  it('never turns metadata (including unrecognized tags) into lyric lines', () => {
    expect(parseLyrics(text).lines).toEqual([{ timeMs: 1000, text: 'First line' }]);
  });

  it('treats tag names as case-insensitive', () => {
    expect(parseLyrics('[AR:Someone]\n[Ti:Song]').metadata).toMatchObject({
      artist: 'Someone',
      title: 'Song',
    });
  });

  it('handles a metadata-only file', () => {
    const parsed = parseLyrics('[ar:Artist]\n[ti:Title]\n[offset:250]');
    expect(parsed.lines).toEqual([]);
    expect(parsed.metadata.artist).toBe('Artist');
    expect(parsed.offsetMs).toBe(250);
  });

  it('treats an empty metadata value as absent', () => {
    expect(parseLyrics('[ar:]').metadata.artist).toBeUndefined();
  });

  it('lets the last occurrence of a tag win', () => {
    expect(parseLyrics('[ti:First]\n[ti:Second]').metadata.title).toBe('Second');
  });

  it('keeps a colon inside a metadata value', () => {
    expect(parseLyrics('[ti:Part 1: The Start]').metadata.title).toBe('Part 1: The Start');
  });
});

describe('offset (positive offset delays lyrics: timeMs = raw + offset)', () => {
  it('applies a positive offset', () => {
    const parsed = parseLyrics('[offset:500]\n[00:10.00]A');
    expect(parsed.lines).toEqual([{ timeMs: 10_500, text: 'A' }]);
    expect(parsed.offsetMs).toBe(500);
  });

  it('applies a negative offset', () => {
    const parsed = parseLyrics('[offset:-500]\n[00:10.00]A');
    expect(parsed.lines).toEqual([{ timeMs: 9500, text: 'A' }]);
    expect(parsed.offsetMs).toBe(-500);
  });

  it('accepts an explicit plus sign', () => {
    expect(lines('[offset:+500]\n[00:10.00]A')[0]?.timeMs).toBe(10_500);
  });

  it('changes nothing when there is no offset', () => {
    const parsed = parseLyrics('[00:10.00]A');
    expect(parsed.lines[0]?.timeMs).toBe(10_000);
    expect(parsed.offsetMs).toBe(0);
  });

  it('applies to every line, including ones before the tag', () => {
    expect(lines('[00:10.00]A\n[offset:1000]\n[00:20.00]B').map((l) => l.timeMs)).toEqual([
      11_000, 21_000,
    ]);
  });

  it('applies to every timestamp on a multi-timestamp line', () => {
    expect(lines('[offset:100]\n[00:10.00][00:20.00]X').map((l) => l.timeMs)).toEqual([
      10_100, 20_100,
    ]);
  });

  it('uses the last valid offset tag', () => {
    expect(parseLyrics('[offset:100]\n[offset:300]\n[00:01.00]A').offsetMs).toBe(300);
  });

  it('ignores a malformed offset value', () => {
    const parsed = parseLyrics('[offset:abc]\n[offset:12.5]\n[00:01.00]A');
    expect(parsed.offsetMs).toBe(0);
    expect(parsed.lines[0]?.timeMs).toBe(1000);
  });

  it('clamps timestamps that would become negative to 0', () => {
    expect(lines('[offset:-5000]\n[00:02.00]A')).toEqual([{ timeMs: 0, text: 'A' }]);
  });

  it('never produces a negative timestamp', () => {
    for (const line of lines('[offset:-999999]\n[00:01.00]A\n[10:00.00]B')) {
      expect(line.timeMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('keeps the original chronological order for lines that clamp to the same time', () => {
    expect(lines('[offset:-5000]\n[00:03.00]Later\n[00:02.00]Earlier')).toEqual([
      { timeMs: 0, text: 'Earlier' },
      { timeMs: 0, text: 'Later' },
    ]);
  });
});

describe('malformed input tolerance', () => {
  it('ignores lines that are not usable lyrics', () => {
    const text = [
      'this is not lrc',
      '[abc:def]broken',
      '[99:xx]broken',
      '[]',
      '[Chorus]',
      '[00:1.00]x',
    ].join('\n');
    expect(lines(text)).toEqual([]);
  });

  it('keeps valid lines around a malformed one', () => {
    expect(lines('[00:01.00]Valid\n[broken]Ignore this\n[00:02.00]Also valid')).toEqual([
      { timeMs: 1000, text: 'Valid' },
      { timeMs: 2000, text: 'Also valid' },
    ]);
  });

  it('does not treat an untimed text line as a lyric', () => {
    expect(lines('just words\n[00:01.00]timed')).toEqual([{ timeMs: 1000, text: 'timed' }]);
  });

  it('never throws on garbage input', () => {
    expect(() => parseLyrics('[[[[\n]]]]\n<<<>>>\n[00:\n[:]\n\u0000')).not.toThrow();
  });
});

describe('empty timed lines', () => {
  it('preserves a timed line with no text, with empty text', () => {
    expect(lines('[00:10.00]')).toEqual([{ timeMs: 10_000, text: '' }]);
  });

  it('never leaves the timestamp behind as text', () => {
    expect(lines('[00:10.00]   ')[0]?.text).toBe('');
  });

  it('keeps an instrumental gap between two lyric lines', () => {
    expect(lines('[00:05.00]Sing\n[00:10.00]\n[00:20.00]Sing again')).toEqual([
      { timeMs: 5000, text: 'Sing' },
      { timeMs: 10_000, text: '' },
      { timeMs: 20_000, text: 'Sing again' },
    ]);
  });
});

describe('ordering and duplicates', () => {
  it('sorts unsorted input by timestamp', () => {
    expect(lines('[00:30.00]C\n[00:10.00]A\n[00:20.00]B').map((l) => l.text)).toEqual([
      'A',
      'B',
      'C',
    ]);
  });

  it('keeps every line that shares a timestamp, in source order', () => {
    expect(lines('[00:10.00]Line A\n[00:10.00]Line B')).toEqual([
      { timeMs: 10_000, text: 'Line A' },
      { timeMs: 10_000, text: 'Line B' },
    ]);
  });

  it('does not de-duplicate identical lines', () => {
    expect(lines('[00:10.00]Same\n[00:10.00]Same')).toHaveLength(2);
    expect(lines('[00:10.00][00:10.00]Same')).toHaveLength(2);
  });

  it('keeps source order for equal timestamps regardless of text', () => {
    expect(lines('[00:10.00]Z\n[00:10.00]A\n[00:10.00]M').map((l) => l.text)).toEqual([
      'Z',
      'A',
      'M',
    ]);
  });

  it('parses the same input to equal results every time', () => {
    const text = '[ar:X]\n[offset:120]\n[00:20.00][00:05.00]A\n[00:05.00]B\n[00:07.00]';
    expect(parseLyrics(text)).toEqual(parseLyrics(text));
  });
});

describe('line endings', () => {
  const crlf = '[00:01.00]A\r\n[00:02.00]B\r\n';
  const lf = '[00:01.00]A\n[00:02.00]B\n';
  const cr = '[00:01.00]A\r[00:02.00]B\r';

  it('parses CRLF, LF, and lone CR identically', () => {
    const expected = [
      { timeMs: 1000, text: 'A' },
      { timeMs: 2000, text: 'B' },
    ];
    expect(lines(crlf)).toEqual(expected);
    expect(lines(lf)).toEqual(expected);
    expect(lines(cr)).toEqual(expected);
  });

  it('leaves no carriage return in the text', () => {
    expect(lines(crlf).every((l) => !l.text.includes('\r'))).toBe(true);
  });
});

describe('inline word timing', () => {
  it('strips <mm:ss.xx> markers so they never appear in visible text', () => {
    expect(lines('[00:10.00]<00:10.00>Hello <00:10.50>world')).toEqual([
      { timeMs: 10_000, text: 'Hello world' },
    ]);
  });

  it('strips markers placed inside a word', () => {
    expect(lines('[00:10.00]Hel<00:10.30>lo')[0]?.text).toBe('Hello');
  });

  it('supports the .xxx and no-fraction marker forms', () => {
    expect(lines('[00:10.00]<00:10.123>A <00:11>B')[0]?.text).toBe('A B');
  });

  it('leaves a line that contains only markers as an empty timed line', () => {
    expect(lines('[00:10.00]<00:10.00><00:11.00>')).toEqual([{ timeMs: 10_000, text: '' }]);
  });

  it('keeps the line timestamp from the leading tag, not from the markers', () => {
    expect(lines('[00:10.00]<00:15.00>Late word')[0]?.timeMs).toBe(10_000);
  });

  it('does not strip angle-bracket text that is not a timing marker', () => {
    expect(lines('[00:01.00]I <3 you <b>so</b> much')[0]?.text).toBe('I <3 you <b>so</b> much');
  });
});
