import { useEffect } from 'react';
import { plural } from '../../library/format.js';
import { useCollections } from '../../collections/CollectionsStoreProvider.js';
import { useLibraryStore } from '../../library/LibraryStoreProvider.js';
import { useActions, addFolderAndScan } from '../actions.js';
import { Cover } from '../Cover.js';
import { Empty, SectionHead, Tile } from '../parts.js';
import { useServices } from '../services.js';
import { GroupTile } from './browse.js';

function greeting(hour: number): string {
  if (hour < 5) return 'Late night listening';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/** The landing page: where you left off, your favourites, your albums - and a clear first step on an empty library. */
export function HomeView() {
  const { library, collections, playback } = useServices();
  const actions = useActions();
  const summary = useLibraryStore((s) => s.summary);
  const roots = useLibraryStore((s) => s.roots);
  const tracks = useLibraryStore((s) => s.tracks);
  const groups = useLibraryStore((s) => s.groups);
  const history = useCollections((s) => s.history);
  const favorites = useCollections((s) => s.favorites);

  useEffect(() => {
    library.getState().setView('albums');
    void collections.getState().loadHistory();
    void collections.getState().loadFavorites();
  }, [library, collections]);

  const hasMusic = (summary?.trackCount ?? 0) > 0;
  const albums = groups.kind === 'album' ? groups.items.slice(0, 16) : [];

  if (roots.length === 0 && !hasMusic) {
    return (
      <div className="nx-page" data-testid="view-home">
        <Empty icon="folder" title="Welcome to Nova Player" body="Choose the folder where your music lives. Nova Player reads your files, your covers and your lyrics - nothing is uploaded anywhere.">
          <button type="button" className="nx-btn nx-btn--primary" data-testid="home-add-folder" onClick={() => void addFolderAndScan(library)}>Add music folder</button>
        </Empty>
      </div>
    );
  }

  // Shuffle on, then start the library: main builds the shuffled order (the renderer never picks or orders tracks).
  const shuffleAll = (): void => {
    const first = tracks[0];
    if (first === undefined) return;
    void playback.getState().setShuffle(true).then(() => actions.playTrack(first.id, { kind: 'library' }));
  };

  return (
    <div className="nx-page" data-testid="view-home">
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <h1 className="nx-greeting">{greeting(new Date().getHours())}</h1>
          <span className="nx-muted" data-testid="home-summary">
            {summary === undefined ? '' : `${plural(summary.trackCount, 'song')} · ${plural(summary.albumCount, 'album')} · ${plural(summary.artistCount, 'artist')}`}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button type="button" className="nx-btn nx-btn--primary" disabled={tracks.length === 0} data-testid="home-shuffle" onClick={shuffleAll}>Shuffle all</button>
          <button type="button" className="nx-btn" onClick={() => actions.go({ name: 'songs' })}>Browse songs</button>
        </div>
      </div>

      {history.items.length > 0 && (
        <section data-testid="home-recents">
          <SectionHead title="Jump back in" action={<button type="button" className="nx-link" onClick={() => actions.go({ name: 'recents' })}>Show all</button>} />
          <div className="nx-shelf">
            {history.items.slice(0, 12).map((item) => (
              <Tile
                key={item.track.id}
                testId="recent-tile"
                cover={<Cover trackId={item.track.id} seed={item.track.album ?? item.track.title} size="md" label="" />}
                title={item.track.title}
                subtitle={item.track.artist}
                onOpen={() => actions.playList({ kind: 'history' }, { startTrackId: item.track.id })}
                onPlay={() => actions.playList({ kind: 'history' }, { startTrackId: item.track.id })}
                onMenu={(event) => actions.showMenuAt(event.clientX, event.clientY, actions.trackMenu(item.track, { context: { kind: 'list', source: { kind: 'history' } } }))}
              />
            ))}
          </div>
        </section>
      )}

      {favorites.tracks.length > 0 && (
        <section data-testid="home-favorites">
          <SectionHead title="Your favorites" action={<button type="button" className="nx-link" onClick={() => actions.go({ name: 'favorites' })}>Show all</button>} />
          <div className="nx-shelf">
            {favorites.tracks.slice(0, 12).map((track) => (
              <Tile
                key={track.id}
                testId="favorite-tile"
                cover={<Cover trackId={track.id} seed={track.album ?? track.title} size="md" label="" />}
                title={track.title}
                subtitle={track.artist}
                onOpen={() => actions.playList({ kind: 'favorites' }, { startTrackId: track.id })}
                onPlay={() => actions.playList({ kind: 'favorites' }, { startTrackId: track.id })}
                onMenu={(event) => actions.showMenuAt(event.clientX, event.clientY, actions.trackMenu(track, { context: { kind: 'list', source: { kind: 'favorites' } } }))}
              />
            ))}
          </div>
        </section>
      )}

      {albums.length > 0 && (
        <section data-testid="home-albums">
          <SectionHead title="Albums" action={<button type="button" className="nx-link" onClick={() => actions.go({ name: 'albums' })}>Show all</button>} />
          <div className="nx-shelf">
            {albums.map((group) => <GroupTile key={group.key} group={group} />)}
          </div>
        </section>
      )}

      {history.items.length === 0 && favorites.tracks.length === 0 && albums.length === 0 && hasMusic === false && (
        <Empty icon="tracks" title="Your library is empty" body="Run a scan to pick up the songs in your folders.">
          <button type="button" className="nx-btn nx-btn--primary" onClick={() => void library.getState().startScan()}>Scan now</button>
        </Empty>
      )}
    </div>
  );
}
