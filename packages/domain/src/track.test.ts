import { describe, expect, it } from 'vitest';
import { createTrack, type RawTrackMetadata } from './track.js';
import { createTrackId } from './track-id.js';

function raw(overrides: RawTrackMetadata = {}): RawTrackMetadata {
  return overrides;
}

describe('createTrack - normal metadata', () => {
  it('uses tag values directly when present and clean', () => {
    const id = createTrackId();
    const track = createTrack({
      id,
      sourcePath: '/music/Daft Punk/Discovery/01 One More Time.mp3',
      raw: raw({
        title: 'One More Time',
        artist: 'Daft Punk',
        album: 'Discovery',
        albumArtist: 'Daft Punk',
        genre: 'Electronic',
        trackNumber: 1,
        discNumber: 1,
        year: 2001,
        durationSeconds: 320.5,
      }),
    });

    expect(track.id).toBe(id);
    expect(track.title).toBe('One More Time');
    expect(track.titleSource).toBe('tag');
    expect(track.artist).toBe('Daft Punk');
    expect(track.artistSource).toBe('tag');
    expect(track.album).toBe('Discovery');
    expect(track.albumArtist).toBe('Daft Punk');
    expect(track.genre).toBe('Electronic');
    expect(track.trackNumber).toBe(1);
    expect(track.discNumber).toBe(1);
    expect(track.year).toBe(2001);
    expect(track.durationSeconds).toBe(320.5);
    expect(track.artwork).toEqual({ kind: 'none' });
  });

  it('preserves capitalization in display fields (never lowercases)', () => {
    const track = createTrack({
      id: createTrackId(),
      sourcePath: '/music/MGMT/track.mp3',
      raw: raw({ title: 'Kids', artist: 'MGMT' }),
    });

    expect(track.title).toBe('Kids');
    expect(track.artist).toBe('MGMT');
  });

  it('reports embedded artwork when the tag reader found it', () => {
    const track = createTrack({
      id: createTrackId(),
      sourcePath: '/music/track.mp3',
      raw: raw({ title: 'Title', artist: 'Artist', hasEmbeddedArtwork: true }),
    });

    expect(track.artwork).toEqual({ kind: 'embedded' });
  });

  it('reports external artwork when given an external artwork path', () => {
    const track = createTrack({
      id: createTrackId(),
      sourcePath: '/music/track.mp3',
      raw: raw({ title: 'Title', artist: 'Artist', externalArtworkPath: '/music/cover.jpg' }),
    });

    expect(track.artwork).toEqual({ kind: 'external', path: '/music/cover.jpg' });
  });
});

describe('createTrack - missing title', () => {
  it('falls back to a filename-derived title when the tag has none', () => {
    const track = createTrack({
      id: createTrackId(),
      sourcePath: '/music/Daft Punk - One More Time.mp3',
      raw: raw({}),
    });

    expect(track.title).toBe('One More Time');
    expect(track.titleSource).toBe('filename');
  });

  it('falls back to a filename-derived title when the tag title is only whitespace', () => {
    const track = createTrack({
      id: createTrackId(),
      sourcePath: '/music/Interstellar Theme.mp3',
      raw: raw({ title: '   ' }),
    });

    expect(track.title).toBe('Interstellar Theme');
    expect(track.titleSource).toBe('filename');
  });

  it('falls back to the fixed constant when neither a tag nor a usable filename exists', () => {
    const track = createTrack({
      id: createTrackId(),
      sourcePath: '',
      raw: raw({}),
    });

    expect(track.title).toBe('Untitled Track');
    expect(track.titleSource).toBe('unknown');
  });
});

describe('createTrack - missing artist', () => {
  it('falls back to a filename-derived artist when the tag has none', () => {
    const track = createTrack({
      id: createTrackId(),
      sourcePath: '/music/Daft Punk - One More Time.mp3',
      raw: raw({ title: 'One More Time' }),
    });

    expect(track.artist).toBe('Daft Punk');
    expect(track.artistSource).toBe('filename');
  });

  it('falls back to "Unknown Artist" when no tag and no filename-derivable artist exist', () => {
    const track = createTrack({
      id: createTrackId(),
      sourcePath: '/music/One More Time.mp3',
      raw: raw({ title: 'One More Time' }),
    });

    expect(track.artist).toBe('Unknown Artist');
    expect(track.artistSource).toBe('unknown');
  });
});

