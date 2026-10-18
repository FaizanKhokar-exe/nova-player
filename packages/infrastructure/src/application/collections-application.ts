import { normalizeWhitespace, parseTrackId, type Track, type TrackId, type TrackRepository } from '@nova/domain';
import type { SqliteFavoritesRepository } from '../repositories/sqlite-favorites-repository.js';
import type { SqliteHistoryRepository } from '../repositories/sqlite-history-repository.js';
import type { PlaylistLimits, PlaylistRow, SqlitePlaylistRepository } from '../repositories/sqlite-playlist-repository.js';

/**
 * Phase 11: the listener's own collections - favourites, recently played and playlists - as ONE application
 * service the IPC handlers (and the playback service) call. It owns the rules (names, limits, what "unknown" means);
 * the SQLite repositories own the storage and make each multi-row change atomic.
 *
 * Errors this service throws are `CollectionsApplicationError`s with a stable code; the desktop shell turns them
 * into plain-language IPC errors. Nothing here ever returns or mentions a file path.
 */

export const DEFAULT_HISTORY_LIMIT = 50;
export const MAX_HISTORY_LIMIT = 200;
export const MAX_PLAYLIST_NAME_LENGTH = 80;

/** A list the queue can be built from, by name. Mirrors the IPC `ListSourceDto`. */
export type ListSource =
  | { readonly kind: 'favorites' }
  | { readonly kind: 'history' }
  | { readonly kind: 'playlist'; readonly playlistId: string };

export type CollectionsErrorCode = 'track-not-found' | 'playlist-not-found' | 'name-invalid' | 'limit-reached';

export class CollectionsApplicationError extends Error {
  readonly code: CollectionsErrorCode;
  constructor(code: CollectionsErrorCode, message: string) {
    super(message);
    this.name = 'CollectionsApplicationError';
    this.code = code;
  }
}

export interface PlaylistView {
  readonly id: string;
  readonly name: string;
  readonly trackCount: number;
  readonly durationSeconds: number | undefined;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly coverTrackIds: readonly string[];
}

export interface PlaylistEntryView {
  readonly entryId: string;
  readonly track: Track;
}

export interface PlaylistDetailView {
  readonly playlist: PlaylistView;
  readonly entries: readonly PlaylistEntryView[];
}

export interface HistoryItemView {
  readonly track: Track;
  readonly playedAtMs: number;
}

export interface CollectionsApplication {
  /* favourites */
  /** Favourite tracks, most recently favourited first. */
  listFavorites(): readonly Track[];
  listFavoriteIds(): readonly string[];
  /** @throws CollectionsApplicationError `track-not-found` (only when adding a track that is not in the library) */
  setFavorite(trackId: string, favorite: boolean): boolean;

  /* recently played */
  /** Records one play of a track (time = now, count + 1). A track that is no longer in the library is ignored. */
  recordPlay(trackId: string): void;
  /** Each track once, most recent first. `limit` defaults to 50 and is clamped to 1..200. */
  listHistory(limit?: number): readonly HistoryItemView[];
  clearHistory(): number;

  /* playlists */
  listPlaylists(): readonly PlaylistView[];
  /** @throws CollectionsApplicationError `name-invalid` | `limit-reached` */
  createPlaylist(name: string, trackIds?: readonly string[]): PlaylistView;
  /** @throws CollectionsApplicationError `name-invalid` | `playlist-not-found` */
  renamePlaylist(playlistId: string, name: string): PlaylistView;
  deletePlaylist(playlistId: string): boolean;
  /** @throws CollectionsApplicationError `playlist-not-found` */
  getPlaylist(playlistId: string): PlaylistDetailView;
  /** @throws CollectionsApplicationError `playlist-not-found` | `limit-reached` (nothing could be added) */
  addToPlaylist(playlistId: string, trackIds: readonly string[]): { readonly playlist: PlaylistView; readonly added: number };
  /** @throws CollectionsApplicationError `playlist-not-found` */
  removeFromPlaylist(playlistId: string, entryIds: readonly string[]): PlaylistDetailView;
  /** @throws CollectionsApplicationError `playlist-not-found` */
  movePlaylistEntry(playlistId: string, entryId: string, toIndex: number): PlaylistDetailView;

  /**
   * The track ids of a list in the order the listener sees it (favourites newest first, history most recent
   * first, a playlist in its order, duplicates included). Used to build a queue.
   * @throws CollectionsApplicationError `playlist-not-found`
   */
  listSourceTrackIds(source: ListSource): readonly TrackId[];
}

export interface CollectionsApplicationDependencies {
  readonly trackRepository: Pick<TrackRepository, 'getById'>;
  readonly favorites: SqliteFavoritesRepository;
  readonly history: SqliteHistoryRepository;
  readonly playlists: SqlitePlaylistRepository;
  readonly limits: PlaylistLimits;
}

/** Trims, collapses inner whitespace, and checks 1..80 characters (code points) with no control characters. */
export function normalizePlaylistName(raw: string): string {
  if (typeof raw !== 'string') throw nameInvalid();
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is being refused
  if (/[\u0000-\u0008\u000e-\u001f\u007f]/.test(raw)) throw nameInvalid();
  const name = normalizeWhitespace(raw);
  const length = [...name].length;
  if (length < 1 || length > MAX_PLAYLIST_NAME_LENGTH) throw nameInvalid();
  return name;
}

