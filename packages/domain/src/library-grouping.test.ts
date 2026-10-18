import { describe, expect, it } from 'vitest';
import { genreNamesOf, groupTracks, selectGroup, type GroupableTrack } from './library-grouping.js';

function t(id: string, extra: Partial<GroupableTrack> & { title?: string; artist?: string } = {}): GroupableTrack {
  return { id, title: extra.title ?? `Title ${id}`, artist: extra.artist ?? 'Artist', ...extra };
}

const names = (tracks: readonly GroupableTrack[], kind: Parameters<typeof groupTracks>[1]): string[] => groupTracks(tracks, kind).map((group) => group.name);

describe('artist grouping', () => {
  it('groups by album artist when present, else by track artist', () => {
    const tracks = [
      t('1', { artist: 'Daft Punk' }),
      t('2', { artist: 'Guest', albumArtist: 'Various Artists' }),
      t('3', { artist: 'Other', albumArtist: 'Various Artists' }),
    ];
    expect(names(tracks, 'artist')).toEqual(['Daft Punk', 'Various Artists']);
    expect(groupTracks(tracks, 'artist').find((g) => g.name === 'Various Artists')?.trackCount).toBe(2);
  });

  it('treats case and whitespace differences as one artist and shows the most common spelling', () => {
    const tracks = [t('1', { artist: 'radiohead' }), t('2', { artist: ' Radiohead ' }), t('3', { artist: 'Radiohead' }), t('4', { artist: 'RADIOHEAD' })];
    const groups = groupTracks(tracks, 'artist');
    expect(groups).toHaveLength(1);
    expect(groups[0]?.name).toBe('Radiohead');
    expect(groups[0]?.trackCount).toBe(4);
  });

  it('breaks a spelling tie by code-unit order, independent of input order', () => {
    const a = [t('1', { artist: 'abba' }), t('2', { artist: 'ABBA' })];
    expect(names(a, 'artist')).toEqual(['ABBA']);
    expect(names([...a].reverse(), 'artist')).toEqual(['ABBA']);
  });

  it('does not split artist strings', () => {
    expect(names([t('1', { artist: 'Earth, Wind & Fire' }), t('2', { artist: 'A feat. B' })], 'artist')).toEqual(['A feat. B', 'Earth, Wind & Fire']);
  });

  it('puts the Phase 1 "Unknown Artist" fallback and blank artists in ONE unknown group, listed last', () => {
    const tracks = [t('1', { artist: 'Unknown Artist' }), t('2', { artist: '   ' }), t('3', { artist: 'Zed' }), t('4', { artist: 'unknown artist' })];
    const groups = groupTracks(tracks, 'artist');
    expect(groups.map((g) => g.name)).toEqual(['Zed', 'Unknown Artist']);
    expect(groups[1]?.unknown).toBe(true);
    expect(groups[1]?.trackCount).toBe(3);
  });

  it('counts albums per artist, including the unknown album', () => {
    const tracks = [t('1', { artist: 'A', album: 'One' }), t('2', { artist: 'A', album: 'one ' }), t('3', { artist: 'A', album: 'Two' }), t('4', { artist: 'A' })];
    expect(groupTracks(tracks, 'artist')[0]?.albumCount).toBe(3);
  });
});

