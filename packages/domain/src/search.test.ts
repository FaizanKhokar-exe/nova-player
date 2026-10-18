import { describe, expect, it } from 'vitest';
import { searchTracks } from './search.js';
import { createTrack, type RawTrackMetadata, type Track } from './track.js';
import type { TrackId } from './track-id.js';

/**
 * Builds a real Track through the Phase 1A createTrack policy (so these
 * tests exercise the actual domain model, not a hand-rolled lookalike).
 * Readable labels stand in for UUIDs, as in the queue tests - search treats
 * TrackId as an opaque value.
 */
function makeTrack(label: string, raw: RawTrackMetadata): Track {
  return createTrack({ id: label as TrackId, sourcePath: `/music/${label}.mp3`, raw });
}

function ids(results: ReturnType<typeof searchTracks>): string[] {
  return results.map((result) => String(result.track.id));
}

const believe = makeTrack('believe', { title: 'Believe', artist: 'Cher', album: 'Believe', genre: 'Pop' });
const blindingLights = makeTrack('blinding', {
  title: 'Blinding Lights',
  artist: 'The Weeknd',
  album: 'After Hours',
  genre: 'Synth-pop',
});
const afterHours = makeTrack('afterhours', {
  title: 'After Hours',
  artist: 'The Weeknd',
  album: 'After Hours',
  genre: 'R&B',
});
const acdc = makeTrack('acdc', { title: 'Back In Black', artist: 'AC/DC', album: 'Back in Black', genre: 'Rock' });
const dontStop = makeTrack('dontstop', {
  title: "Don't Stop Me Now",
  artist: 'Queen',
  album: 'Jazz',
  genre: 'Rock',
});

const library = [believe, blindingLights, afterHours, acdc, dontStop];

describe('query handling', () => {
  it('returns no results for an empty query (never an arbitrary slice of the library)', () => {
    expect(searchTracks(library, '')).toEqual([]);
  });

  it('returns no results for a whitespace-only query', () => {
    expect(searchTracks(library, '   \t  ')).toEqual([]);
  });

  it('ignores leading and trailing whitespace', () => {
    expect(ids(searchTracks(library, '   cher   '))).toEqual(ids(searchTracks(library, 'cher')));
    expect(ids(searchTracks(library, '   cher   '))).toEqual(['believe']);
  });

  it('treats repeated internal whitespace as a single space', () => {
    expect(ids(searchTracks(library, 'after     hours'))).toEqual(ids(searchTracks(library, 'after hours')));
    expect(searchTracks(library, 'after     hours').length).toBeGreaterThan(0);
  });

  it('is case-insensitive for uppercase, lowercase, and mixed-case queries', () => {
    const lower = ids(searchTracks(library, 'weeknd'));
    expect(ids(searchTracks(library, 'WEEKND'))).toEqual(lower);
    expect(ids(searchTracks(library, 'WeEkNd'))).toEqual(lower);
    expect(lower.length).toBeGreaterThan(0);
  });

  it('never changes the displayed metadata of a matched track', () => {
    const [result] = searchTracks(library, 'weeknd');
    expect(result?.track.artist).toBe('The Weeknd');
  });
});

describe('field matching', () => {
  it('matches on title', () => {
    const [result] = searchTracks(library, 'bel');
    expect(result?.track.id).toBe('believe');
    expect(result?.match).toEqual({ kind: 'field', field: 'title', quality: 'prefix' });
  });

  it('matches on artist', () => {
    const results = searchTracks(library, 'week');
    expect(ids(results)).toEqual(['afterhours', 'blinding']);
    expect(results.every((r) => r.match.kind === 'field' && r.match.field === 'artist')).toBe(true);
  });

  it('matches on album', () => {
    const results = searchTracks([makeTrack('x', { title: 'Song', artist: 'Someone', album: 'After Hours' })], 'after');
    expect(results[0]?.match).toEqual({ kind: 'field', field: 'album', quality: 'prefix' });
  });

  it('matches on genre', () => {
    const results = searchTracks(library, 'synth');
    expect(ids(results)).toEqual(['blinding']);
    expect(results[0]?.match).toEqual({ kind: 'field', field: 'genre', quality: 'prefix' });
  });

  it('matches on album artist when the track artist differs (compilation case)', () => {
    const compilation = makeTrack('comp', {
      title: 'Some Song',
      artist: 'Guest Singer',
      albumArtist: 'Various Artists',
      album: 'Hits',
    });
    const results = searchTracks([compilation], 'various');
    expect(results[0]?.match).toEqual({ kind: 'field', field: 'albumArtist', quality: 'prefix' });
  });

  it('returns nothing when no field matches', () => {
    expect(searchTracks(library, 'zzzz-not-here')).toEqual([]);
  });
});

