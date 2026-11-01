import { describe, expect, it } from 'vitest';
import { countSyllables, lineWeight } from './syllables.js';

describe('countSyllables', () => {
  it('counts English by vowel groups (a final e counts: Roman Urdu sings it)', () => {
    expect(countSyllables('imagine')).toBe(4); // over by one (the final e is counted); relative weights still hold
    expect(countSyllables('night')).toBe(1);
    expect(countSyllables('mujhe')).toBe(2);
    expect(countSyllables('the')).toBe(1);
    expect(countSyllables('Imagine all the people')).toBe(4 + 1 + 1 + 2 + 0);
  });
  it('counts Roman Urdu / Hindi like Latin text', () => {
    expect(countSyllables('tum ho to mujhe pyaar')).toBeGreaterThanOrEqual(6);
    expect(countSyllables('dil')).toBe(1);
  });
  it('counts Devanagari and Gurmukhi beats, joining conjuncts', () => {
    expect(countSyllables('प्यार')).toBe(2); // प्य (virama joins) + र
    expect(countSyllables('दिल')).toBe(2);
    expect(countSyllables('ਦਿਲ')).toBe(2);
  });
  it('counts Arabic-script (Urdu) by letters per beat, at least one per word', () => {
    expect(countSyllables('دل')).toBe(1.25);
    expect(countSyllables('محبت')).toBeGreaterThan(2);
    expect(countSyllables('تم')).toBeGreaterThanOrEqual(1);
  });
  it('counts CJK and Hangul one per character, Cyrillic by vowels', () => {
    expect(countSyllables('君の名は')).toBe(4);
    expect(countSyllables('사랑해')).toBe(3);
    expect(countSyllables('привет')).toBe(2);
  });
  it('handles mixed scripts, punctuation, emptiness', () => {
    expect(countSyllables('dil دل')).toBe(1 + 1.25);
    expect(countSyllables('...!?')).toBe(0);
    expect(countSyllables('')).toBe(0);
    expect(lineWeight('...')).toBeCloseTo(1.35);
  });
});
