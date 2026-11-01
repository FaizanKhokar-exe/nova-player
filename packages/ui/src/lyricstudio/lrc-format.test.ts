import { describe, expect, it } from 'vitest';
import { buildLrc, formatLrcTime, splitLyricsText } from './lrc-format.js';

describe('splitLyricsText', () => {
  it('drops headers, timestamps and section labels; marks verse breaks; keeps any script', () => {
    const lines = splitLyricsText('﻿[ar:Someone]\n[Verse 1]\n[00:01.00] hello  world \r\n\r\nدل کی بات\n\n\n(Chorus)\nप्यार <00:05.00>हो');
    expect(lines).toEqual([
      { text: 'hello world', breakBefore: false },
      { text: 'دل کی بات', breakBefore: true },
      { text: 'प्यार हो', breakBefore: true },
    ]);
  });
  it('caps the number of lines', () => {
    expect(splitLyricsText(Array.from({ length: 900 }, (_, i) => `l${i}`).join('\n'))).toHaveLength(400);
  });
});

describe('buildLrc / formatLrcTime', () => {
  it('formats centiseconds and long minutes', () => {
    expect(formatLrcTime(0)).toBe('00:00.00');
    expect(formatLrcTime(61_234)).toBe('01:01.23');
    expect(formatLrcTime(3_725_000)).toBe('62:05.00');
  });
  it('builds a non-decreasing .lrc with a clean header', () => {
    const text = buildLrc([{ timeMs: 1000, text: 'a' }, { timeMs: 500, text: 'b' }, { timeMs: 3200, text: 'c' }], { ti: 'My ]Song', by: 'Nova', bad_key: 'x', ar: ' ' });
    expect(text).toBe('[ti:My Song]\n[by:Nova]\n[00:01.00]a\n[00:01.00]b\n[00:03.20]c\n');
  });
});
