import { isValidTrackId } from '@nova/domain';
import type {
  AddToPlaylistRequest,
  CreatePlaylistRequest,
  GetThumbnailRequest,
  HistoryListRequest,
  ListSourceDto,
  MovePlaylistEntryRequest,
  PlayListRequest,
  PlaylistRefRequest,
  RemoveFromPlaylistRequest,
  RenamePlaylistRequest,
  SetFavoriteRequest,
} from '@nova/shared';
import { InvalidRequestError, isRecord, rejectUnknownKeys } from './validation.js';

/** Untrusted-input checks for the Phase 11 channels (favourites, history, playlists, thumbnails). Same rules as the rest of the boundary. */

export const MAX_BATCH_TRACKS = 1_000;
const MAX_NAME_INPUT = 400; // the application trims and enforces 80; this only bounds absurd input
const ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

function objectOf(raw: unknown, what: string): Record<string, unknown> {
  if (!isRecord(raw)) throw new InvalidRequestError(`Expected an object with ${what}.`);
  return raw;
}

function idField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw new InvalidRequestError(`"${key}" must be a valid id.`);
  return value;
}

function trackIdField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || !isValidTrackId(value)) throw new InvalidRequestError(`"${key}" must be a valid track id.`);
  return value;
}

function trackIdList(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.length > MAX_BATCH_TRACKS) throw new InvalidRequestError(`"${key}" must be a list of at most ${MAX_BATCH_TRACKS} track ids.`);
  return value.map((item) => {
    if (typeof item !== 'string' || !isValidTrackId(item)) throw new InvalidRequestError(`"${key}" must contain only valid track ids.`);
    return item;
  });
}

function nameField(record: Record<string, unknown>): string {
  const value = record.name;
  if (typeof value !== 'string' || value.length > MAX_NAME_INPUT) throw new InvalidRequestError('"name" must be text.');
  return value;
}

export function validateListSource(raw: unknown): ListSourceDto {
  const record = objectOf(raw, 'a "kind"');
  if (record.kind === 'favorites' || record.kind === 'history') {
    rejectUnknownKeys(record, ['kind']);
    return { kind: record.kind };
  }
  if (record.kind === 'playlist') {
    rejectUnknownKeys(record, ['kind', 'playlistId']);
    return { kind: 'playlist', playlistId: idField(record, 'playlistId') };
  }
  throw new InvalidRequestError('"kind" must be "favorites", "history" or "playlist".');
}

export function validateSetFavorite(raw: unknown): SetFavoriteRequest {
  const record = objectOf(raw, 'a "trackId" and a "favorite" flag');
  rejectUnknownKeys(record, ['trackId', 'favorite']);
  if (typeof record.favorite !== 'boolean') throw new InvalidRequestError('"favorite" must be true or false.');
  return { trackId: trackIdField(record, 'trackId'), favorite: record.favorite };
}

export function validateHistoryList(raw: unknown): HistoryListRequest {
  if (raw === undefined) return {};
  const record = objectOf(raw, 'an optional "limit"');
  rejectUnknownKeys(record, ['limit']);
  if (record.limit === undefined) return {};
  if (typeof record.limit !== 'number' || !Number.isSafeInteger(record.limit) || record.limit < 1 || record.limit > 200) {
    throw new InvalidRequestError('"limit" must be a whole number from 1 to 200.');
  }
  return { limit: record.limit };
}

export function validatePlaylistRef(raw: unknown): PlaylistRefRequest {
  const record = objectOf(raw, 'a "playlistId"');
  rejectUnknownKeys(record, ['playlistId']);
  return { playlistId: idField(record, 'playlistId') };
}

export function validateCreatePlaylist(raw: unknown): CreatePlaylistRequest {
  const record = objectOf(raw, 'a "name"');
  rejectUnknownKeys(record, ['name', 'trackIds']);
  const name = nameField(record);
  return record.trackIds === undefined ? { name } : { name, trackIds: trackIdList(record, 'trackIds') };
}

export function validateRenamePlaylist(raw: unknown): RenamePlaylistRequest {
  const record = objectOf(raw, 'a "playlistId" and a "name"');
  rejectUnknownKeys(record, ['playlistId', 'name']);
  return { playlistId: idField(record, 'playlistId'), name: nameField(record) };
}

export function validateAddToPlaylist(raw: unknown): AddToPlaylistRequest {
  const record = objectOf(raw, 'a "playlistId" and "trackIds"');
  rejectUnknownKeys(record, ['playlistId', 'trackIds']);
  return { playlistId: idField(record, 'playlistId'), trackIds: trackIdList(record, 'trackIds') };
}

export function validateRemoveFromPlaylist(raw: unknown): RemoveFromPlaylistRequest {
  const record = objectOf(raw, 'a "playlistId" and "entryIds"');
  rejectUnknownKeys(record, ['playlistId', 'entryIds']);
  const entryIds = record.entryIds;
  if (!Array.isArray(entryIds) || entryIds.length > MAX_BATCH_TRACKS) throw new InvalidRequestError(`"entryIds" must be a list of at most ${MAX_BATCH_TRACKS} ids.`);
  return {
    playlistId: idField(record, 'playlistId'),
    entryIds: entryIds.map((item) => {
      if (typeof item !== 'string' || !ID_PATTERN.test(item)) throw new InvalidRequestError('"entryIds" must contain only valid ids.');
      return item;
    }),
  };
}

export function validateMovePlaylistEntry(raw: unknown): MovePlaylistEntryRequest {
  const record = objectOf(raw, 'a "playlistId", an "entryId" and a "toIndex"');
  rejectUnknownKeys(record, ['playlistId', 'entryId', 'toIndex']);
  const toIndex = record.toIndex;
  if (typeof toIndex !== 'number' || !Number.isSafeInteger(toIndex) || toIndex < 0 || toIndex > 100_000) throw new InvalidRequestError('"toIndex" must be a whole number, 0 or more.');
  return { playlistId: idField(record, 'playlistId'), entryId: idField(record, 'entryId'), toIndex };
}

export function validatePlayList(raw: unknown): PlayListRequest {
  const record = objectOf(raw, 'a "source"');
  rejectUnknownKeys(record, ['source', 'startTrackId', 'shuffle']);
  const source = validateListSource(record.source);
  if (record.shuffle !== undefined && typeof record.shuffle !== 'boolean') throw new InvalidRequestError('"shuffle" must be true or false.');
  return {
    source,
    ...(record.startTrackId !== undefined && { startTrackId: trackIdField(record, 'startTrackId') }),
    ...(record.shuffle !== undefined && { shuffle: record.shuffle }),
  };
}

export function validateGetThumbnail(raw: unknown): GetThumbnailRequest {
  const record = objectOf(raw, 'a "trackId" and a "size"');
  rejectUnknownKeys(record, ['trackId', 'size']);
  if (record.size !== 'sm' && record.size !== 'md') throw new InvalidRequestError('"size" must be "sm" or "md".');
  return { trackId: trackIdField(record, 'trackId'), size: record.size };
}
