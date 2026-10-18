/**
 * Phase 6: per-track lyrics and artwork. Plain serializable data, no runtime imports, no file
 * paths: the renderer names a track by its id and gets parsed lyrics / an image back.
 */

export interface TrackRefRequest {
  readonly trackId: string;
}

export interface LyricLineDto {
  /** Canonical integer milliseconds, with the file's `[offset:]` already applied (the Phase 1D rule). */
  readonly timeMs: number;
  readonly text: string;
}

/**
 *  - `found`: a sidecar with at least one timed line
 *  - `empty`: a sidecar was read but holds no timed lines
 *  - `none`: no sidecar next to the track
 *  - `unavailable`: the track's file or folder cannot be reached right now
 *  - `unreadable`: a sidecar exists but could not be read (too large, no permission)
 * None of these is an error for playback; the UI shows each plainly.
 */
export type LyricsStatusDto = 'found' | 'empty' | 'none' | 'unavailable' | 'unreadable';

export interface LyricsDto {
  readonly status: LyricsStatusDto;
  /** Empty unless `status` is `found`. */
  readonly lines: readonly LyricLineDto[];
  /** `true` only when the listener attached these lyrics by hand (they can be detached again); absent otherwise. */
  readonly attached?: true;
}

/**
 * What came of `track:attachLyrics` (main shows the file dialog; the renderer never names a path):
 *  - `attached`: the chosen file had timed lines and is now this track's lyrics (`lyrics` is the new answer)
 *  - `cancelled`: the listener closed the dialog
 *  - `empty`: the file was readable but has no timed lines, so nothing was attached
 *  - `unreadable` / `too-large`: the file could not be read / is over the 1 MiB limit
 *  - `unavailable`: the track's folder cannot be reached right now
 */
export type AttachLyricsResultDto =
  | { readonly outcome: 'attached'; readonly lyrics: LyricsDto }
  | { readonly outcome: 'cancelled' | 'empty' | 'unreadable' | 'too-large' | 'unavailable' };

export interface DetachLyricsResultDto {
  /** `true` when attached lyrics existed and were removed. */
  readonly removed: boolean;
}

export type ArtworkStatusDto = 'found' | 'none' | 'unavailable';

export interface ArtworkDto {
  readonly status: ArtworkStatusDto;
  /** `found` only: a `data:image/...;base64,...` URL (the image bytes never touch a file path). */
  readonly dataUrl?: string;
}