function nameInvalid(): CollectionsApplicationError {
  return new CollectionsApplicationError('name-invalid', `A playlist name must be 1 to ${MAX_PLAYLIST_NAME_LENGTH} characters.`);
}
const playlistMissing = (): CollectionsApplicationError => new CollectionsApplicationError('playlist-not-found', 'That playlist no longer exists.');
const trackMissing = (): CollectionsApplicationError => new CollectionsApplicationError('track-not-found', 'That track is not in the library.');

export function createCollectionsApplication(dependencies: CollectionsApplicationDependencies): CollectionsApplication {
  const { trackRepository, favorites, history, playlists, limits } = dependencies;

  const toView = (row: PlaylistRow): PlaylistView => ({
    id: row.id,
    name: row.name,
    trackCount: row.trackCount,
    durationSeconds: row.durationSeconds,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
    coverTrackIds: row.coverTrackIds,
  });

  function tracksOf(ids: readonly string[]): Track[] {
    const found: Track[] = [];
    for (const id of ids) {
      const parsed = parseTrackId(id);
      const track = parsed === undefined ? undefined : trackRepository.getById(parsed);
      if (track !== undefined) found.push(track);
    }
    return found;
  }

  function detail(playlistId: string): PlaylistDetailView {
    const row = playlists.get(playlistId);
    if (row === undefined) throw playlistMissing();
    const entries: PlaylistEntryView[] = [];
    for (const entry of playlists.entries(playlistId)) {
      const parsed = parseTrackId(entry.trackId);
      const track = parsed === undefined ? undefined : trackRepository.getById(parsed);
      if (track !== undefined) entries.push({ entryId: entry.entryId, track });
    }
    return { playlist: toView(row), entries };
  }

  function view(playlistId: string): PlaylistView {
    const row = playlists.get(playlistId);
    if (row === undefined) throw playlistMissing();
    return toView(row);
  }

  return {
    listFavorites: () => tracksOf(favorites.listIds()),
    listFavoriteIds: () => favorites.listIds(),

    setFavorite(trackId, favorite) {
      if (!favorite) {
        const parsed = parseTrackId(trackId);
        if (parsed !== undefined) favorites.delete(parsed);
        return false;
      }
      const parsed = parseTrackId(trackId);
      if (parsed === undefined || trackRepository.getById(parsed) === undefined) throw trackMissing();
      favorites.add(parsed);
      return true;
    },

    recordPlay(trackId) {
      const parsed = parseTrackId(trackId);
      if (parsed === undefined || trackRepository.getById(parsed) === undefined) return;
      history.record(parsed);
    },

    listHistory(limit = DEFAULT_HISTORY_LIMIT) {
      const bounded = Math.min(MAX_HISTORY_LIMIT, Math.max(1, Math.trunc(limit)));
      const items: HistoryItemView[] = [];
      for (const row of history.list(bounded)) {
        const track = tracksOf([row.trackId])[0];
        if (track !== undefined) items.push({ track, playedAtMs: row.lastPlayedAtMs });
      }
      return items;
    },

    clearHistory: () => history.clear(),

    listPlaylists: () => playlists.list().map(toView),

    createPlaylist(rawName, trackIds = []) {
      const name = normalizePlaylistName(rawName);
      const { id, outcome } = playlists.create(name, trackIds);
      if (outcome.status === 'limit-reached') {
        throw new CollectionsApplicationError('limit-reached', `You can have at most ${limits.maxPlaylists} playlists. Delete one to make a new one.`);
      }
      return view(id);
    },

    renamePlaylist(playlistId, rawName) {
      const name = normalizePlaylistName(rawName);
      if (!playlists.rename(playlistId, name)) throw playlistMissing();
      return view(playlistId);
    },

    deletePlaylist: (playlistId) => playlists.delete(playlistId),

    getPlaylist: detail,

    addToPlaylist(playlistId, trackIds) {
      const outcome = playlists.addTracks(playlistId, trackIds);
      if (outcome.status === 'not-found') throw playlistMissing();
      if (outcome.status === 'limit-reached') {
        throw new CollectionsApplicationError('limit-reached', `A playlist can hold at most ${limits.maxEntries} tracks.`);
      }
      return { playlist: view(playlistId), added: outcome.added };
    },

    removeFromPlaylist(playlistId, entryIds) {
      if (!playlists.removeEntries(playlistId, entryIds)) throw playlistMissing();
      return detail(playlistId);
    },

    movePlaylistEntry(playlistId, entryId, toIndex) {
      if (!playlists.moveEntry(playlistId, entryId, toIndex)) throw playlistMissing();
      return detail(playlistId);
    },

    listSourceTrackIds(source) {
      let ids: readonly string[];
      switch (source.kind) {
        case 'favorites':
          ids = favorites.listIds();
          break;
        case 'history':
          ids = history.list(MAX_HISTORY_LIMIT).map((row) => row.trackId);
          break;
        case 'playlist':
          if (playlists.get(source.playlistId) === undefined) throw playlistMissing();
          ids = playlists.entries(source.playlistId).map((entry) => entry.trackId);
          break;
      }
      return ids.flatMap((id) => {
        const parsed = parseTrackId(id);
        return parsed === undefined ? [] : [parsed];
      });
    },
  };
}