describe('createTrack - missing album/genre (deliberately left undefined, not synthesized)', () => {
  it('leaves album undefined when the tag has none', () => {
    const track = createTrack({
      id: createTrackId(),
      sourcePath: '/music/track.mp3',
      raw: raw({ title: 'Title', artist: 'Artist' }),
    });

    expect(track.album).toBeUndefined();
    expect(track.albumArtist).toBeUndefined();
    expect(track.genre).toBeUndefined();
  });

  it('treats a whitespace-only album tag as absent', () => {
    const track = createTrack({
      id: createTrackId(),
      sourcePath: '/music/track.mp3',
      raw: raw({ title: 'Title', artist: 'Artist', album: '   ' }),
    });

    expect(track.album).toBeUndefined();
  });
});

describe('createTrack - whitespace normalization', () => {
  it('trims and collapses whitespace in tag values', () => {
    const track = createTrack({
      id: createTrackId(),
      sourcePath: '/music/track.mp3',
      raw: raw({ title: '  One   More   Time  ', artist: '  Daft   Punk  ' }),
    });

    expect(track.title).toBe('One More Time');
    expect(track.artist).toBe('Daft Punk');
  });
});

describe('createTrack - filename fallback edge cases', () => {
  it('does not destroy a legitimate hyphenated title when falling back', () => {
    const track = createTrack({
      id: createTrackId(),
      sourcePath: '/music/Anti-Hero.mp3',
      raw: raw({}),
    });

    expect(track.title).toBe('Anti-Hero');
    expect(track.artist).toBe('Unknown Artist');
  });

  it('cleans a known junk token from a filename-derived title', () => {
    const track = createTrack({
      id: createTrackId(),
      sourcePath: '/music/Some Song [Official Video].mp3',
      raw: raw({}),
    });

    expect(track.title).toBe('Some Song');
  });
});

describe('createTrack - validation / sanitization of numeric fields', () => {
  it('drops a negative duration rather than storing it', () => {
    const track = createTrack({
      id: createTrackId(),
      sourcePath: '/music/track.mp3',
      raw: raw({ title: 'Title', artist: 'Artist', durationSeconds: -5 }),
    });

    expect(track.durationSeconds).toBeUndefined();
  });

  it('drops a non-finite duration', () => {
    const track = createTrack({
      id: createTrackId(),
      sourcePath: '/music/track.mp3',
      raw: raw({ title: 'Title', artist: 'Artist', durationSeconds: Number.NaN }),
    });

    expect(track.durationSeconds).toBeUndefined();
  });

  it('accepts a zero duration as valid (an edge case, not an error)', () => {
    const track = createTrack({
      id: createTrackId(),
      sourcePath: '/music/track.mp3',
      raw: raw({ title: 'Title', artist: 'Artist', durationSeconds: 0 }),
    });

    expect(track.durationSeconds).toBe(0);
  });

  it('drops a non-positive track number', () => {
    const track = createTrack({
      id: createTrackId(),
      sourcePath: '/music/track.mp3',
      raw: raw({ title: 'Title', artist: 'Artist', trackNumber: 0 }),
    });

    expect(track.trackNumber).toBeUndefined();
  });

  it('drops a non-integer track number', () => {
    const track = createTrack({
      id: createTrackId(),
      sourcePath: '/music/track.mp3',
      raw: raw({ title: 'Title', artist: 'Artist', trackNumber: 1.5 }),
    });

    expect(track.trackNumber).toBeUndefined();
  });

  it('drops an implausible year', () => {
    const track = createTrack({
      id: createTrackId(),
      sourcePath: '/music/track.mp3',
      raw: raw({ title: 'Title', artist: 'Artist', year: 30000 }),
    });

    expect(track.year).toBeUndefined();
  });

  it('accepts a plausible year', () => {
    const track = createTrack({
      id: createTrackId(),
      sourcePath: '/music/track.mp3',
      raw: raw({ title: 'Title', artist: 'Artist', year: 1977 }),
    });

    expect(track.year).toBe(1977);
  });
});

describe('createTrack - determinism', () => {
  it('produces identical output for identical input', () => {
    const id = createTrackId();
    const input = {
      id,
      sourcePath: '/music/Daft Punk - One More Time.mp3',
      raw: raw({ album: 'Discovery' }),
    };

    expect(createTrack(input)).toEqual(createTrack(input));
  });
});
