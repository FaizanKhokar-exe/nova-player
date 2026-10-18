import { useEffect } from 'react';
import type { GroupDto, GroupKindDto, PlaybackContextDto } from '@nova/shared';
import { formatDuration, plural } from '../../library/format.js';
import { useLibraryStore } from '../../library/LibraryStoreProvider.js';
import { useActions } from '../actions.js';
import { Cover } from '../Cover.js';
import { Empty, ErrorNote, Hero, Loading, PlayButtons, Tile } from '../parts.js';
import { useServices } from '../services.js';
import { TrackList } from '../TrackList.js';

export function SongsView() {
  const { library } = useServices();
  const tracks = useLibraryStore((s) => s.tracks);
  const status = useLibraryStore((s) => s.tracksStatus);
  const error = useLibraryStore((s) => s.tracksError);
  const sort = useLibraryStore((s) => s.sort);
  const roots = useLibraryStore((s) => s.roots.length);
  const actions = useActions();

  useEffect(() => library.getState().setView('tracks'), [library]);

  const context: PlaybackContextDto = { kind: 'library', sort };
  return (
    <div className="nx-page" data-testid="view-songs">
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
        <h1 className="nx-h1">Songs</h1>
        <span className="nx-muted">{plural(tracks.length, 'song')}</span>
      </div>
      {error !== undefined && <ErrorNote message={error.message} onRetry={() => library.getState().retryBrowse()} />}
      {status === 'loading' && tracks.length === 0 ? (
        <Loading />
      ) : tracks.length === 0 ? (
        <Empty icon="tracks" title={roots === 0 ? 'Add your music' : 'No songs yet'} body={roots === 0 ? 'Choose the folder where your music lives and Nova Player will find every song.' : 'Run a scan to pick up the songs in your folders.'}>
          {roots === 0 ? <button type="button" className="nx-btn nx-btn--primary" onClick={() => void library.getState().addRoot()}>Add folder</button> : <button type="button" className="nx-btn nx-btn--primary" onClick={() => void library.getState().startScan()}>Scan now</button>}
        </Empty>
      ) : (
        <TrackList tracks={tracks} context={context} label="All songs" sort={{ value: sort, onChange: (next) => library.getState().setSort(next) }} onPlayRow={(track) => actions.playTrack(track.id, context)} />
      )}
    </div>
  );
}

const KIND_VIEW = { album: 'albums', artist: 'artists', genre: 'genres' } as const;
const KIND_TITLE = { album: 'Albums', artist: 'Artists', genre: 'Genres' } as const;

function groupSubtitle(group: GroupDto): string {
  if (group.kind === 'album') return [group.artist, group.year === undefined ? undefined : String(group.year)].filter((part): part is string => part !== undefined && part !== '').join(' · ');
  if (group.kind === 'artist') return group.albumCount === undefined ? plural(group.trackCount, 'song') : `${plural(group.albumCount, 'album')} · ${plural(group.trackCount, 'song')}`;
  return plural(group.trackCount, 'song');
}

export function GroupTile({ group }: { group: GroupDto }) {
  const actions = useActions();
  return (
    <Tile
      testId="group-tile"
      cover={<Cover trackId={group.coverTrackId} seed={group.key} size="md" round={group.kind === 'artist'} label="" />}
      title={group.name}
      subtitle={groupSubtitle(group)}
      onOpen={() => actions.go({ name: 'group', kind: group.kind, key: group.key })}
      onPlay={() => actions.playGroup(group)}
      onMenu={(event) => actions.showMenuAt(event.clientX, event.clientY, actions.groupMenu(group))}
    />
  );
}

export function GroupsView({ kind }: { kind: GroupKindDto }) {
  const { library } = useServices();
  const groups = useLibraryStore((s) => s.groups);
  useEffect(() => library.getState().setView(KIND_VIEW[kind]), [library, kind]);
  const ready = groups.kind === kind;
  const items = ready ? groups.items : [];
  return (
    <div className="nx-page" data-testid={`view-${KIND_VIEW[kind]}`}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
        <h1 className="nx-h1">{KIND_TITLE[kind]}</h1>
        <span className="nx-muted">{ready && groups.status === 'ready' ? plural(items.length, kind) : ''}</span>
      </div>
      {groups.error !== undefined && ready && <ErrorNote message={groups.error.message} onRetry={() => library.getState().retryBrowse()} />}
      {!ready || (groups.status === 'loading' && items.length === 0) ? (
        <div className="nx-grid" role="status" aria-label="Loading">{Array.from({ length: 12 }, (_, i) => <div key={i} className="nx-skeleton" style={{ aspectRatio: '0.85' }} />)}</div>
      ) : items.length === 0 ? (
        <Empty icon={kind === 'artist' ? 'artists' : kind === 'genre' ? 'genres' : 'albums'} title={`No ${KIND_TITLE[kind].toLowerCase()} yet`} body="Add a music folder and scan it to fill your library." />
      ) : (
        <div className={`nx-grid nx-grid--${kind}s`} data-testid="group-grid">
          {items.map((group) => <GroupTile key={group.key} group={group} />)}
        </div>
      )}
    </div>
  );
}

