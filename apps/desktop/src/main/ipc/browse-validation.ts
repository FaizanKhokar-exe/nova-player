import { isGroupKind, isValidTrackId } from '@nova/domain';
import type {
  EnqueueRequest,
  GetGroupRequest,
  GetQueueRequest,
  GroupRefDto,
  ListGroupsRequest,
  MoveQueueItemRequest,
  PlayGroupRequest,
  QueueItemRequest,
} from '@nova/shared';
import { validateListSource } from './collections-validation.js';
import { InvalidRequestError, isRecord, optionalNonNegativeInteger, rejectUnknownKeys, validateSort } from './validation.js';

/**
 * Untrusted-input checks for the Phase 5 browse and queue channels. Same rules as the
 * rest of the boundary: exact shapes, unknown keys rejected, ids and enums checked at
 * runtime (TypeScript types are erased), nothing path-like accepted anywhere.
 */

/** A group key is opaque and built by main; this bound only rejects absurd input. */
export const MAX_GROUP_KEY_LENGTH = 2_000;
export const MAX_QUEUE_WINDOW = 1_000;
export const DEFAULT_QUEUE_WINDOW = 200;

function objectOf(raw: unknown, what: string): Record<string, unknown> {
  if (!isRecord(raw)) throw new InvalidRequestError(`Expected an object with ${what}.`);
  return raw;
}

export function validateGroupRef(raw: unknown): GroupRefDto {
  const record = objectOf(raw, 'a "kind" and a "key"');
  rejectUnknownKeys(record, ['kind', 'key']);
  return groupRefFrom(record);
}

function groupRefFrom(record: Record<string, unknown>): GroupRefDto {
  if (!isGroupKind(record.kind)) throw new InvalidRequestError('"kind" must be "album", "artist" or "genre".');
  const key = record.key;
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_GROUP_KEY_LENGTH) {
    throw new InvalidRequestError(`"key" must be a non-empty string of at most ${MAX_GROUP_KEY_LENGTH} characters.`);
  }
  return { kind: record.kind, key };
}

export function validateListGroups(raw: unknown): ListGroupsRequest {
  const record = objectOf(raw, 'a "kind"');
  rejectUnknownKeys(record, ['kind']);
  if (!isGroupKind(record.kind)) throw new InvalidRequestError('"kind" must be "album", "artist" or "genre".');
  return { kind: record.kind };
}

export function validateGetGroup(raw: unknown): GetGroupRequest {
  const record = objectOf(raw, 'a "kind" and a "key"');
  rejectUnknownKeys(record, ['kind', 'key', 'sort']);
  const ref = groupRefFrom(record);
  return record.sort === undefined ? ref : { ...ref, sort: validateSort(record.sort) };
}

export function validatePlayGroup(raw: unknown): PlayGroupRequest {
  const record = objectOf(raw, 'a "group"');
  rejectUnknownKeys(record, ['group', 'sort']);
  const group = validateGroupRef(record.group);
  return record.sort === undefined ? { group } : { group, sort: validateSort(record.sort) };
}

export function validateGetQueue(raw: unknown): GetQueueRequest {
  if (raw === undefined) return {};
  const record = objectOf(raw, '"offset" and "limit"');
  rejectUnknownKeys(record, ['offset', 'limit']);
  const offset = optionalNonNegativeInteger(record, 'offset', Number.MAX_SAFE_INTEGER);
  const limit = optionalNonNegativeInteger(record, 'limit', MAX_QUEUE_WINDOW);
  return { ...(offset !== undefined && { offset }), ...(limit !== undefined && { limit }) };
}

export function validateEnqueue(raw: unknown): EnqueueRequest {
  const record = objectOf(raw, 'a "position" and a "trackId", "group" or "source"');
  rejectUnknownKeys(record, ['position', 'trackId', 'group', 'source']);
  if (record.position !== 'next' && record.position !== 'last') throw new InvalidRequestError('"position" must be "next" or "last".');
  const given = (['trackId', 'group', 'source'] as const).filter((key) => record[key] !== undefined);
  if (given.length !== 1) throw new InvalidRequestError('Give exactly one of "trackId", "group" or "source".');
  if (given[0] === 'trackId') {
    if (typeof record.trackId !== 'string' || !isValidTrackId(record.trackId)) throw new InvalidRequestError('"trackId" must be a valid track id.');
    return { position: record.position, trackId: record.trackId };
  }
  if (given[0] === 'source') return { position: record.position, source: validateListSource(record.source) };
  return { position: record.position, group: validateGroupRef(record.group) };
}

function indexField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new InvalidRequestError(`"${key}" must be a whole number, 0 or more.`);
  }
  return value;
}

function queueTrackId(record: Record<string, unknown>): string {
  const value = record.trackId;
  if (typeof value !== 'string' || !isValidTrackId(value)) throw new InvalidRequestError('"trackId" must be a valid track id.');
  return value;
}

export function validateQueueItem(raw: unknown): QueueItemRequest {
  const record = objectOf(raw, 'an "index" and a "trackId"');
  rejectUnknownKeys(record, ['index', 'trackId']);
  return { index: indexField(record, 'index'), trackId: queueTrackId(record) };
}

export function validateMoveQueueItem(raw: unknown): MoveQueueItemRequest {
  const record = objectOf(raw, 'an "index", a "toIndex" and a "trackId"');
  rejectUnknownKeys(record, ['index', 'toIndex', 'trackId']);
  return { index: indexField(record, 'index'), toIndex: indexField(record, 'toIndex'), trackId: queueTrackId(record) };
}
