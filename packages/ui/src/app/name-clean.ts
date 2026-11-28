/**
 * Tidies the names of songs that came with download-site clutter: "01 - Artist - Title (Official Video) [320kbps] www.site.com".
 * Pure text rules, nothing is guessed from the network. It only REMOVES clutter (and splits "Artist - Title" when the artist is
 * missing), so (feat. X), (Remix), (Live) and the like stay.
 */

const JUNK_WORDS = [
  'official music video', 'official video', 'official audio', 'official lyric video', 'official lyrics video', 'official visualizer', 'official visualiser',
  'music video', 'lyric video', 'lyrics video', 'lyrics', 'lyric', 'audio', 'video', 'visualizer', 'visualiser', 'hd', 'hq', '4k', '1080p', '720p', 'full song', 'full audio', 'full video',
  'free download', 'download', 'new song', 'new', 'out now', 'explicit', 'clean', 'remastered', 'high quality',
];
const JUNK_TOKENS = new Set(
  JUNK_WORDS.flatMap((word) => word.split(' ')).concat(['official', 'with', 'and', 'by', 'full', 'mp3', 'song', 'songs', 'version', 'ost', 'sub', 'subtitles', 'english', 'eng', 'only', 'on', 'youtube', 'vevo', 'topic']),
);
/** "320kbps", "1080p", "2011 remaster", "44.1khz", "24bit" - quality and remaster stamps. */
const STAMP = /^(?:\d{2,3}k(?:bps)?|\d{3,4}p|\d{4}|\d+(?:\.\d+)?\s?khz|\d{2}\s?bit|remaster(?:ed)?|\+)$/i;
/** A bracket group is clutter when EVERY word in it is clutter ("Official Music Video HD", "Lyrics + Download", "320kbps"). */
function isJunkGroup(inner: string): boolean {
  const words = inner.toLowerCase().split(/[\s,+&/|._-]+/).filter((word) => word !== '');
  if (words.length === 0) return true; // "()" and "[]"
  const known = (word: string): boolean => JUNK_TOKENS.has(word) || STAMP.test(word);
  // a bare year is a real part of a name ("(1999)"); "(2011 Remaster)" is clutter
  if (words.length === 1 && /^\d{4}$/.test(words[0] as string)) return false;
  return words.every(known) && words.some((word) => JUNK_TOKENS.has(word) || /k(?:bps)?$|p$|khz$|bit$|remaster/.test(word));
}
const GROUP = /\s*[[(【]([^\])】[(]*)[\])】]/g;
/** "Song - Official Video", "Song | Lyrics", "Song – HD" left over after brackets. */
const TRAILING_TAG = new RegExp(`\\s*[-–—|:]\\s*(?:(?:${JUNK_WORDS.map((w) => w.replace(/ /g, '\\s+')).join('|')}|official)\\s*)+$`, 'i');
const EXTENSION = /\.(?:mp3|flac|m4a|wav|ogg|opus|aac|wma|mp4)$/i;
const VEVO = /(?<=[a-z0-9])\s*vevo$/i;
const SITE = /\s*[-–—|]?\s*\b(?:www\.)?[a-z0-9][a-z0-9-]*\.(?:com|net|org|pk|in|co|info|me|fm|mp3|xyz|site|link)\b\/?\S*/gi;
const TRACK_NUMBER = /^\s*(?:[[(]\d{1,3}[\])]\s*[-._]?\s*|\d{1,3}\s*[-._)]\s*|\d{1,3}\s{2,})/;
const UNKNOWN = /^(?:unknown(?:\s+artist)?|various(?:\s+artists)?|<unknown>|n\/a|none|-|)$/i;

function tidy(text: string): string {
  return text
    .replace(EXTENSION, '')
    .replace(/_/g, ' ')
    .replace(SITE, '')
    .replace(GROUP, (whole, inner: string) => (isJunkGroup(inner) ? '' : whole))
    .replace(TRAILING_TAG, '')
    .replace(/\s*[-–—]\s*topic\s*$/i, '')
    .replace(VEVO, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—.,:;|]+|[\s\-–—|]+$/g, '')
    .trim();
}

export interface NameSuggestion {
  readonly title: string;
  readonly artist: string;
  /** True when the suggestion differs from what was given. */
  readonly changed: boolean;
}

export function suggestNames(title: string, artist: string): NameSuggestion {
  let t = tidy(title.replace(TRACK_NUMBER, ''));
  let a = tidy(artist);
  if (UNKNOWN.test(a)) a = '';
  // "Artist - Title" in the title with no artist known: split it.
  if (a === '') {
    const parts = t.split(/\s+[-–—]\s+/);
    if (parts.length === 2 && parts[0] !== '' && parts[1] !== '') {
      a = tidy(parts[0] as string);
      t = tidy(parts[1] as string);
    }
  } else {
    // "Artist - Title" where the title repeats the artist at its start: drop the repeat.
    const lead = `${a} - `.toLowerCase();
    const dash = t.toLowerCase().startsWith(lead) ? lead.length : -1;
    if (dash > 0 && t.length > dash) t = tidy(t.slice(dash));
  }
  const finalTitle = t === '' ? title.trim() : t;
  const finalArtist = a === '' ? artist.trim() : a;
  return { title: finalTitle, artist: finalArtist, changed: finalTitle !== title.trim() || finalArtist !== artist.trim() };
}

/** Does the name look like it still carries download clutter or a file-name shape (so the dialog can offer to tidy it)? */
export function looksUntidy(title: string, artist: string): boolean {
  return suggestNames(title, artist).changed;
}
