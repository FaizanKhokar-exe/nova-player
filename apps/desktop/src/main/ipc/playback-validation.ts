import { isValidTrackId } from '@nova/domain';
import type {
  TrackRefRequest,
  DiagnoseSourceRequest,
  PlaybackContextDto,
  PlayTrackRequest,
  PositionedRequest,
  ReportPositionRequest,
  RepeatModeDto,
  SetRepeatModeRequest,
  SetShuffleRequest,
  TrackFinishedRequest,
  LyricsSearchRequest,
  SaveLyricsRequest,
} from '@nova/shared';
import { validateGroupRef } from './browse-validation.js';
import { validateListSource } from './collections-validation.js';
import { InvalidRequestError, MAX_QUERY_LENGTH, isRecord, rejectUnknownKeys, validateSort } from './validation.js';

/** A playback position is whole milliseconds; this bound (~24 days) is far beyond any track
 *  and exists only to reject nonsense before it reaches the database. */
export const MAX_POSITION_MS = 2_147_483_647;

const REPEAT_MODES: readonly string[] = ['off', 'all', 'one'];

function trackIdField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || !isValidTrackId(value)) throw new InvalidRequestError(`"${key}" must be a valid track id.`);
  return value;
}

function positionField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_POSITION_MS) {
    throw new InvalidRequestError(`"${key}" must be a whole number of milliseconds between 0 and ${MAX_POSITION_MS}.`);
  }
  return value;
}

function objectOf(raw: unknown, what: string): Record<string, unknown> {
  if (!isRecord(raw)) throw new InvalidRequestError(`Expected an object with ${what}.`);
  return raw;
}

function validateContext(raw: unknown): PlaybackContextDto {
  const record = objectOf(raw, 'a "kind"');
  if (record.kind === 'library') {
    rejectUnknownKeys(record, ['kind', 'sort']);
    return record.sort === undefined ? { kind: 'library' } : { kind: 'library', sort: validateSort(record.sort) };
  }
  if (record.kind === 'search') {
    rejectUnknownKeys(record, ['kind', 'query']);
    const query = record.query;
    if (typeof query !== 'string') throw new InvalidRequestError('"query" must be a string.');
    if (query.length > MAX_QUERY_LENGTH) throw new InvalidRequestError(`"query" must be at most ${MAX_QUERY_LENGTH} characters.`);
    return { kind: 'search', query };
  }
  if (record.kind === 'group') {
    rejectUnknownKeys(record, ['kind', 'group', 'sort']);
    const group = validateGroupRef(record.group);
    return record.sort === undefined ? { kind: 'group', group } : { kind: 'group', group, sort: validateSort(record.sort) };
  }
  if (record.kind === 'list') {
    rejectUnknownKeys(record, ['kind', 'source']);
    return { kind: 'list', source: validateListSource(record.source) };
  }
  throw new InvalidRequestError('"kind" must be "library", "search", "group" or "list".');
}

export function validatePlayTrack(raw: unknown): PlayTrackRequest {
  const record = objectOf(raw, 'a "trackId"');
  rejectUnknownKeys(record, ['trackId', 'context']);
  const trackId = trackIdField(record, 'trackId');
  return record.context === undefined ? { trackId } : { trackId, context: validateContext(record.context) };
}

export function validatePositioned(raw: unknown): PositionedRequest {
  const record = objectOf(raw, 'a "positionMs"');
  rejectUnknownKeys(record, ['positionMs']);
  return { positionMs: positionField(record, 'positionMs') };
}

export function validateTrackFinished(raw: unknown): TrackFinishedRequest {
  const record = objectOf(raw, 'a "trackId"');
  rejectUnknownKeys(record, ['trackId']);
  return { trackId: trackIdField(record, 'trackId') };
}

export function validateSetRepeatMode(raw: unknown): SetRepeatModeRequest {
  const record = objectOf(raw, 'a "mode"');
  rejectUnknownKeys(record, ['mode']);
  const mode = record.mode;
  if (typeof mode !== 'string' || !REPEAT_MODES.includes(mode)) throw new InvalidRequestError('"mode" must be "off", "all" or "one".');
  return { mode: mode as RepeatModeDto };
}

export function validateSetShuffle(raw: unknown): SetShuffleRequest {
  const record = objectOf(raw, 'an "enabled" flag');
  rejectUnknownKeys(record, ['enabled']);
  if (typeof record.enabled !== 'boolean') throw new InvalidRequestError('"enabled" must be true or false.');
  return { enabled: record.enabled };
}

export function validateReportPosition(raw: unknown): ReportPositionRequest {
  const record = objectOf(raw, 'a "trackId" and "positionMs"');
  rejectUnknownKeys(record, ['trackId', 'positionMs']);
  return { trackId: trackIdField(record, 'trackId'), positionMs: positionField(record, 'positionMs') };
}

export function validateDiagnoseSource(raw: unknown): DiagnoseSourceRequest {
  const record = objectOf(raw, 'a "trackId"');
  rejectUnknownKeys(record, ['trackId']);
  return { trackId: trackIdField(record, 'trackId') };
}

/** `track:getLyrics` / `track:getArtwork`: exactly a valid track id and nothing else. */
export function validateTrackRef(raw: unknown): TrackRefRequest {
  const record = objectOf(raw, 'a "trackId"');
  rejectUnknownKeys(record, ['trackId']);
  return { trackId: trackIdField(record, 'trackId') };
}

export const MAX_SEARCH_TEXT = 200;
/** One MiB of UTF-16 code units is a safe upper bound on the text; the sidecar service enforces the exact byte limit. */
export const MAX_LRC_CHARS = 1024 * 1024;

export function validateLyricsSearch(raw: unknown): LyricsSearchRequest {
  const record = objectOf(raw, 'a "trackId"');
  rejectUnknownKeys(record, ['trackId', 'title', 'artist']);
  const out: { trackId: string; title?: string; artist?: string } = { trackId: trackIdField(record, 'trackId') };
  for (const key of ['title', 'artist'] as const) {
    const value = record[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.length > MAX_SEARCH_TEXT) throw new InvalidRequestError(`"${key}" must be a string of at most ${MAX_SEARCH_TEXT} characters.`);
    out[key] = value.trim();
  }
  return out;
}

export function validateSaveLyrics(raw: unknown): SaveLyricsRequest {
  const record = objectOf(raw, 'a "trackId" and "lrc"');
  rejectUnknownKeys(record, ['trackId', 'lrc']);
  const lrc = record.lrc;
  if (typeof lrc !== 'string' || lrc.length > MAX_LRC_CHARS) throw new InvalidRequestError('"lrc" must be text of at most 1 MiB.');
  return { trackId: trackIdField(record, 'trackId'), lrc };
}
