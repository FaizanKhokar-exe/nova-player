import { describe, expect, it } from 'vitest';
import { MAX_SOURCE_VERSION, buildNovaMediaUrl, buildTrackMediaUrl, parseNovaMediaUrl } from './media-url.js';
import type { TrackId } from '@nova/domain';

const ID = '123e4567-e89b-42d3-a456-426614174000' as TrackId;

describe('buildTrackMediaUrl / parseNovaMediaUrl: library tracks', () => {
  it('builds an opaque URL from the id alone', () => {
    expect(buildTrackMediaUrl(ID)).toBe(`nova-media://track/${ID}`);
  });

  it('round-trips', () => {
    expect(parseNovaMediaUrl(buildTrackMediaUrl(ID))).toEqual({ kind: 'track', trackId: ID, version: 0 });
  });

  it('a version is a cache key only: it adds exactly "?v=N" and round-trips', () => {
    expect(buildTrackMediaUrl(ID, 0)).toBe(`nova-media://track/${ID}`);
    expect(buildTrackMediaUrl(ID, 3)).toBe(`nova-media://track/${ID}?v=3`);
    expect(parseNovaMediaUrl(buildTrackMediaUrl(ID, 3))).toEqual({ kind: 'track', trackId: ID, version: 3 });
    expect(buildTrackMediaUrl(ID, MAX_SOURCE_VERSION + 50)).toBe(`nova-media://track/${ID}?v=${MAX_SOURCE_VERSION}`);
    expect(buildTrackMediaUrl(ID, 2.9)).toBe(`nova-media://track/${ID}?v=2`);
  });

  it.each(['?v=', '?v=abc', '?v=-1', '?v=1.5', '?v=1&x=2', '?x=1&v=1', '?V=1', '?v=1234567890', '?v=1%26x', '?', '?v=1&', '?v=0x10'])(
    'no other query is accepted (%s)',
    (query) => {
      const parsed = parseNovaMediaUrl(`nova-media://track/${ID}${query}`);
      // "?" alone normalises to no query; everything else is invalid
      if (query === '?') expect(parsed).toEqual({ kind: 'track', trackId: ID, version: 0 });
      else expect(parsed).toEqual({ kind: 'invalid', reason: 'query-or-fragment' });
    },
  );

  it('the spike URL shape accepts no query at all', () => {
    expect(parseNovaMediaUrl('nova-media://local/tmp/a.mp3?v=1')).toEqual({ kind: 'invalid', reason: 'query-or-fragment' });
  });

  it('accepts an upper-case id (ids are case-insensitive hex) and keeps its spelling', () => {
    const upper = ID.toUpperCase();
    expect(parseNovaMediaUrl(`nova-media://track/${upper}`)).toEqual({ kind: 'track', trackId: upper, version: 0 });
  });

  it('contains no path-like information', () => {
    const afterScheme = buildTrackMediaUrl(ID).slice('nova-media://'.length);
    expect(afterScheme).toBe(`track/${ID}`);
    expect(afterScheme).not.toMatch(/[\\:]|\.\./);
  });
});

describe('parseNovaMediaUrl: everything else is invalid (and never throws)', () => {
  const cases: Array<[string, string]> = [
    ['', 'unparseable'],
    ['not a url', 'unparseable'],
    ['://', 'unparseable'],
    ['http://track/' + ID, 'wrong-scheme'],
    ['file:///etc/passwd', 'wrong-scheme'],
    ['nova-media://other/' + ID, 'unknown-host'],
    ['nova-media://media/' + ID, 'unknown-host'],
    ['nova-media://track.evil.com/' + ID, 'unknown-host'],
    [`nova-media://track/${ID}?x=1`, 'query-or-fragment'],
    [`nova-media://track/${ID}?v=1#frag`, 'query-or-fragment'],
    [`nova-media://track/${ID}#frag`, 'query-or-fragment'],
    [`nova-media://track/${ID}/`, 'invalid-track-id'],
    [`nova-media://track/${ID}/extra`, 'invalid-track-id'],
    [`nova-media://track/..%2f${ID}`, 'invalid-track-id'],
    [`nova-media://track/%2e%2e%2f${ID}`, 'invalid-track-id'],
    [`nova-media://track/${ID}%2f..`, 'invalid-track-id'],
    [`nova-media://track/${ID}%2f..%2f..%2fetc%2fpasswd`, 'invalid-track-id'],
    ['nova-media://track/', 'invalid-track-id'],
    ['nova-media://track', 'invalid-track-id'],
    ['nova-media://track/not-a-uuid', 'invalid-track-id'],
    ['nova-media://track/%2Fetc%2Fpasswd', 'invalid-track-id'],
    ['nova-media://track/C:%5CWindows%5Cwin.ini', 'invalid-track-id'],
    ['nova-media://track/123e4567-e89b-12d3-a456-426614174000', 'invalid-track-id'], // not a v4 uuid
    [`nova-media://track/${ID}%00`, 'invalid-track-id'],
    ['nova-media://local/%E0%A4%A', 'malformed-path'],
  ];

  it.each(cases)('%j is rejected as %s', (input, reason) => {
    expect(parseNovaMediaUrl(input)).toEqual({ kind: 'invalid', reason });
  });
});

describe('dot segments are collapsed by the URL parser itself - and can only ever name a valid id', () => {
  it.each([`nova-media://track/../${ID}`, `nova-media://track/%2e%2e/${ID}`, `nova-media://track/./${ID}`])(
    '%s resolves to the plain track URL, never to a different resource',
    (input) => {
      // WHATWG URL parsing (the same one Chromium applies before any handler runs) normalises these to
      // `/<id>`. Nothing can climb out: the only thing that can come out is a well-formed TrackId, and
      // access to it is still decided by the media-access policy.
      expect(parseNovaMediaUrl(input)).toEqual({ kind: 'track', trackId: ID, version: 0 });
    },
  );
});

describe('credentials and ports (defense in depth: a Request refuses credentials before the handler)', () => {
  it.each([`nova-media://me@track/${ID}`, `nova-media://me:pw@track/${ID}`, `nova-media://track:99/${ID}`])('%s is rejected by the parser', (input) => {
    expect(parseNovaMediaUrl(input)).toEqual({ kind: 'invalid', reason: 'credentials-or-port' });
  });
});

describe('the Phase 0 spike URL shape (nova-media://local/<path>)', () => {
  it('round-trips an absolute path, including spaces and Unicode', () => {
    const file = '/tmp/some dir/夜に駆ける – 100%.mp3';
    expect(parseNovaMediaUrl(buildNovaMediaUrl(file))).toEqual({ kind: 'local', path: file });
  });

  it('keeps ".." segments verbatim: deciding containment is the handler\'s job, not the parser\'s', () => {
    const parsed = parseNovaMediaUrl('nova-media://local/a/%2e%2e/b');
    expect(parsed.kind).toBe('local');
  });
});
