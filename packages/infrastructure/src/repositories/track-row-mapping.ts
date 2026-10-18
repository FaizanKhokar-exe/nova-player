import {
  computeDeduplicationKey,
  parseTrackId,
  TrackRepositoryError,
  type ArtworkReference,
  type MetadataFieldSource,
  type Track,
  type TrackRecord,
} from '@nova/domain';

/**
 * The shape of one `tracks` row exactly as SQLite returns it (snake_case,
 * NULL for absent). Infrastructure-internal: it never leaves this package
 * and the domain has no knowledge of it.
 */
export interface TrackRow {
  readonly id: string;
  readonly source_path: string;
  /** Path comparison key (unique); see the path policy. Never read back into the domain. */
  readonly source_path_key: string;
  readonly title: string;
  readonly title_source: string;
  readonly artist: string;
  readonly artist_source: string;
  readonly album: string | null;
  readonly album_artist: string | null;
  readonly genre: string | null;
  readonly track_number: number | null;
  readonly disc_number: number | null;
  readonly year: number | null;
  /** Seconds, as in the domain `Track` - no unit conversion happens. */
  readonly duration_seconds: number | null;
  readonly artwork_kind: string;
  readonly artwork_path: string | null;
  readonly size_bytes: number;
  readonly dedup_key: string;
  /** Whole milliseconds since the epoch; 0 = unknown. */
  readonly modified_at_ms: number;
}

/** Turns a stored `sourcePath` into its unique comparison key. Injected into
 *  the repository so the path POLICY lives in one place (the filesystem
 *  layer) and tests can substitute it. */
export type PathKeyFunction = (sourcePath: string) => string;

/** Named parameters for INSERT/UPDATE - the same columns as a row. */
export type TrackRowParams = TrackRow;

/** The columns every query selects, in one place (no `SELECT *`, so a later
 *  migration adding columns can't silently change what the mapper sees). */
export const TRACK_COLUMNS = [
  'id', 'source_path', 'source_path_key', 'title', 'title_source', 'artist', 'artist_source',
  'album', 'album_artist', 'genre', 'track_number', 'disc_number', 'year',
  'duration_seconds', 'artwork_kind', 'artwork_path', 'size_bytes', 'dedup_key', 'modified_at_ms',
] as const;

/** Domain -> row. Absent (`undefined`) optional fields become NULL, and the
 *  advisory dedup key is computed here with the DOMAIN's own function. */
export function trackToRowParams({ track, sizeBytes, modifiedAtMs }: TrackRecord, pathKey: PathKeyFunction): TrackRowParams {
  return {
    id: track.id,
    source_path: track.sourcePath,
    source_path_key: pathKey(track.sourcePath),
    title: track.title,
    title_source: track.titleSource,
    artist: track.artist,
    artist_source: track.artistSource,
    album: track.album ?? null,
    album_artist: track.albumArtist ?? null,
    genre: track.genre ?? null,
    track_number: track.trackNumber ?? null,
    disc_number: track.discNumber ?? null,
    year: track.year ?? null,
    duration_seconds: track.durationSeconds ?? null,
    artwork_kind: track.artwork.kind,
    artwork_path: track.artwork.kind === 'external' ? track.artwork.path : null,
    size_bytes: sizeBytes,
    dedup_key: computeDeduplicationKey({ title: track.title, artist: track.artist, sizeBytes }),
    modified_at_ms: modifiedAtMs ?? 0,
  };
}

function corrupt(row: TrackRow, detail: string): TrackRepositoryError {
  return new TrackRepositoryError('corrupt-record', `Stored track "${row.id}" is unreadable: ${detail}`);
}

function toMetadataSource(row: TrackRow, column: string, value: string): MetadataFieldSource {
  if (value === 'tag' || value === 'filename' || value === 'unknown') return value;
  throw corrupt(row, `${column} has unknown value "${value}".`);
}

function toArtwork(row: TrackRow): ArtworkReference {
  switch (row.artwork_kind) {
    case 'embedded':
      return { kind: 'embedded' };
    case 'none':
      return { kind: 'none' };
    case 'external':
      if (row.artwork_path === null || row.artwork_path.length === 0) {
        throw corrupt(row, 'external artwork has no path.');
      }
      return { kind: 'external', path: row.artwork_path };
    default:
      throw corrupt(row, `artwork_kind has unknown value "${row.artwork_kind}".`);
  }
}

/** Row -> domain. NULL becomes `undefined`; the id is re-validated through
 *  the domain's `parseTrackId` rather than trusted. Throws a
 *  `corrupt-record` error for a row that cannot form a valid `Track`. */
export function rowToTrack(row: TrackRow): Track {
  const id = parseTrackId(row.id);
  if (id === undefined) throw corrupt(row, 'id is not a valid TrackId.');

  return {
    id,
    sourcePath: row.source_path,
    title: row.title,
    titleSource: toMetadataSource(row, 'title_source', row.title_source),
    artist: row.artist,
    artistSource: toMetadataSource(row, 'artist_source', row.artist_source),
    album: row.album ?? undefined,
    albumArtist: row.album_artist ?? undefined,
    genre: row.genre ?? undefined,
    trackNumber: row.track_number ?? undefined,
    discNumber: row.disc_number ?? undefined,
    year: row.year ?? undefined,
    durationSeconds: row.duration_seconds ?? undefined,
    artwork: toArtwork(row),
  };
}