describe('match quality', () => {
  const tracks = [
    makeTrack('exact', { title: 'Believe', artist: 'X' }),
    makeTrack('prefix', { title: 'Believe In Me', artist: 'X' }),
    makeTrack('substring', { title: 'Cant Help But Believe', artist: 'X' }),
  ];

  it('classifies exact, prefix, and substring title matches', () => {
    const qualities = searchTracks(tracks, 'believe').map((r) => r.match.kind === 'field' && r.match.quality);
    expect(qualities).toEqual(['exact', 'prefix', 'substring']);
  });

  it('ranks exact before prefix before substring within the same field', () => {
    expect(ids(searchTracks([...tracks].reverse(), 'believe'))).toEqual(['exact', 'prefix', 'substring']);
  });

  it('finds a substring inside an artist', () => {
    const results = searchTracks([makeTrack('a', { title: 'T', artist: 'The Weeknd' })], 'eek');
    expect(results[0]?.match).toEqual({ kind: 'field', field: 'artist', quality: 'substring' });
  });

  it('finds a substring inside an album', () => {
    const results = searchTracks([makeTrack('a', { title: 'T', artist: 'A', album: 'After Hours' })], 'hour');
    expect(results[0]?.match).toEqual({ kind: 'field', field: 'album', quality: 'substring' });
  });

  it('finds a substring inside a genre', () => {
    const results = searchTracks([makeTrack('a', { title: 'T', artist: 'A', genre: 'Synth-pop' })], 'pop');
    expect(results[0]?.match).toEqual({ kind: 'field', field: 'genre', quality: 'substring' });
  });
});

describe('multi-word queries', () => {
  it('matches a whole phrase inside one field', () => {
    const [result] = searchTracks(library, 'after hours');
    expect(result?.track.id).toBe('afterhours');
    expect(result?.match).toEqual({ kind: 'field', field: 'title', quality: 'exact' });
  });

  it('matches an artist phrase including a leading article', () => {
    const results = searchTracks(library, 'the weeknd');
    expect(results.length).toBe(2);
    expect(results.every((r) => r.match.kind === 'field' && r.match.field === 'artist')).toBe(true);
  });

  it('matches when words are spread across different fields (artist + album)', () => {
    const results = searchTracks(library, 'weeknd after hours');
    expect(ids(results)).toEqual(['afterhours', 'blinding']);
    expect(results.every((r) => r.match.kind === 'words')).toBe(true);
  });

  it('does not require the words to appear in query order', () => {
    expect(ids(searchTracks(library, 'hours weeknd'))).toEqual(['afterhours', 'blinding']);
  });

  it('requires every word to match somewhere', () => {
    expect(searchTracks(library, 'weeknd rock')).toEqual([]);
  });

  it('ranks whole-phrase matches above word-spread matches', () => {
    const phraseInAlbum = makeTrack('phrase', { title: 'Zzz', artist: 'Zzz', album: 'Night Drive' });
    const spread = makeTrack('spread', { title: 'Night', artist: 'Drive Band' });
    expect(ids(searchTracks([spread, phraseInAlbum], 'night drive'))).toEqual(['phrase', 'spread']);
  });
});

describe('punctuation', () => {
  it('matches punctuation literally', () => {
    expect(ids(searchTracks(library, 'ac/dc'))).toEqual(['acdc']);
  });

  it("matches an apostrophe in a title", () => {
    expect(ids(searchTracks(library, "don't stop"))).toEqual(['dontstop']);
  });

  it('does not treat a query without the apostrophe as a match (punctuation is significant)', () => {
    expect(searchTracks(library, 'dont stop')).toEqual([]);
  });
});

