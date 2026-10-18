import { useEffect } from 'react';
import type { ListSourceDto, PlaybackContextDto } from '@nova/shared';
import { formatDuration, plural } from '../../library/format.js';
import { useCollections } from '../../collections/CollectionsStoreProvider.js';
import { useActions } from '../actions.js';
import { Cover, MosaicCover } from '../Cover.js';
import { Empty, ErrorNote, Hero, Loading, PlayButtons, Tile } from '../parts.js';
import { useServices } from '../services.js';
import { TrackList } from '../TrackList.js';

const HEART_COVER = (
  <div style={{ width: '100%', aspectRatio: '1', display: 'grid', placeItems: 'center', background: 'linear-gradient(135deg, #ff4d79, #8b5cf6)', color: '#fff' }}>
    <svg width="46%" height="46%" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 20.500s-8-4.800-8-10.600A4.400 4.400 0 0 1 12 7.600a4.400 4.400 0 0 1 8 2.300c0 5.800-8 10.600-8 10.600z" /></svg>
  </div>
);
const CLOCK_COVER = (
  <div style={{ width: '100%', aspectRatio: '1', display: 'grid', placeItems: 'center', background: 'linear-gradient(135deg, #22d3ee, #5b8cff)', color: '#fff' }}>
    <svg width="46%" height="46%" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zm0-14v5l3 2" /></svg>
  </div>
);

export function FavoritesView() {
  const { collections, playback } = useServices();
  const favorites = useCollections((s) => s.favorites);
  const actions = useActions();
  useEffect(() => void collections.getState().loadFavorites(), [collections]);
  const source: ListSourceDto = { kind: 'favorites' };
  const context: PlaybackContextDto = { kind: 'list', source };
  const total = favorites.tracks.reduce((sum, t) => sum + (t.durationSeconds ?? 0), 0);
  return (
    <div className="nx-page" data-testid="view-favorites">
      <Hero cover={HEART_COVER} kicker="Playlist" title="Favorites" subtitle={`${plural(favorites.tracks.length, 'song')}${total > 0 ? ` · ${formatDuration(total)}` : ''}`}>
        <PlayButtons label="Favorites" disabled={favorites.tracks.length === 0} onPlay={() => actions.playList(source)} onShuffle={() => void playback.getState().setShuffle(true).then(() => actions.playList(source, { shuffle: true }))} />
      </Hero>
      {favorites.status === 'error' && <ErrorNote message="Could not load your favorites." onRetry={() => void collections.getState().loadFavorites()} />}
      {favorites.status !== 'ready' && favorites.tracks.length === 0 ? (
        favorites.status === 'error' ? null : <Loading rows={5} />
      ) : favorites.tracks.length === 0 ? (
        <Empty icon="heart" title="No favorites yet" body="Tap the heart next to any song to keep it here." />
      ) : (
        <TrackList tracks={favorites.tracks} context={context} label="Favorite songs" />
      )}
    </div>
  );
}

export function RecentsView() {
  const { collections } = useServices();
  const history = useCollections((s) => s.history);
  const actions = useActions();
  useEffect(() => void collections.getState().loadHistory(), [collections]);
  const source: ListSourceDto = { kind: 'history' };
  const context: PlaybackContextDto = { kind: 'list', source };
  const tracks = history.items.map((item) => item.track);
  return (
    <div className="nx-page" data-testid="view-recents">
      <Hero cover={CLOCK_COVER} kicker="History" title="Recently played" subtitle={plural(tracks.length, 'song')}>
        <button type="button" className="nx-btn nx-btn--primary" disabled={tracks.length === 0} onClick={() => actions.playList(source)}>Play</button>
        <button
          type="button"
          className="nx-btn nx-btn--ghost"
          disabled={tracks.length === 0}
          data-testid="clear-history"
          onClick={() => actions.askClear()}
        >
          Clear history
        </button>
      </Hero>
      {history.status === 'error' && <ErrorNote message="Could not load your history." onRetry={() => void collections.getState().loadHistory()} />}
      {history.status !== 'ready' && tracks.length === 0 ? (
        history.status === 'error' ? null : <Loading rows={5} />
      ) : tracks.length === 0 ? (
        <Empty icon="clock" title="Nothing played yet" body="Songs you listen to for more than a few seconds show up here." />
      ) : (
        <TrackList tracks={tracks} context={context} label="Recently played songs" />
      )}
    </div>
  );
}

