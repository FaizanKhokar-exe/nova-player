import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SEARCH_LIMIT,
  InvalidRequestError,
  MAX_LIST_LIMIT,
  MAX_QUERY_LENGTH,
  MAX_SEARCH_LIMIT,
  validateListTracks,
  validateNoRequest,
  validateRemoveRoot,
  validateSearch,
  validateStartScan,
} from './validation.js';

const ID = '123e4567-e89b-42d3-a456-426614174000';
const bad = (fn: () => unknown): void => expect(fn).toThrow(InvalidRequestError);

describe('validateNoRequest', () => {
  it('accepts only undefined', () => {
    expect(() => validateNoRequest(undefined)).not.toThrow();
    for (const value of [null, {}, 0, '', 'x', [], { path: 'C:\\' }]) bad(() => validateNoRequest(value));
  });
});

describe('validateRemoveRoot', () => {
  it('accepts { rootId } with an id-shaped string', () => {
    expect(validateRemoveRoot({ rootId: ID })).toEqual({ rootId: ID });
  });
  it.each([undefined, null, 'x', 5, [], {}, { rootId: 5 }, { rootId: '' }, { rootId: 'short' }, { rootId: ID, extra: 1 }, { rootId: `${ID}0` }])(
    'rejects %j',
    (value) => bad(() => validateRemoveRoot(value)),
  );
});

describe('validateStartScan', () => {
  it('treats no request / an empty object as "scan everything"', () => {
    expect(validateStartScan(undefined)).toEqual({});
    expect(validateStartScan({})).toEqual({});
    expect(validateStartScan({ rootId: undefined })).toEqual({});
  });
  it('accepts a rootId', () => expect(validateStartScan({ rootId: ID })).toEqual({ rootId: ID }));
  it.each([null, 'x', 5, [], { rootId: 5 }, { rootId: 'nope' }, { rootId: ID, path: 'C:\\Music' }])('rejects %j', (value) =>
    bad(() => validateStartScan(value)),
  );
});

describe('validateListTracks', () => {
  it('defaults to everything from 0', () => {
    expect(validateListTracks(undefined)).toEqual({ offset: 0, limit: undefined });
    expect(validateListTracks({})).toEqual({ offset: 0, limit: undefined });
  });
  it('accepts valid paging', () => {
    expect(validateListTracks({ offset: 10, limit: 50 })).toEqual({ offset: 10, limit: 50 });
    expect(validateListTracks({ limit: 0 })).toEqual({ offset: 0, limit: 0 });
    expect(validateListTracks({ limit: MAX_LIST_LIMIT })).toEqual({ offset: 0, limit: MAX_LIST_LIMIT });
  });
  it.each([null, 'x', [], { offset: -1 }, { limit: -1 }, { offset: 1.5 }, { limit: Number.NaN }, { limit: Infinity }, { limit: '5' }, { limit: MAX_LIST_LIMIT + 1 }, { skip: 1 }])(
    'rejects %j',
    (value) => bad(() => validateListTracks(value)),
  );
});

describe('validateSearch', () => {
  it('requires a query string and applies the default limit', () => {
    expect(validateSearch({ query: 'abc' })).toEqual({ query: 'abc', limit: DEFAULT_SEARCH_LIMIT });
    expect(validateSearch({ query: '', limit: 5 })).toEqual({ query: '', limit: 5 });
    expect(validateSearch({ query: '夜に駆ける' }).query).toBe('夜に駆ける');
  });
  it('accepts the maximum query length and limit', () => {
    expect(validateSearch({ query: 'x'.repeat(MAX_QUERY_LENGTH), limit: MAX_SEARCH_LIMIT }).limit).toBe(MAX_SEARCH_LIMIT);
  });
  it.each([
    undefined, null, 'abc', 5, [], {}, { query: 5 }, { query: null }, { query: 'a', limit: -1 }, { query: 'a', limit: 1.5 },
    { query: 'a', limit: MAX_SEARCH_LIMIT + 1 }, { query: 'x'.repeat(MAX_QUERY_LENGTH + 1) }, { query: 'a', filter: 'title' },
  ])('rejects %j', (value) => bad(() => validateSearch(value)));
});
