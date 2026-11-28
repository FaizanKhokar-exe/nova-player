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
  it('removes combined and unusual clutter groups', () => {
    expect(suggestNames('Kesariya (Official Music Video HD)', 'Pritam').title).toBe('Kesariya');
    expect(suggestNames('Kesariya [Lyrics + Download]', 'Pritam').title).toBe('Kesariya');
    expect(suggestNames('Kesariya (Official Video) [HD] (320kbps)', 'Pritam').title).toBe('Kesariya');
    expect(suggestNames('Kesariya 【Official Video】', 'Pritam').title).toBe('Kesariya');
    expect(suggestNames('Yesterday (2009 Remaster)', 'The Beatles').title).toBe('Yesterday');
  });
  it('removes clutter after a dash or bar, file extensions, VEVO and bracketed track numbers', () => {
    expect(suggestNames('Kesariya - Official Video', 'Pritam').title).toBe('Kesariya');
    expect(suggestNames('Kesariya | Lyrics', 'Pritam').title).toBe('Kesariya');
    expect(suggestNames('Kesariya.mp3', 'Pritam').title).toBe('Kesariya');
    expect(suggestNames('[05] Kesariya', 'Pritam').title).toBe('Kesariya');
    expect(suggestNames('Kesariya', 'PritamVEVO').artist).toBe('Pritam');
  });
  it('keeps parts of a real name that merely look like clutter', () => {
    expect(suggestNames('Hotel California (1976)', 'Eagles').title).toBe('Hotel California (1976)');
    expect(suggestNames('Live and Let Die (Live)', 'Wings').title).toBe('Live and Let Die (Live)');
    expect(suggestNames('Clean Bandit - Rather Be', 'Clean Bandit').title).toBe('Rather Be');
    expect(suggestNames('New York (Acoustic)', 'Someone').title).toBe('New York (Acoustic)');
    expect(suggestNames('Audio Bullys', 'Someone').title).toBe('Audio Bullys');
  });
  it('is idempotent: tidying a tidied name changes nothing', () => {
    const once = suggestNames('01 - Atif Aslam - Tera Hone Laga Hoon (Official Video) [320kbps] www.songspk.com', 'Unknown Artist');
    expect(suggestNames(once.title, once.artist).changed).toBe(false);
  });
});