describe('album grouping', () => {
  it('separates same-titled albums of different artists', () => {
    const tracks = [t('1', { artist: 'A', album: 'Greatest Hits' }), t('2', { artist: 'B', album: 'Greatest Hits' }), t('3', { artist: 'A', album: 'greatest  hits' })];
    const groups = groupTracks(tracks, 'album');
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => [g.artist, g.trackCount])).toEqual([
      ['A', 2],
      ['B', 1],
    ]);
  });

  it('keeps a compilation together by album artist', () => {
    const tracks = [t('1', { artist: 'X', albumArtist: 'Various Artists', album: 'Mix' }), t('2', { artist: 'Y', albumArtist: 'Various Artists', album: 'Mix' })];
    const groups = groupTracks(tracks, 'album');
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ name: 'Mix', artist: 'Various Artists', trackCount: 2 });
  });

  it('gives each artist its own "Unknown Album", listed after known albums', () => {
    const tracks = [t('1', { artist: 'A' }), t('2', { artist: 'B' }), t('3', { artist: 'A', album: 'Real' }), t('4', { artist: 'A', album: '  ' })];
    const groups = groupTracks(tracks, 'album');
    expect(groups.map((g) => [g.name, g.artist, g.unknown, g.trackCount])).toEqual([
      ['Real', 'A', false, 1],
      ['Unknown Album', 'A', true, 2],
      ['Unknown Album', 'B', true, 1],
    ]);
  });

  it('reports the earliest year and the summed known duration', () => {
    const tracks = [t('1', { album: 'X', year: 2005, durationSeconds: 100 }), t('2', { album: 'X', year: 2003, durationSeconds: 50.5 }), t('3', { album: 'X' })];
    expect(groupTracks(tracks, 'album')[0]).toMatchObject({ year: 2003, durationSeconds: 150.5 });
    expect(groupTracks([t('1', { album: 'Y' })], 'album')[0]).toMatchObject({ year: undefined, durationSeconds: undefined });
  });

  it('lists an album\'s tracks by disc and track number', () => {
    const tracks = [t('b', { album: 'X', trackNumber: 2 }), t('a', { album: 'X', trackNumber: 1 }), t('c', { album: 'X', discNumber: 2, trackNumber: 1 })];
    const key = groupTracks(tracks, 'album')[0]?.key ?? '';
    expect(selectGroup(tracks, 'album', key)?.tracks.map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('genre grouping', () => {
  it('splits multi-valued genre text on commas and semicolons, once per genre per track', () => {
    expect(genreNamesOf(t('1', { genre: 'Rock, Pop; rock ,  ' }))).toEqual(['Rock', 'Pop']);
    expect(genreNamesOf(t('2', { genre: 'R&B/Soul' }))).toEqual(['R&B/Soul']);
    expect(genreNamesOf(t('3'))).toEqual([]);
  });

  it('lists a multi-genre track under each genre and counts it in each', () => {
    const tracks = [t('1', { genre: 'Rock, Pop' }), t('2', { genre: 'pop' }), t('3', { genre: 'Jazz' }), t('4'), t('5', { genre: '  ' })];
    const groups = groupTracks(tracks, 'genre');
    expect(groups.map((g) => [g.name, g.trackCount])).toEqual([
      ['Jazz', 1],
      ['Pop', 2],
      ['Rock', 1],
      ['Unknown Genre', 2],
    ]);
  });

  it('does not let a genre literally named "unknown genre" collide with the unknown group', () => {
    const groups = groupTracks([t('1', { genre: 'Unknown Genre' }), t('2')], 'genre');
    expect(groups).toHaveLength(1); // both are the single unknown group, by design
    expect(groups[0]?.trackCount).toBe(2);
  });
});

describe('determinism and selection', () => {
  const tracks = [
    t('1', { artist: 'B', album: 'Two', genre: 'Rock', title: 'z' }),
    t('2', { artist: 'A', album: 'One', genre: 'Rock', title: 'y' }),
    t('3', { artist: 'A', album: 'One', genre: 'Jazz', title: 'x' }),
    t('4', { artist: 'C', genre: 'Jazz' }),
  ];

  it('returns identical groups whatever the input order', () => {
    const shuffled = [tracks[3], tracks[1], tracks[0], tracks[2]] as GroupableTrack[];
    for (const kind of ['album', 'artist', 'genre'] as const) {
      expect(groupTracks(shuffled, kind)).toEqual(groupTracks(tracks, kind));
    }
  });

  it('selectGroup finds a group by its key, returns its tracks, and is undefined for an unknown key', () => {
    const jazz = groupTracks(tracks, 'genre').find((g) => g.name === 'Jazz');
    const selected = selectGroup(tracks, 'genre', jazz?.key ?? '');
    expect(selected?.group.trackCount).toBe(2);
    expect(selected?.tracks.map((x) => x.id)).toEqual(['3', '4']);
    expect(selectGroup(tracks, 'genre', 'n:nonexistent')).toBeUndefined();
    expect(selectGroup(tracks, 'artist', jazz?.key ?? '')).toBeUndefined();
  });

  it('orders an artist\'s tracks album by album, unknown album last', () => {
    const artistA = [t('1', { artist: 'A', album: 'Beta', title: 'a' }), t('2', { artist: 'A' }), t('3', { artist: 'A', album: 'Alpha', title: 'b' })];
    const key = groupTracks(artistA, 'artist')[0]?.key ?? '';
    expect(selectGroup(artistA, 'artist', key)?.tracks.map((x) => x.id)).toEqual(['3', '1', '2']);
  });

  it('has no groups for an empty library', () => {
    for (const kind of ['album', 'artist', 'genre'] as const) expect(groupTracks([], kind)).toEqual([]);
  });
});

describe('group cover track (Phase 11)', () => {
  const art = (kind: string) => ({ artwork: { kind } });
  const album = (tracks: GroupableTrack[]) => groupTracks(tracks, 'album')[0]?.coverTrackId;

  it('is the first track in natural order that has artwork', () => {
    const tracks = [
      t('3', { album: 'A', trackNumber: 3, ...art('embedded') }),
      t('1', { album: 'A', trackNumber: 1, ...art('none') }),
      t('2', { album: 'A', trackNumber: 2, ...art('embedded') }),
    ];
    expect(album(tracks)).toBe('2');
    expect(album([...tracks].reverse())).toBe('2'); // independent of input order
  });

  it('falls back to the first track in natural order when none has artwork (it may still have a folder cover)', () => {
    expect(album([t('2', { album: 'A', trackNumber: 2, ...art('none') }), t('1', { album: 'A', trackNumber: 1 })])).toBe('1');
  });

  it('counts external artwork as artwork and is a member of every group kind it describes', () => {
    const tracks = [t('1', { album: 'A', genre: 'Rock', trackNumber: 1, ...art('none') }), t('2', { album: 'A', genre: 'Rock', trackNumber: 2, ...art('external') })];
    for (const kind of ['album', 'artist', 'genre'] as const) {
      expect(groupTracks(tracks, kind)[0]?.coverTrackId).toBe('2');
    }
    expect(selectGroup(tracks, 'album', groupTracks(tracks, 'album')[0]!.key)?.group.coverTrackId).toBe('2');
  });

  it('each group has its own cover', () => {
    const tracks = [t('1', { album: 'A', ...art('embedded') }), t('2', { album: 'B', ...art('none') })];
    expect(groupTracks(tracks, 'album').map((g) => g.coverTrackId)).toEqual(['1', '2']);
  });
});
