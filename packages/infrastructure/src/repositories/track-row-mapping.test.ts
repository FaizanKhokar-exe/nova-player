import { computeDeduplicationKey, TrackRepositoryError } from '@nova/domain';
import { describe, expect, it } from 'vitest';
import { makeFullTrack, makeTrack } from './test-tracks.js';

const exactKey = (sourcePath: string): string => sourcePath;
import { rowToTrack, trackToRowParams, type TrackRow } from './track-row-mapping.js';

function validRow(overrides: Partial<TrackRow> = {}): TrackRow {
  return { ...trackToRowParams({ track: makeTrack(), sizeBytes: 100 }, exactKey), ...overrides };
}

function expectCorrupt(fn: () => unknown): void {
  try {
    fn();
    expect.unreachable('should have thrown');
  } catch (error) {
    expect(error).toBeInstanceOf(TrackRepositoryError);
    expect((error as TrackRepositoryError).code).toBe('corrupt-record');
  }
}

describe('trackToRowParams', () => {
  it('maps every field of a fully populated track to its snake_case column', () => {
    const track = makeFullTrack();
    expect(trackToRowParams({ track, sizeBytes: 1234 }, exactKey)).toEqual({
      id: track.id,
      source_path: track.sourcePath,
      source_path_key: track.sourcePath,
      title: track.title,
      title_source: 'tag',
      artist: track.artist,
      artist_source: 'tag',
      album: 'The Album',
      album_artist: 'Various Artists',
      genre: 'Rock',
      track_number: 7,
      disc_number: 2,
      year: 1999,
      duration_seconds: 215.123456789, // seconds in, seconds out: no unit conversion
      artwork_kind: 'external',
      artwork_path: 'C:\\Music\\cover.jpg',
      size_bytes: 1234,
      dedup_key: computeDeduplicationKey({ title: track.title, artist: track.artist, sizeBytes: 1234 }),
      modified_at_ms: 0, // not supplied -> unknown
    });
  });

  it('turns every absent optional field into null', () => {
    const params = trackToRowParams({
      track: makeTrack({
        album: undefined, albumArtist: undefined, genre: undefined,
        trackNumber: undefined, discNumber: undefined, year: undefined, durationSeconds: undefined,
      }),
      sizeBytes: 1,
    }, exactKey);
    for (const column of ['album', 'album_artist', 'genre', 'track_number', 'disc_number', 'year', 'duration_seconds'] as const) {
      expect(params[column]).toBeNull();
    }
  });

  it('keeps a zero duration as 0, not null', () => {
    expect(trackToRowParams({ track: makeTrack({ durationSeconds: 0 }), sizeBytes: 1 }, exactKey).duration_seconds).toBe(0);
  });

  it.each([
    [{ kind: 'none' } as const, 'none', null],
    [{ kind: 'embedded' } as const, 'embedded', null],
    [{ kind: 'external', path: 'D:\\art.png' } as const, 'external', 'D:\\art.png'],
  ])('maps artwork %j', (artwork, kind, path) => {
    const params = trackToRowParams({ track: makeTrack({ artwork }), sizeBytes: 1 }, exactKey);
    expect(params.artwork_kind).toBe(kind);
    expect(params.artwork_path).toBe(path);
  });

  it('computes dedup_key with the domain function, from title + artist + size', () => {
    const track = makeTrack({ title: 'Hello  World', artist: 'THE Band' });
    expect(trackToRowParams({ track, sizeBytes: 999 }, exactKey).dedup_key).toBe(
      computeDeduplicationKey({ title: 'Hello  World', artist: 'THE Band', sizeBytes: 999 }),
    );
  });
});

describe('rowToTrack', () => {
  it('round-trips a full track exactly', () => {
    const track = makeFullTrack();
    expect(rowToTrack(trackToRowParams({ track, sizeBytes: 5 }, exactKey))).toEqual(track);
  });

  it('round-trips each artwork kind', () => {
    for (const artwork of [{ kind: 'none' }, { kind: 'embedded' }, { kind: 'external', path: 'x.jpg' }] as const) {
      const track = makeTrack({ artwork });
      expect(rowToTrack(trackToRowParams({ track, sizeBytes: 5 }, exactKey)).artwork).toEqual(artwork);
    }
  });

  it('turns NULL columns into undefined (present as keys, per the Track shape)', () => {
    const track = rowToTrack(
      validRow({ album: null, album_artist: null, genre: null, track_number: null, disc_number: null, year: null, duration_seconds: null }),
    );
    expect(track.album).toBeUndefined();
    expect(track.trackNumber).toBeUndefined();
    expect(track.durationSeconds).toBeUndefined();
    expect('album' in track).toBe(true);
  });

  it('produces a branded TrackId that is the same string as stored', () => {
    const row = validRow();
    expect(rowToTrack(row).id).toBe(row.id);
  });

  it('rejects a corrupt id', () => expectCorrupt(() => rowToTrack(validRow({ id: 'not-a-track-id' }))));
  it('rejects an unknown title_source', () => expectCorrupt(() => rowToTrack(validRow({ title_source: 'guess' }))));
  it('rejects an unknown artist_source', () => expectCorrupt(() => rowToTrack(validRow({ artist_source: 'guess' }))));
  it('rejects an unknown artwork_kind', () => expectCorrupt(() => rowToTrack(validRow({ artwork_kind: 'remote' }))));
  it('rejects external artwork without a path', () =>
    expectCorrupt(() => rowToTrack(validRow({ artwork_kind: 'external', artwork_path: null }))));
});
