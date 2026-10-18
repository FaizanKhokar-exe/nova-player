import { describe, expect, it } from 'vitest';
import { DEFAULT_TRACK_SORT, isSortDirection, isTrackSortField, sortTracks, sortTracksInAlbumOrder, type SortableTrack, type TrackSort } from './track-sorting.js';

function t(id: string, title: string, extra: Partial<SortableTrack> = {}): SortableTrack {
  return { id, title, artist: 'Artist', ...extra };
}

const ids = (tracks: readonly SortableTrack[]): string[] => tracks.map((track) => track.id);

describe('sortTracks', () => {
  it('sorts by title case-insensitively and ignores extra whitespace', () => {
    const sorted = sortTracks([t('1', 'banana'), t('2', '  Apple '), t('3', 'cherry'), t('4', 'Banana  Split')]);
    expect(ids(sorted)).toEqual(['2', '1', '4', '3']);
  });

  it('uses code-unit order, not the locale (stable on every machine)', () => {
    // 'é' (U+00E9) sorts after 'z' in code-unit order; a locale sort would put it before.
    expect(ids(sortTracks([t('1', 'éclair'), t('2', 'zebra'), t('3', 'apple')]))).toEqual(['3', '2', '1']);
  });

  it('supports every documented field in both directions', () => {
    const tracks = [
      t('a', 'A', { artist: 'Zed', album: 'Y', albumArtist: 'M', genre: 'Rock', year: 2001, durationSeconds: 100 }),
      t('b', 'B', { artist: 'Amy', album: 'X', albumArtist: 'N', genre: 'Jazz', year: 1999, durationSeconds: 300 }),
      t('c', 'C', { artist: 'Moe', album: 'Z', albumArtist: 'L', genre: 'Pop', year: 2010, durationSeconds: 200 }),
    ];
    const expected: Record<TrackSort['field'], string[]> = {
      title: ['a', 'b', 'c'],
      artist: ['b', 'c', 'a'],
      album: ['b', 'a', 'c'],
      albumArtist: ['c', 'a', 'b'],
      genre: ['b', 'c', 'a'],
      year: ['b', 'a', 'c'],
      duration: ['a', 'c', 'b'],
    };
    for (const [field, asc] of Object.entries(expected) as [TrackSort['field'], string[]][]) {
      expect(ids(sortTracks(tracks, { field, direction: 'asc' })), `${field} asc`).toEqual(asc);
      expect(ids(sortTracks(tracks, { field, direction: 'desc' })), `${field} desc`).toEqual([...asc].reverse());
    }
  });

  it('puts missing values last in BOTH directions', () => {
    const tracks = [
      t('none', 'N'),
      t('blank', 'B', { album: '   ', genre: '', year: Number.NaN }),
      t('x', 'X', { album: 'Alpha', genre: 'Rock', year: 2000, durationSeconds: 10 }),
      t('y', 'Y', { album: 'Beta', genre: 'Jazz', year: 1990, durationSeconds: 20 }),
    ];
    for (const field of ['album', 'genre', 'year', 'duration'] as const) {
      for (const direction of ['asc', 'desc'] as const) {
        const result = ids(sortTracks(tracks, { field, direction }));
        expect(result.slice(0, 2), `${field} ${direction}`).toEqual(expect.arrayContaining(['x', 'y']));
        // the two missing ones are the last two, and in the same (tie-break) order either way
        expect(result.slice(2), `${field} ${direction}`).toEqual(['blank', 'none']);
      }
    }
  });

  it('keeps tie-breaks ascending when the direction flips', () => {
    const tracks = [t('1', 'Same', { artist: 'B', year: 2000 }), t('2', 'Same', { artist: 'A', year: 2000 }), t('3', 'Old', { year: 1990 })];
    expect(ids(sortTracks(tracks, { field: 'year', direction: 'asc' }))).toEqual(['3', '2', '1']);
    expect(ids(sortTracks(tracks, { field: 'year', direction: 'desc' }))).toEqual(['2', '1', '3']);
  });

  it('is deterministic whatever order the input arrives in (ends on the TrackId)', () => {
    const base = [t('c', 'Same'), t('a', 'Same'), t('b', 'Same')];
    const expected = ['a', 'b', 'c'];
    expect(ids(sortTracks(base))).toEqual(expected);
    expect(ids(sortTracks([...base].reverse()))).toEqual(expected);
    expect(ids(sortTracks([base[1] as SortableTrack, base[2] as SortableTrack, base[0] as SortableTrack]))).toEqual(expected);
  });

  it('orders an album by disc, then track number, then title (unnumbered last)', () => {
    const tracks = [
      t('d2t1', 'Zed', { discNumber: 2, trackNumber: 1 }),
      t('d1t2', 'B', { discNumber: 1, trackNumber: 2 }),
      t('d1t1', 'Y', { discNumber: 1, trackNumber: 1 }),
      t('un-b', 'B untitled'),
      t('un-a', 'A untitled'),
    ];
    expect(ids(sortTracks(tracks, { field: 'album', direction: 'asc' }))).toEqual(['d1t1', 'd1t2', 'd2t1', 'un-a', 'un-b']);
    expect(ids(sortTracksInAlbumOrder(tracks))).toEqual(['d1t1', 'd1t2', 'd2t1', 'un-a', 'un-b']);
  });

  it('treats a numbered track with no disc tag as disc 1', () => {
    const tracks = [t('d2', 'A', { discNumber: 2, trackNumber: 1 }), t('nodisc-2', 'B', { trackNumber: 2 }), t('nodisc-1', 'C', { trackNumber: 1 })];
    expect(ids(sortTracksInAlbumOrder(tracks))).toEqual(['nodisc-1', 'nodisc-2', 'd2']);
  });

  it('does not modify its input and the default is title ascending', () => {
    const input = [t('2', 'b'), t('1', 'a')];
    const copy = [...input];
    const out = sortTracks(input);
    expect(input).toEqual(copy);
    expect(out).not.toBe(input);
    expect(DEFAULT_TRACK_SORT).toEqual({ field: 'title', direction: 'asc' });
  });

  it('validates field and direction names', () => {
    expect(isTrackSortField('albumArtist')).toBe(true);
    expect(isTrackSortField('path')).toBe(false);
    expect(isTrackSortField(undefined)).toBe(false);
    expect(isSortDirection('desc')).toBe(true);
    expect(isSortDirection('DESC')).toBe(false);
  });
});