export function PlaylistsView() {
  const { ui, collections } = useServices();
  const playlists = useCollections((s) => s.playlists);
  const actions = useActions();
  useEffect(() => void collections.getState().loadPlaylists(), [collections]);
  return (
    <div className="nx-page" data-testid="view-playlists">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <h1 className="nx-h1">Playlists</h1>
        <button type="button" className="nx-btn nx-btn--primary" data-testid="new-playlist" onClick={() => actions.askCreatePlaylist()}>New playlist</button>
      </div>
      {playlists.status === 'error' && <ErrorNote message="Could not load your playlists." onRetry={() => void collections.getState().loadPlaylists()} />}
      {playlists.items.length === 0 && playlists.status === 'ready' ? (
        <Empty icon="playlist" title="Make your first playlist" body="Group songs for a mood, a trip or a workout. You can add songs from any song's ⋯ menu.">
          <button type="button" className="nx-btn nx-btn--primary" onClick={() => actions.askCreatePlaylist()}>Create playlist</button>
        </Empty>
      ) : (
        <div className="nx-grid">
          {playlists.items.map((list) => (
            <Tile
              key={list.id}
              testId="playlist-tile"
              cover={<MosaicCover trackIds={list.coverTrackIds} seed={list.id} size="md" />}
              title={list.name}
              subtitle={plural(list.trackCount, 'song')}
              onOpen={() => ui.getState().navigate({ name: 'playlist', id: list.id })}
              {...(list.trackCount > 0 && { onPlay: () => actions.playList({ kind: 'playlist', playlistId: list.id }) })}
              onMenu={(event) => actions.showMenuAt(event.clientX, event.clientY, actions.playlistMenu(list))}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function PlaylistView({ playlistId }: { playlistId: string }) {
  const { collections, playback } = useServices();
  const state = useCollections((s) => s.playlist);
  const actions = useActions();
  useEffect(() => void collections.getState().loadPlaylist(playlistId), [collections, playlistId]);

  const current = state.playlistId === playlistId ? state : undefined;
  if (current === undefined || (current.status === 'loading' && current.playlist === undefined)) return <div className="nx-page"><Loading rows={5} /></div>;
  if (current.status === 'error' || current.playlist === undefined) {
    return <div className="nx-page"><ErrorNote message="That playlist could not be opened. It may have been deleted." onRetry={() => void collections.getState().loadPlaylist(playlistId)} /></div>;
  }
  const playlist = current.playlist;
  const source: ListSourceDto = { kind: 'playlist', playlistId };
  const context: PlaybackContextDto = { kind: 'list', source };
  const tracks = current.entries.map((entry) => entry.track);
  return (
    <div className="nx-page" data-testid="view-playlist">
      <Hero cover={<MosaicCover trackIds={playlist.coverTrackIds} seed={playlist.id} size="md" />} kicker="Playlist" title={playlist.name} subtitle={`${plural(playlist.trackCount, 'song')}${playlist.durationSeconds === undefined ? '' : ` · ${formatDuration(playlist.durationSeconds)}`}`}>
        <PlayButtons label={playlist.name} disabled={tracks.length === 0} onPlay={() => actions.playList(source)} onShuffle={() => void playback.getState().setShuffle(true).then(() => actions.playList(source, { shuffle: true }))} />
        <button type="button" className="nx-icon-btn" aria-label="Playlist options" aria-haspopup="menu" data-testid="playlist-options" onClick={(event) => { const r = event.currentTarget.getBoundingClientRect(); actions.showMenuAt(r.left, r.bottom + 4, actions.playlistMenu(playlist)); }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" aria-hidden="true"><path d="M5 12h.01M12 12h.01M19 12h.01" /></svg>
        </button>
      </Hero>
      {tracks.length === 0 ? (
        <Empty icon="playlist" title="This playlist is empty" body="Open any song's ⋯ menu and choose Add to playlist." />
      ) : (
        <TrackList
          tracks={tracks}
          context={context}
          label={`Songs in ${playlist.name}`}
          playlist={{ id: playlistId, name: playlist.name, entryIds: current.entries.map((e) => e.entryId), onMove: (entryId, toIndex) => void collections.getState().moveEntry(playlistId, entryId, toIndex) }}
          onPlayRow={(track, index) => actions.playList(source, { startTrackId: track.id }) ?? void index}
        />
      )}
    </div>
  );
}

export { Cover };
