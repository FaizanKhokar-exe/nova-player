/**
 * v0.15.0: correcting a song's name, artist and album by hand. The file is never touched: main keeps the correction in
 * its own database and lays it over the tags (so a rescan cannot undo it, and "reset" brings the tags back).
 */
export interface EditTrackInfoRequest {
  readonly trackId: string;
  readonly title: string;
  readonly artist: string;
  /** Empty or absent = no album. */
  readonly album?: string;
}

export interface EditTrackInfoResultDto {
  /** `invalid`: the title or artist is empty or too long. `unknown`: the song is no longer in the library. */
  readonly outcome: 'saved' | 'invalid' | 'unknown';
}

export interface ResetTrackInfoResultDto {
  readonly outcome: 'reset' | 'nothing-to-reset' | 'unknown';
}
