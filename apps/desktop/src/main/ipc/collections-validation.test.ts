import { describe, expect, it } from 'vitest';
import { validateEnqueue } from './browse-validation.js';
import {
  validateAddToPlaylist,
  validateCreatePlaylist,
  validateGetThumbnail,
  validateHistoryList,
  validateListSource,
  validateMovePlaylistEntry,
  validatePlayList,
  validatePlaylistRef,
  validateRemoveFromPlaylist,
  validateRenamePlaylist,
  validateSetFavorite,
} from './collections-validation.js';
import { validatePlayTrack } from './playback-validation.js';
import { InvalidRequestError } from './validation.js';

const TRACK = '123e4567-e89b-42d3-a456-426614174000';
const PLAYLIST = '9b2f6c3e-1d4a-4c8b-8f10-2a7e5d6c4b3a';

describe('list sources', () => {
  it('accepts the three kinds', () => {
    expect(validateListSource({ kind: 'favorites' })).toEqual({ kind: 'favorites' });
    expect(validateListSource({ kind: 'history' })).toEqual({ kind: 'history' });
    expect(validateListSource({ kind: 'playlist', playlistId: PLAYLIST })).toEqual({ kind: 'playlist', playlistId: PLAYLIST });
  });
  it.each([undefined, null, 'favorites', {}, { kind: 'x' }, { kind: 'favorites', extra: 1 }, { kind: 'playlist' }, { kind: 'playlist', playlistId: '../etc' }, { kind: 'playlist', playlistId: 'a'.repeat(65) }])('refuses %j', (raw) => {
    expect(() => validateListSource(raw)).toThrow(InvalidRequestError);
  });
});

describe('favourites and history', () => {
  it('validates set-favourite', () => {
    expect(validateSetFavorite({ trackId: TRACK, favorite: true })).toEqual({ trackId: TRACK, favorite: true });
    expect(() => validateSetFavorite({ trackId: TRACK, favorite: 'yes' })).toThrow(InvalidRequestError);
    expect(() => validateSetFavorite({ trackId: '/etc/passwd', favorite: true })).toThrow(InvalidRequestError);
    expect(() => validateSetFavorite({ trackId: TRACK, favorite: true, x: 1 })).toThrow(InvalidRequestError);
  });
  it('validates the history limit', () => {
    expect(validateHistoryList(undefined)).toEqual({});
    expect(validateHistoryList({})).toEqual({});
    expect(validateHistoryList({ limit: 200 })).toEqual({ limit: 200 });
    for (const limit of [0, 201, 1.5, '5', Number.NaN]) expect(() => validateHistoryList({ limit })).toThrow(InvalidRequestError);
  });
});

describe('playlists', () => {
  it('validates create / rename / ref', () => {
    expect(validateCreatePlaylist({ name: 'Road trip' })).toEqual({ name: 'Road trip' });
    expect(validateCreatePlaylist({ name: 'x', trackIds: [TRACK] })).toEqual({ name: 'x', trackIds: [TRACK] });
    expect(() => validateCreatePlaylist({ name: 5 })).toThrow(InvalidRequestError);
    expect(() => validateCreatePlaylist({ name: 'x'.repeat(401) })).toThrow(InvalidRequestError);
    expect(() => validateCreatePlaylist({ name: 'x', trackIds: ['nope'] })).toThrow(InvalidRequestError);
    expect(validateRenamePlaylist({ playlistId: PLAYLIST, name: 'New' })).toEqual({ playlistId: PLAYLIST, name: 'New' });
    expect(validatePlaylistRef({ playlistId: PLAYLIST })).toEqual({ playlistId: PLAYLIST });
    expect(() => validatePlaylistRef({})).toThrow(InvalidRequestError);
  });
  it('bounds batches', () => {
    expect(() => validateAddToPlaylist({ playlistId: PLAYLIST, trackIds: Array(1001).fill(TRACK) })).toThrow(InvalidRequestError);
    expect(validateAddToPlaylist({ playlistId: PLAYLIST, trackIds: [TRACK, TRACK] }).trackIds).toHaveLength(2);
    expect(() => validateRemoveFromPlaylist({ playlistId: PLAYLIST, entryIds: ['a b'] })).toThrow(InvalidRequestError);
    expect(validateRemoveFromPlaylist({ playlistId: PLAYLIST, entryIds: [PLAYLIST] }).entryIds).toEqual([PLAYLIST]);
  });
  it('validates a move', () => {
    expect(validateMovePlaylistEntry({ playlistId: PLAYLIST, entryId: PLAYLIST, toIndex: 0 })).toEqual({ playlistId: PLAYLIST, entryId: PLAYLIST, toIndex: 0 });
    for (const toIndex of [-1, 1.2, '1', 1e9]) expect(() => validateMovePlaylistEntry({ playlistId: PLAYLIST, entryId: PLAYLIST, toIndex })).toThrow(InvalidRequestError);
  });
});

describe('play list, enqueue source, list context, thumbnails', () => {
  it('validates playList', () => {
    expect(validatePlayList({ source: { kind: 'favorites' } })).toEqual({ source: { kind: 'favorites' } });
    expect(validatePlayList({ source: { kind: 'history' }, startTrackId: TRACK, shuffle: true })).toEqual({ source: { kind: 'history' }, startTrackId: TRACK, shuffle: true });
    expect(() => validatePlayList({ source: { kind: 'favorites' }, shuffle: 'y' })).toThrow(InvalidRequestError);
    expect(() => validatePlayList({ source: { kind: 'favorites' }, startTrackId: 'x' })).toThrow(InvalidRequestError);
  });
  it('enqueue takes exactly one of trackId, group, source', () => {
    expect(validateEnqueue({ position: 'last', source: { kind: 'favorites' } })).toEqual({ position: 'last', source: { kind: 'favorites' } });
    expect(() => validateEnqueue({ position: 'last', source: { kind: 'favorites' }, trackId: TRACK })).toThrow(InvalidRequestError);
    expect(() => validateEnqueue({ position: 'last' })).toThrow(InvalidRequestError);
  });
  it('a list context is accepted by playTrack', () => {
    expect(validatePlayTrack({ trackId: TRACK, context: { kind: 'list', source: { kind: 'favorites' } } })).toEqual({ trackId: TRACK, context: { kind: 'list', source: { kind: 'favorites' } } });
    expect(() => validatePlayTrack({ trackId: TRACK, context: { kind: 'list' } })).toThrow(InvalidRequestError);
  });
  it('validates thumbnails', () => {
    expect(validateGetThumbnail({ trackId: TRACK, size: 'sm' })).toEqual({ trackId: TRACK, size: 'sm' });
    expect(() => validateGetThumbnail({ trackId: TRACK, size: 'xl' })).toThrow(InvalidRequestError);
    expect(() => validateGetThumbnail({ trackId: 'C:\\x.png', size: 'sm' })).toThrow(InvalidRequestError);
  });
});
