import { useLayoutEffect, useRef } from 'react';
import { useStore } from 'zustand';
import { plural } from '../library/format.js';
import { useCollections } from '../collections/CollectionsStoreProvider.js';
import { useLibraryStore } from '../library/LibraryStoreProvider.js';
import { Icon, type IconName } from '../theme/Icon.js';
import { useServices, useUi, useUpdates } from './services.js';
import { routeKey, type Route } from './ui-store.js';

interface Item {
  readonly route: Route;
  readonly label: string;
  readonly icon: IconName;
  readonly count?: number | undefined;
}

/** The left navigation. Collapses to an icon rail (by choice, and automatically in narrow windows). */
export function Sidebar() {
  const { ui, prefs } = useServices();
  const navRef = useRef<HTMLElement | null>(null);
  const barRef = useRef<HTMLSpanElement | null>(null);
  const updateReady = useUpdates((s) => s.status.state === 'available' || s.status.state === 'ready');
  const route = useUi((s) => s.route);
  const collapsed = useStore(prefs, (s) => s.sidebarCollapsed);
  const summary = useLibraryStore((s) => s.summary);
  const playlists = useCollections((s) => s.playlists.items);
  const scanPhase = useLibraryStore((s) => s.scan.phase);
  const progress = useLibraryStore((s) => s.scan.progress);

  const browse: Item[] = [
    { route: { name: 'home' }, label: 'Home', icon: 'home' },
    { route: { name: 'songs' }, label: 'Songs', icon: 'tracks', count: summary?.trackCount },
    { route: { name: 'albums' }, label: 'Albums', icon: 'albums', count: summary?.albumCount },
    { route: { name: 'artists' }, label: 'Artists', icon: 'artists', count: summary?.artistCount },
    { route: { name: 'genres' }, label: 'Genres', icon: 'genres', count: summary?.genreCount },
  ];
  const mine: Item[] = [
    { route: { name: 'favorites' }, label: 'Favorites', icon: 'heart' },
    { route: { name: 'recents' }, label: 'Recently played', icon: 'clock' },
    { route: { name: 'playlists' }, label: 'Playlists', icon: 'playlist', count: playlists.length > 0 ? playlists.length : undefined },
  ];
  const isActive = (item: Route): boolean => {
    if (routeKey(item) === routeKey(route)) return true;
    return item.name === 'albums' && route.name === 'group' && route.kind === 'album' ? true : item.name === 'artists' && route.name === 'group' && route.kind === 'artist' ? true : item.name === 'genres' && route.name === 'group' && route.kind === 'genre' ? true : item.name === 'playlists' && route.name === 'playlist';
  };

  const renderItem = (item: Item) => (
    <button key={routeKey(item.route)} type="button" className="nx-nav-item" aria-current={isActive(item.route) ? 'page' : undefined} aria-label={item.label} data-tip={collapsed ? item.label : undefined} data-testid={`nav-${item.route.name}`} onClick={() => ui.getState().navigate(item.route)}>
      <Icon name={item.icon} size={20} />
      <span className="nx-nav-text">{item.label}</span>
      {item.count !== undefined && <span className="nx-nav-count" data-testid={`nav-${item.route.name}-count`}>{item.count.toLocaleString('en-US')}</span>}
    </button>
  );

  // One accent bar slides from the old page to the new one (transform only), instead of a bar blinking on and off per item.
  useLayoutEffect(() => {
    const nav = navRef.current;
    const bar = barRef.current;
    if (nav === null || bar === null) return;
    const place = (): void => {
      const active = nav.querySelector<HTMLElement>('.nx-nav-item[aria-current="page"]');
      if (active === null) { bar.dataset['on'] = 'false'; return; }
      bar.dataset['on'] = 'true';
      bar.style.transform = `translate3d(0, ${active.offsetTop + active.offsetHeight / 2 - 11}px, 0)`;
    };
    place();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(place);
    observer?.observe(nav);
    return () => observer?.disconnect();
  }, [route, collapsed, playlists.length]);

  const scanning = scanPhase === 'running' || scanPhase === 'starting' || scanPhase === 'cancelling';
  const percent = progress?.total !== undefined && progress.total > 0 ? Math.min(100, Math.round((progress.processed / progress.total) * 100)) : undefined;

  return (
    <nav ref={navRef} className="nx-sidebar" aria-label="Main" data-testid="sidebar">
      <span ref={barRef} className="nx-nav-bar" data-on="false" aria-hidden="true" />
      <div className="nx-brand">
        <div className="nx-brand-mark" aria-hidden="true">N</div>
        <span className="nx-brand-name">Nova Player</span>
      </div>

      {browse.map(renderItem)}
      <div className="nx-nav-label">Your music</div>
      {mine.map(renderItem)}

      <div className="nx-side-foot">
        {scanning && (
          <div className="nx-side-extra" data-testid="scan-status" style={{ padding: '0 6px' }}>
            <div className="nx-progress" role="progressbar" aria-label="Scanning" aria-valuenow={percent ?? undefined}><i style={{ width: `${percent ?? 35}%` }} /></div>
            <span className="nx-faint" style={{ fontSize: 12 }}>{progress === undefined ? 'Starting scan…' : `Scanning… ${plural(progress.processed, 'file')}`}</span>
          </div>
        )}
        <button type="button" className="nx-nav-item" aria-current={route.name === 'settings' ? 'page' : undefined} aria-label="Settings" data-testid="nav-settings" onClick={() => ui.getState().navigate({ name: 'settings' })}>
          <Icon name="settings" size={20} />
          <span className="nx-nav-text">Settings</span>
          {updateReady && <span className="nx-nav-dot" data-testid="update-dot" role="img" aria-label="An update is available" />}
        </button>
        <button type="button" className="nx-nav-item" aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} data-testid="sidebar-toggle" onClick={() => prefs.getState().setSidebarCollapsed(!collapsed)}>
          <Icon name={collapsed ? 'chevronRight' : 'chevronLeft'} size={20} />
          <span className="nx-nav-text">Collapse</span>
        </button>
      </div>
    </nav>
  );
}
