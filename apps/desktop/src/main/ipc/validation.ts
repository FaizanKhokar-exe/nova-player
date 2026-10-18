import { isSortDirection, isTrackSortField } from '@nova/domain';
import type { RemoveRootRequest, StartScanRequest, TrackSortDto } from '@nova/shared';

/** The renderer is untrusted: TypeScript types are erased at runtime, so every
 *  request is checked here, at the trust boundary, before it reaches the
 *  application layer. */
export class InvalidRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRequestError';
  }
}

export const MAX_LIST_LIMIT = 100_000;
export const DEFAULT_SEARCH_LIMIT = 500;
export const MAX_SEARCH_LIMIT = 5_000;
export const MAX_QUERY_LENGTH = 500;
const UUID_LENGTH = 36;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Requests that carry nothing: only `undefined` is accepted, so a caller
 *  cannot smuggle data through a channel that ignores it. */
export function validateNoRequest(raw: unknown): void {
  if (raw !== undefined) throw new InvalidRequestError('This request takes no arguments.');
}

export function optionalNonNegativeInteger(record: Record<string, unknown>, key: string, max: number): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) {
    throw new InvalidRequestError(`"${key}" must be an integer between 0 and ${max}.`);
  }
  return value;
}

export function rejectUnknownKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new InvalidRequestError(`Unexpected field "${key}".`);
  }
}

function idField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length !== UUID_LENGTH) throw new InvalidRequestError(`"${key}" must be a valid id.`);
  return value;
}

export function validateRemoveRoot(raw: unknown): RemoveRootRequest {
  if (!isRecord(raw)) throw new InvalidRequestError('Expected an object with a "rootId".');
  rejectUnknownKeys(raw, ['rootId']);
  return { rootId: idField(raw, 'rootId') };
}

export function validateStartScan(raw: unknown): StartScanRequest {
  if (raw === undefined) return {};
  if (!isRecord(raw)) throw new InvalidRequestError('Expected an object.');
  rejectUnknownKeys(raw, ['rootId']);
  return raw.rootId === undefined ? {} : { rootId: idField(raw, 'rootId') };
}

export function validateListTracks(raw: unknown): { offset: number; limit: number | undefined; sort: TrackSortDto | undefined } {
  if (raw === undefined) return { offset: 0, limit: undefined, sort: undefined };
  if (!isRecord(raw)) throw new InvalidRequestError('Expected an object.');
  rejectUnknownKeys(raw, ['offset', 'limit', 'sort']);
  return {
    offset: optionalNonNegativeInteger(raw, 'offset', Number.MAX_SAFE_INTEGER) ?? 0,
    limit: optionalNonNegativeInteger(raw, 'limit', MAX_LIST_LIMIT),
    sort: raw.sort === undefined ? undefined : validateSort(raw.sort),
  };
}

/** A sort request: exactly a known field and a direction. */
export function validateSort(raw: unknown): TrackSortDto {
  if (!isRecord(raw)) throw new InvalidRequestError('"sort" must be an object with a "field" and a "direction".');
  rejectUnknownKeys(raw, ['field', 'direction']);
  const { field, direction } = raw;
  if (!isTrackSortField(field)) {
    throw new InvalidRequestError('"field" must be one of title, artist, album, albumArtist, genre, year or duration.');
  }
  if (!isSortDirection(direction)) throw new InvalidRequestError('"direction" must be "asc" or "desc".');
  return { field, direction };
}

export function validateSearch(raw: unknown): { query: string; limit: number } {
  if (!isRecord(raw)) throw new InvalidRequestError('Expected an object with a "query".');
  rejectUnknownKeys(raw, ['query', 'limit']);
  const query = raw.query;
  if (typeof query !== 'string') throw new InvalidRequestError('"query" must be a string.');
  if (query.length > MAX_QUERY_LENGTH) throw new InvalidRequestError(`"query" must be at most ${MAX_QUERY_LENGTH} characters.`);
  const limit = optionalNonNegativeInteger(raw, 'limit', MAX_SEARCH_LIMIT) ?? DEFAULT_SEARCH_LIMIT;
  return { query, limit };
}