describe('ordering', () => {
  it('ranks a title match above an artist match, even when the artist match is exact', () => {
    const titleContains = makeTrack('title', { title: 'Long Live The Queen', artist: 'Someone Else' });
    const artistExact = makeTrack('artist', { title: 'Bohemian Rhapsody', artist: 'Queen' });
    expect(ids(searchTracks([artistExact, titleContains], 'queen'))).toEqual(['title', 'artist']);
  });

  it('ranks artist above album above genre', () => {
    const genre = makeTrack('genre', { title: 'A', artist: 'A', genre: 'Jazz' });
    const album = makeTrack('album', { title: 'B', artist: 'B', album: 'Jazz Hands' });
    const artist = makeTrack('artist', { title: 'C', artist: 'Jazz Trio' });
    expect(ids(searchTracks([genre, album, artist], 'jazz'))).toEqual(['artist', 'album', 'genre']);
  });

  it('orders equally-ranked matches by title, case-insensitively', () => {
    const results = searchTracks(
      [
        makeTrack('z', { title: 'Zebra Song', artist: 'A' }),
        makeTrack('a', { title: 'apple song', artist: 'A' }),
        makeTrack('m', { title: 'Mango Song', artist: 'A' }),
      ],
      'song',
    );
    expect(ids(results)).toEqual(['a', 'm', 'z']);
  });

  it('breaks title ties by artist, then by track ID', () => {
    const tracks = [
      makeTrack('a', { title: 'Intro', artist: 'Zed' }),
      makeTrack('c', { title: 'Intro', artist: 'Abe' }),
      makeTrack('b', { title: 'Intro', artist: 'Abe' }),
    ];
    expect(ids(searchTracks(tracks, 'intro'))).toEqual(['b', 'c', 'a']);
  });

  it('produces the same order regardless of input order', () => {
    const tracks = [
      makeTrack('t1', { title: 'Intro', artist: 'Zed' }),
      makeTrack('t2', { title: 'Intro', artist: 'Abe' }),
      makeTrack('t3', { title: 'Intro Two', artist: 'Abe' }),
      makeTrack('t4', { title: 'Outro Intro', artist: 'Mo' }),
    ];
    const expected = ids(searchTracks(tracks, 'intro'));

    const orderings = [
      [3, 2, 1, 0],
      [1, 3, 0, 2],
      [2, 0, 3, 1],
      [0, 3, 2, 1],
    ];
    for (const ordering of orderings) {
      const permuted = ordering.map((index) => tracks[index] as Track);
      expect(ids(searchTracks(permuted, 'intro'))).toEqual(expected);
    }
  });

  it('is repeatable: the same input always yields the same output', () => {
    expect(ids(searchTracks(library, 'a'))).toEqual(ids(searchTracks(library, 'a')));
  });
});

describe('data quality', () => {
  it('finds a track whose artist, album, and genre are all missing', () => {
    const bare = makeTrack('bare', { title: 'Lonely Track' });
    expect(ids(searchTracks([bare], 'lonely'))).toEqual(['bare']);
  });

  it('does not match a missing album or genre against the query', () => {
    const bare = makeTrack('bare', { title: 'Lonely Track', artist: 'Someone' });
    expect(searchTracks([bare], 'undefined')).toEqual([]);
  });

  it('ignores empty and whitespace-only metadata fields', () => {
    const base = makeTrack('odd', { title: 'Song', artist: 'Artist' });
    const odd: Track = { ...base, album: '', genre: '   ', albumArtist: '' };
    expect(searchTracks([odd], 'song').length).toBe(1);
    expect(searchTracks([odd], 'x')).toEqual([]);
  });

  it('does not crash on malformed runtime metadata', () => {
    const base = makeTrack('bad', { title: 'Fine Title', artist: 'Fine Artist' });
    const malformed = {
      ...base,
      artist: undefined as unknown as string,
      album: 42 as unknown as string,
      genre: null as unknown as string,
    } as Track;
    expect(() => searchTracks([malformed], 'fine')).not.toThrow();
    expect(ids(searchTracks([malformed], 'fine'))).toEqual(['bad']);
  });

  it('handles unusual but valid titles', () => {
    const tracks = [
      makeTrack('num', { title: '1999', artist: 'Prince' }),
      makeTrack('sym', { title: '!!!', artist: 'Band' }),
      makeTrack('emoji', { title: 'Party 🎉 Time', artist: 'DJ' }),
      makeTrack('jp', { title: '夜に駆ける', artist: 'YOASOBI' }),
    ];
    expect(ids(searchTracks(tracks, '1999'))).toEqual(['num']);
    expect(ids(searchTracks(tracks, '!!!'))).toEqual(['sym']);
    expect(ids(searchTracks(tracks, '🎉'))).toEqual(['emoji']);
    expect(ids(searchTracks(tracks, '夜に'))).toEqual(['jp']);
  });

  it('returns an empty list for an empty library', () => {
    expect(searchTracks([], 'anything')).toEqual([]);
  });
});

describe('immutability', () => {
  it('does not mutate a frozen input array or frozen Track objects', () => {
    const frozen = library.map((track) => Object.freeze({ ...track, artwork: Object.freeze({ ...track.artwork }) }));
    Object.freeze(frozen);
    expect(() => searchTracks(frozen, 'after hours')).not.toThrow();
  });

  it('leaves the input array and its order untouched', () => {
    const input = [...library];
    const snapshot = [...input];
    searchTracks(input, 'a');
    expect(input).toHaveLength(snapshot.length);
    input.forEach((track, index) => expect(track).toBe(snapshot[index]));
  });

  it('returns the original Track objects, not copies', () => {
    const [result] = searchTracks(library, 'cher');
    expect(result?.track).toBe(believe);
  });
});