export function GroupDetailView({ kind, groupKey }: { kind: GroupKindDto; groupKey: string }) {
  const { library, playback } = useServices();
  const detail = useLibraryStore((s) => s.detail);
  const selection = useLibraryStore((s) => s.selection);
  const actions = useActions();
  useEffect(() => library.getState().selectGroup({ kind, key: groupKey }), [library, kind, groupKey]);

  const loaded = selection?.key === groupKey && selection.kind === kind;
  const group = loaded ? detail.group : undefined;
  const context: PlaybackContextDto = { kind: 'group', group: { kind, key: groupKey } };
  const ref = { kind, key: groupKey, name: group?.name ?? '' };

  if (!loaded || (detail.status === 'loading' && group === undefined)) return <div className="nx-page"><Loading /></div>;
  if (detail.error !== undefined || group === undefined) {
    return <div className="nx-page"><ErrorNote message={detail.error?.message ?? 'That item is no longer in your library.'} onRetry={() => library.getState().retryBrowse()} /></div>;
  }
  const coverId = group.coverTrackId ?? detail.tracks[0]?.id;
  const subtitle = [kind === 'album' ? group.artist : undefined, group.year === undefined ? undefined : String(group.year), plural(group.trackCount, 'song'), group.durationSeconds === undefined ? undefined : formatDuration(group.durationSeconds)].filter((part): part is string => part !== undefined && part !== '').join(' · ');
  return (
    <div className="nx-page" data-testid="view-group">
      <Hero cover={<Cover trackId={coverId} seed={groupKey} size="md" round={kind === 'artist'} label="" />} kicker={kind === 'album' ? 'Album' : kind === 'artist' ? 'Artist' : 'Genre'} title={group.name} subtitle={subtitle} round={kind === 'artist'}>
        <PlayButtons label={group.name} disabled={detail.tracks.length === 0} onPlay={() => actions.playGroup(ref)} onShuffle={() => void playback.getState().setShuffle(true).then(() => actions.playGroup(ref))} />
        <button type="button" className="nx-btn" onClick={() => actions.queueGroup(ref, 'last')}>Add to queue</button>
      </Hero>
      {detail.tracks.length === 0 ? <Empty icon="tracks" title="Nothing here" body="These songs are no longer in your library." /> : <TrackList tracks={detail.tracks} context={context} label={`Songs in ${group.name}`} />}
    </div>
  );

}

export function SearchView() {
  const query = useLibraryStore((s) => s.query);
  const search = useLibraryStore((s) => s.search);
  const actions = useActions();
  const { library } = useServices();
  const tracks = search.results.map((r) => r.track);
  const trimmed = query.trim();
  const context: PlaybackContextDto = { kind: 'search', query: search.query };
  return (
    <div className="nx-page" data-testid="view-search">
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
        <h1 className="nx-h1 nx-clamp-2 nx-text">{trimmed === '' ? 'Search' : `Results for “${trimmed}”`}</h1>
        {search.status === 'ready' && <span className="nx-muted">{plural(search.total, 'song')}</span>}
      </div>
      {search.error !== undefined && <ErrorNote message={search.error.message} onRetry={() => library.getState().setQuery(query)} />}
      {trimmed === '' ? (
        <Empty icon="search" title="Find anything" body="Type a song, an artist or an album. Press Ctrl+K from anywhere to jump here." />
      ) : search.status === 'loading' && tracks.length === 0 ? (
        <Loading rows={6} />
      ) : tracks.length === 0 && search.status === 'ready' ? (
        <Empty icon="search" title="No matches" body={`Nothing in your library matches “${trimmed}”. Check the spelling or try fewer words.`} />
      ) : (
        <TrackList tracks={tracks} context={context} label="Search results" onPlayRow={(track) => actions.playTrack(track.id, context)} />
      )}
    </div>
  );
}

