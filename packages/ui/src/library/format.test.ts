import { describe, expect, it } from 'vitest';

import { formatBytes, formatTotal } from './format.js';
describe('formatBytes / formatTotal', () => {
  it('formats sizes for people and shows nothing for nonsense', () => {
    expect(formatBytes(undefined)).toBe('');
    expect(formatBytes(0)).toBe('');
    expect(formatBytes(512)).toBe('1 KB');
    expect(formatBytes(850 * 1024)).toBe('850 KB');
    expect(formatBytes(6.2 * 1024 * 1024)).toBe('6.2 MB');
    expect(formatBytes(118 * 1024 * 1024)).toBe('118 MB');
  });
  it('formats a long total time', () => {
    expect(formatTotal(30)).toBe('');
    expect(formatTotal(42 * 60)).toBe('42 min');
    expect(formatTotal(3 * 3600 + 5 * 60)).toBe('3 h 05 min');
    expect(formatTotal(5 * 3600)).toBe('5 h');
  });
});
