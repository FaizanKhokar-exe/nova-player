import { describe, expect, it } from 'vitest';
import { createTrackId, isValidTrackId, parseTrackId } from './track-id.js';

describe('createTrackId', () => {
  it('creates a valid TrackId', () => {
    const id = createTrackId();
    expect(isValidTrackId(id)).toBe(true);
  });

  it('creates a different ID on every call', () => {
    const a = createTrackId();
    const b = createTrackId();
    expect(a).not.toBe(b);
  });
});

describe('isValidTrackId', () => {
  it('accepts a real UUID v4', () => {
    expect(isValidTrackId('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
  });

  it('accepts uppercase hex digits', () => {
    expect(isValidTrackId('550E8400-E29B-41D4-A716-446655440000')).toBe(true);
  });

  it('rejects an empty string', () => {
    expect(isValidTrackId('')).toBe(false);
  });

  it('rejects a plain non-UUID string (e.g. a filename-derived legacy ID)', () => {
    expect(isValidTrackId('my-song.mp3-12345')).toBe(false);
  });

  it('rejects a UUID missing a segment', () => {
    expect(isValidTrackId('550e8400-e29b-41d4-a716')).toBe(false);
  });

  it('rejects a non-v4 UUID (wrong version nibble)', () => {
    expect(isValidTrackId('550e8400-e29b-11d4-a716-446655440000')).toBe(false);
  });
});

describe('parseTrackId', () => {
  it('returns the branded ID for a valid string', () => {
    const raw = '550e8400-e29b-41d4-a716-446655440000';
    expect(parseTrackId(raw)).toBe(raw);
  });

  it('returns undefined for an invalid string rather than throwing', () => {
    expect(parseTrackId('not-a-uuid')).toBeUndefined();
  });
});
