import { describe, expect, it } from 'vitest';
import { suggestNames } from './name-clean.js';

describe('suggestNames', () => {
  it('removes track numbers, site names, quality tags and "official video" clutter', () => {
    expect(suggestNames('01 - 8 ASLE (Official Video) [320kbps] www.songspk.com', 'Sukha')).toEqual({ title: '8 ASLE', artist: 'Sukha', changed: true });
    expect(suggestNames('Tum_Hi_Ho_(HD)', 'Arijit Singh').title).toBe('Tum Hi Ho');
    expect(suggestNames('12. Kesariya [Official Audio]', 'Pritam').title).toBe('Kesariya');
  });
  it('keeps things that are part of the name', () => {
    expect(suggestNames('Blinding Lights (feat. The Weeknd) (Remix)', 'Someone')).toMatchObject({ title: 'Blinding Lights (feat. The Weeknd) (Remix)', changed: false });
    expect(suggestNames('Hello', 'Adele').changed).toBe(false);
    expect(suggestNames('2 Become 1', 'Spice Girls').title).toBe('2 Become 1');
  });
  it('splits "Artist - Title" when the artist is unknown, and drops a repeated artist', () => {
    expect(suggestNames('Atif Aslam - Tera Hone Laga Hoon', 'Unknown Artist')).toMatchObject({ title: 'Tera Hone Laga Hoon', artist: 'Atif Aslam' });
    expect(suggestNames('Atif Aslam - Tera Hone Laga Hoon', 'Atif Aslam')).toMatchObject({ title: 'Tera Hone Laga Hoon', artist: 'Atif Aslam' });
  });
  it('removes "- Topic" from channel-style artists and never returns an empty title', () => {
    expect(suggestNames('Song', 'Some Artist - Topic').artist).toBe('Some Artist');
    expect(suggestNames('(Official Video)', 'X').title).toBe('(Official Video)');
  });
  it('works for Urdu and other scripts', () => {
    expect(suggestNames('03 - دل دل پاکستان (HD)', 'جنید جمشید').title).toBe('دل دل پاکستان');
  });
});
