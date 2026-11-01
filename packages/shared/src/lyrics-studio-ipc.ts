/**
 * v0.12.0 "Lyric Studio": finding lyrics text for a song that has none, and saving a timed `.lrc` for it.
 * Plain serializable data, no runtime imports, no file locations: the renderer names a track by id and
 * receives text; main decides where (and whether) anything is written.
 */

export interface LyricsSearchRequest {
  readonly trackId: string;
  /** Optional override of what to look for (the listener may correct a wrong tag). At most 200 characters each. */
  readonly title?: string;
  readonly artist?: string;
}

export interface LyricsCandidateDto {
  /** The provider's own id, only used as a stable list key. */
  readonly id: number;
  readonly title: string;
  readonly artist: string;
  readonly album: string;
  /** Seconds, when the provider knows it. */
  readonly durationSec?: number;
  readonly instrumental: boolean;
  /** Unsynced words (may be empty when only `synced` exists). */
  readonly plain: string;
  /** Ready-made timed lines, when the provider has them (already parsed by main with the app's one `.lrc` parser). */
  readonly syncedLines?: readonly { readonly timeMs: number; readonly text: string }[];
  /** 0..1 - how well title, artist and length agree with the track. Only for ordering and the badge. */
  readonly match: number;
}

/**
 *  - `ok`: the provider answered (`candidates` may still be empty)
 *  - `offline`: the provider could not be reached
 *  - `error`: it answered with something unusable
 *  - `unavailable`: online lookup is not available in this build
 */
export interface LyricsSearchResultDto {
  readonly status: 'ok' | 'offline' | 'error' | 'unavailable';
  /** What was actually searched for (the tags, or the override). */
  readonly title: string;
  readonly artist: string;
  readonly candidates: readonly LyricsCandidateDto[];
}

export interface SaveLyricsRequest {
  readonly trackId: string;
  /** The finished timed `.lrc` text (at most 1 MiB). */
  readonly lrc: string;
}

/**
 *  - `saved-beside`: written next to the song as `<song>.lrc` and stored in the app
 *  - `saved-in-app`: the folder could not be written, so it is stored in the app only
 *  - `invalid`: the text holds no timed line
 *  - `too-large`: over 1 MiB
 *  - `unavailable`: the track cannot be reached right now
 */
export interface SaveLyricsResultDto {
  readonly outcome: 'saved-beside' | 'saved-in-app' | 'invalid' | 'too-large' | 'unavailable';
}
