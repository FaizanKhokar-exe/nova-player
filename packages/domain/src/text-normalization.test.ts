import { describe, expect, it } from 'vitest';
import { normalizeWhitespace, normalizeForComparison } from './text-normalization.js';

describe('normalizeWhitespace', () => {
  it('trims leading and trailing whitespace', () => {
    expect(normalizeWhitespace('  Daft Punk  ')).toBe('Daft Punk');
  });

  it('collapses repeated internal whitespace to a single space', () => {
    expect(normalizeWhitespace('Daft    Punk')).toBe('Daft Punk');
  });

  it('collapses mixed tabs/newlines/spaces to a single space', () => {
    expect(normalizeWhitespace('Daft\t\n  Punk')).toBe('Daft Punk');
  });

  it('preserves a single internal space unchanged', () => {
    expect(normalizeWhitespace('Daft Punk')).toBe('Daft Punk');
  });

  it('preserves capitalization', () => {
    expect(normalizeWhitespace('  MGMT  ')).toBe('MGMT');
  });

  it('returns an empty string for whitespace-only input', () => {
    expect(normalizeWhitespace('   ')).toBe('');
  });
});

describe('normalizeForComparison', () => {
  it('produces a deterministic, case-insensitive comparison form', () => {
    expect(normalizeForComparison('Daft Punk')).toBe(normalizeForComparison('daft punk'));
    expect(normalizeForComparison('DAFT PUNK')).toBe(normalizeForComparison('Daft Punk'));
  });

  it('normalizes whitespace as part of the comparison form', () => {
    expect(normalizeForComparison('Daft   Punk')).toBe(normalizeForComparison('Daft Punk'));
    expect(normalizeForComparison('  Daft Punk  ')).toBe(normalizeForComparison('Daft Punk'));
  });

  it('never mutates its input, only its return value', () => {
    const input = 'Daft Punk';
    normalizeForComparison(input);
    expect(input).toBe('Daft Punk');
  });
});
