import { describe, expect, it } from 'vitest';
import { createFixtureProvider, createLrclibProvider, normaliseForMatch, scoreCandidate, toCandidate, wordSimilarity, type FetchText } from './lrclib-provider.js';

const Q = { title: 'Imagine', artist: 'John Lennon', durationSec: 183 };
const ok = (body: unknown): FetchText => async () => ({ status: 200, text: JSON.stringify(body) });

describe('matching helpers', () => {
  it('normalises case, accents, brackets, feat. and punctuation', () => {
    expect(normaliseForMatch('Café (Remastered 2011) [Live] feat. X')).toBe('cafe');
    expect(wordSimilarity('Imagine', 'IMAGINE!')).toBe(1);
    expect(wordSimilarity('Imagine', 'Jealous Guy')).toBe(0);
  });
  it('scores title, artist and length', () => {
    expect(scoreCandidate(Q, { title: 'Imagine', artist: 'John Lennon', durationSec: 184 })).toBe(1);
    expect(scoreCandidate(Q, { title: 'Imagine', artist: 'John Lennon', durationSec: 300 })).toBeLessThan(0.9);
    expect(scoreCandidate(Q, { title: 'Other', artist: 'Other' })).toBeLessThan(0.2);
  });
  it('compares non-Latin titles by their words too', () => {
    expect(wordSimilarity('تیری یاد', 'تیری یاد آئی')).toBeGreaterThan(0.6);
  });
});

describe('toCandidate', () => {
  it('rejects junk and keeps well-formed entries', () => {
    expect(toCandidate(null, Q)).toBeUndefined();
    expect(toCandidate({ id: 'x', trackName: 'a', plainLyrics: 'b' }, Q)).toBeUndefined();
    expect(toCandidate({ id: 1, trackName: 'a' }, Q)).toBeUndefined(); // nothing to offer
    const c = toCandidate({ id: 1, trackName: 'Imagine', artistName: 'John Lennon', albumName: 'Imagine', duration: 183.4, plainLyrics: 'x', syncedLyrics: '[00:01.00]x', instrumental: false }, Q);
    expect(c).toMatchObject({ id: 1, durationSec: 183, syncedLines: [{ timeMs: 1000, text: 'x' }], match: 1, instrumental: false });
  });
});

describe('provider', () => {
  const rows = [
    { id: 1, trackName: 'Imagine (Live)', artistName: 'Someone Else', duration: 250, plainLyrics: 'a' },
    { id: 2, trackName: 'Imagine', artistName: 'John Lennon', duration: 183, plainLyrics: 'b' },
    { id: 3, trackName: 'Imagine', artistName: 'John Lennon', duration: 183, plainLyrics: 'c', syncedLyrics: '[00:01.00]c' },
    { id: 4, bogus: true },
  ];
  it('ranks by agreement, prefers timed text on ties, drops junk, asks lrclib.net only', async () => {
    let seen = '';
    const provider = createLrclibProvider(async (url) => {
      seen = url;
      return { status: 200, text: JSON.stringify(rows) };
    }, 'NovaTest/1');
    const result = await provider.search(Q);
    expect(seen.startsWith('https://lrclib.net/api/search?')).toBe(true);
    expect(seen).toContain('track_name=Imagine');
    expect(result.status).toBe('ok');
    expect(result.candidates.map((c) => c.id)).toEqual([3, 2, 1]);
  });
  it('maps failures to offline / error / empty', async () => {
    expect((await createLrclibProvider(async () => { throw new Error('ENOTFOUND'); }, 'x').search(Q)).status).toBe('offline');
    expect((await createLrclibProvider(async () => ({ status: 500, text: '' }), 'x').search(Q)).status).toBe('error');
    expect((await createLrclibProvider(async () => ({ status: 200, text: '<html>' }), 'x').search(Q)).status).toBe('error');
    expect((await createLrclibProvider(ok({ not: 'an array' }), 'x').search(Q)).status).toBe('error');
    expect(await createLrclibProvider(async () => ({ status: 404, text: '' }), 'x').search(Q)).toEqual({ status: 'ok', candidates: [] });
  });
  it('fixture provider answers from the given JSON', async () => {
    expect((await createFixtureProvider(JSON.stringify(rows)).search(Q)).candidates).toHaveLength(3);
  });
});
