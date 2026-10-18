import { describe, expect, it } from 'vitest';
import { InvalidRequestError } from './validation.js';
import {
  MAX_POSITION_MS,
  validateDiagnoseSource,
  validatePlayTrack,
  validatePositioned,
  validateReportPosition,
  validateSetRepeatMode,
  validateSetShuffle,
  validateTrackFinished,
} from './playback-validation.js';

const ID = '123e4567-e89b-42d3-a456-426614174000';
const bad = (fn: () => unknown): void => expect(fn).toThrow(InvalidRequestError);

describe('track ids (the renderer is untrusted)', () => {
  it.each([undefined, null, 42, '', 'nope', '../../etc/passwd', `${ID}/..`, `${ID} `, ID.slice(1), '123e4567-e89b-12d3-a456-426614174000', {}, [ID]])('rejects %j', (value) => {
    bad(() => validatePlayTrack({ trackId: value }));
    bad(() => validateTrackFinished({ trackId: value }));
    bad(() => validateDiagnoseSource({ trackId: value }));
    bad(() => validateReportPosition({ trackId: value, positionMs: 0 }));
  });

  it('accepts a well-formed id', () => {
    expect(validatePlayTrack({ trackId: ID })).toEqual({ trackId: ID });
    expect(validateTrackFinished({ trackId: ID })).toEqual({ trackId: ID });
    expect(validateDiagnoseSource({ trackId: ID })).toEqual({ trackId: ID });
  });
});

describe('every request must be an object with only the known keys', () => {
  it.each([undefined, null, 'x', 5, true, [], [ID]])('rejects the non-object %j', (raw) => {
    for (const validate of [validatePlayTrack, validatePositioned, validateTrackFinished, validateSetRepeatMode, validateSetShuffle, validateReportPosition, validateDiagnoseSource]) {
      bad(() => validate(raw));
    }
  });

  it('rejects unexpected fields (no smuggling a path in)', () => {
    bad(() => validatePlayTrack({ trackId: ID, path: '/etc/passwd' }));
    bad(() => validatePlayTrack({ trackId: ID, context: { kind: 'library' }, sourcePath: '/x' }));
    bad(() => validatePositioned({ positionMs: 0, extra: 1 }));
    bad(() => validateTrackFinished({ trackId: ID, positionMs: 1 }));
    bad(() => validateSetRepeatMode({ mode: 'off', x: 1 }));
    bad(() => validateSetShuffle({ enabled: true, x: 1 }));
    bad(() => validateReportPosition({ trackId: ID, positionMs: 0, url: 'x' }));
    bad(() => validateDiagnoseSource({ trackId: ID, path: 'x' }));
  });
});

describe('playTrack context', () => {
  it('defaults to absent (main then uses the library)', () => {
    expect(validatePlayTrack({ trackId: ID })).toEqual({ trackId: ID });
  });
  it('accepts library and search contexts', () => {
    expect(validatePlayTrack({ trackId: ID, context: { kind: 'library' } }).context).toEqual({ kind: 'library' });
    expect(validatePlayTrack({ trackId: ID, context: { kind: 'search', query: 'abc 夜' } }).context).toEqual({ kind: 'search', query: 'abc 夜' });
    expect(validatePlayTrack({ trackId: ID, context: { kind: 'search', query: '' } }).context).toEqual({ kind: 'search', query: '' });
  });
  it.each([
    null,
    'library',
    {},
    { kind: 'playlist' },
    { kind: 'library', query: 'x' },
    { kind: 'search' },
    { kind: 'search', query: 5 },
    { kind: 'search', query: 'x'.repeat(501) },
    { kind: 'search', query: 'x', limit: 5 },
  ])('rejects the context %j', (context) => {
    bad(() => validatePlayTrack({ trackId: ID, context }));
  });
});

describe('positions are whole non-negative milliseconds', () => {
  it.each([0, 1, 12_345, MAX_POSITION_MS])('accepts %i', (positionMs) => {
    expect(validatePositioned({ positionMs })).toEqual({ positionMs });
    expect(validateReportPosition({ trackId: ID, positionMs })).toEqual({ trackId: ID, positionMs });
  });
  it.each([-1, 1.5, 0.001, Number.NaN, Infinity, -Infinity, MAX_POSITION_MS + 1, 2 ** 53, '10', null, undefined, {}])('rejects %j', (positionMs) => {
    bad(() => validatePositioned({ positionMs }));
    bad(() => validateReportPosition({ trackId: ID, positionMs }));
  });
});

describe('modes', () => {
  it.each(['off', 'all', 'one'])('accepts repeat mode %s', (mode) => expect(validateSetRepeatMode({ mode })).toEqual({ mode }));
  it.each(['ALL', 'none', '', 1, null, undefined, 'one '])('rejects repeat mode %j', (mode) => bad(() => validateSetRepeatMode({ mode })));
  it.each([true, false])('accepts shuffle %s', (enabled) => expect(validateSetShuffle({ enabled })).toEqual({ enabled }));
  it.each([0, 1, 'true', null, undefined])('rejects shuffle %j', (enabled) => bad(() => validateSetShuffle({ enabled })));
});
