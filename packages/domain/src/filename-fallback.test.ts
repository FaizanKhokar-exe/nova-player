import { describe, expect, it } from 'vitest';
import {
  extractFileNameWithoutExtension,
  stripJunkBracketGroups,
  parseArtistTitleFromFileName,
} from './filename-fallback.js';

describe('extractFileNameWithoutExtension', () => {
  it('strips a simple extension', () => {
    expect(extractFileNameWithoutExtension('song.mp3')).toBe('song');
  });

  it('takes only the last path segment (POSIX separators)', () => {
    expect(extractFileNameWithoutExtension('/music/Artist/Album/song.flac')).toBe('song');
  });

  it('takes only the last path segment (Windows separators)', () => {
    expect(extractFileNameWithoutExtension('C:\\music\\Artist\\song.wav')).toBe('song');
  });

  it('preserves a filename with a single leading dot and no other dot (dotfile-like)', () => {
    expect(extractFileNameWithoutExtension('.hidden')).toBe('.hidden');
  });

  it('does not truncate a filename ending in a bare trailing dot', () => {
    expect(extractFileNameWithoutExtension('track.')).toBe('track.');
  });

  it('only strips the final extension when a filename has multiple dots', () => {
    expect(extractFileNameWithoutExtension('Artist - Title (2011 Remaster).mp3')).toBe(
      'Artist - Title (2011 Remaster)',
    );
  });
});

describe('stripJunkBracketGroups', () => {
  it('removes an exact known junk phrase in brackets', () => {
    expect(stripJunkBracketGroups('Song Name [Official Video]')).toBe('Song Name  ');
  });

  it('removes an exact known junk phrase in parentheses, case-insensitively', () => {
    expect(stripJunkBracketGroups('Song Name (OFFICIAL AUDIO)')).toBe('Song Name  ');
  });

  it('removes a bitrate tag', () => {
    expect(stripJunkBracketGroups('Song Name [320kbps]')).toBe('Song Name  ');
  });

  it('does NOT remove a remix credit, since it is not an exact known junk phrase', () => {
    expect(stripJunkBracketGroups('Song Name (Radio Remix)')).toBe('Song Name (Radio Remix)');
  });

  it('does NOT remove a featured-artist credit', () => {
    expect(stripJunkBracketGroups('Song Name (feat. Drake)')).toBe('Song Name (feat. Drake)');
  });

  it('does NOT remove a legitimate live-venue note', () => {
    expect(stripJunkBracketGroups('Song Name (Live at Wembley)')).toBe(
      'Song Name (Live at Wembley)',
    );
  });

  it('does NOT remove a year in parentheses', () => {
    expect(stripJunkBracketGroups('Song Name (2011)')).toBe('Song Name (2011)');
  });

  it('recognizes a known junk phrase even with sloppy internal whitespace (Phase 1E consistency fix)', () => {
    expect(stripJunkBracketGroups('Song Name [ Official   Video ]')).toBe('Song Name  ');
  });
});

describe('parseArtistTitleFromFileName', () => {
  it('splits the common "Artist - Title" pattern', () => {
    expect(parseArtistTitleFromFileName('Daft Punk - One More Time')).toEqual({
      title: 'One More Time',
      artist: 'Daft Punk',
    });
  });

  it('does not split a title containing a legitimate unspaced hyphen', () => {
    expect(parseArtistTitleFromFileName('Anti-Hero')).toEqual({
      title: 'Anti-Hero',
      artist: undefined,
    });
  });

  it('does not split "T-Shirt"-style compound words', () => {
    expect(parseArtistTitleFromFileName('T-Shirt')).toEqual({
      title: 'T-Shirt',
      artist: undefined,
    });
  });

  it('does not split when a hyphen has a space on only one side', () => {
    expect(parseArtistTitleFromFileName('Spider-Man Theme')).toEqual({
      title: 'Spider-Man Theme',
      artist: undefined,
    });
  });

  it('cleans a known junk token before splitting', () => {
    expect(parseArtistTitleFromFileName('Daft Punk - One More Time [Official Video]')).toEqual({
      title: 'One More Time',
      artist: 'Daft Punk',
    });
  });

  it('falls back to the whole cleaned string when the split would leave an empty side', () => {
    expect(parseArtistTitleFromFileName(' - Interlude')).toEqual({
      title: '- Interlude',
      artist: undefined,
    });
  });

  it('normalizes repeated whitespace around the separator', () => {
    expect(parseArtistTitleFromFileName('Daft Punk   -   One More Time')).toEqual({
      title: 'One More Time',
      artist: 'Daft Punk',
    });
  });

  it('only splits on the first separator, keeping a legitimate second " - " in the title', () => {
    expect(parseArtistTitleFromFileName('Daft Punk - One More Time - Live')).toEqual({
      title: 'One More Time - Live',
      artist: 'Daft Punk',
    });
  });
});
