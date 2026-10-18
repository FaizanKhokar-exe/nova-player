import { useEffect, useRef, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { LibraryStoreProvider } from '../library/LibraryStoreProvider.js';
import { NowPlayingStoreProvider } from '../nowplaying/NowPlayingStoreProvider.js';
import { PlaybackStoreProvider, usePlaybackStore } from '../playback/PlaybackStoreProvider.js';
import { CollectionsStoreProvider } from '../collections/CollectionsStoreProvider.js';
import { ThemeController, ThemeStoreProvider } from '../theme/ThemeProvider.js';
import { Dock } from './Dock.js';
import { NowPlayingScreen } from './NowPlaying.js';
import { QueueDrawer } from './QueueDrawer.js';
import { Sidebar } from './Sidebar.js';
import { Topbar } from './Topbar.js';
import { ContextMenuLayer, ModalLayer, PopoverLayer, ToastLayer } from './overlays.js';
import { ScrollContext } from './scroll.js';
import { ServicesProvider, usePrefs, useServices, useUi, type AppServices } from './services.js';
import type { Route } from './ui-store.js';
import { HomeView } from './views/Home.js';
import { SettingsView } from './views/Settings.js';
import { GroupDetailView, GroupsView, SearchView, SongsView } from './views/browse.js';
import { FavoritesView, PlaylistsView, PlaylistView, RecentsView } from './views/collections.js';

/** Every provider the screens need, from the services the entry point built. */
export function AppProviders({ services, children }: { services: AppServices; children: ReactNode }) {
  return (
    <ServicesProvider services={services}>
      <LibraryStoreProvider store={services.library}>
        <PlaybackStoreProvider store={services.playback}>
          <NowPlayingStoreProvider store={services.nowPlaying}>
            <ThemeStoreProvider store={services.theme}>
              <CollectionsStoreProvider store={services.collections}>{children}</CollectionsStoreProvider>
            </ThemeStoreProvider>
          </NowPlayingStoreProvider>
        </PlaybackStoreProvider>
      </LibraryStoreProvider>
    </ServicesProvider>
  );
}

function RouteView({ route }: { route: Route }) {
  switch (route.name) {
    case 'home': return <HomeView />;
    case 'songs': return <SongsView />;
    case 'albums': return <GroupsView kind="album" />;
    case 'artists': return <GroupsView kind="artist" />;
    case 'genres': return <GroupsView kind="genre" />;
    case 'group': return <GroupDetailView kind={route.kind} groupKey={route.key} />;
    case 'favorites': return <FavoritesView />;
    case 'recents': return <RecentsView />;
    case 'playlists': return <PlaylistsView />;
    case 'playlist': return <PlaylistView playlistId={route.id} />;
    case 'search': return <SearchView />;
    case 'settings': return <SettingsView />;
  }
}

const isTyping = (target: EventTarget | null): boolean => {
  const el = target as HTMLElement | null;
  return el !== null && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable === true);
};

/** Global effects: engine + visuals follow playback, preferences, shortcuts. Renders nothing. */
function AppEffects() {
  const { engine, visuals, audioControls, collections, wallpaper, playback, ui, prefs } = useServices();
  const playing = usePlaybackStore((s) => s.engine.playing);
  const performance = usePrefs((s) => s.performance);

  useEffect(() => {
    collections.getState().connect();
    void wallpaper.getState().load();
  }, [collections, wallpaper]);
  useEffect(() => { visuals.setPlaying(playing); if (playing) audioControls.getState().activateEngine(); }, [playing, visuals, audioControls, engine]);
  useEffect(() => { visuals.setMode(performance); }, [performance, visuals]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const key = event.key;
      const ctrl = event.ctrlKey || event.metaKey;
      if (ctrl && key.toLowerCase() === 'k') { event.preventDefault(); ui.getState().navigate({ name: 'search' }); ui.getState().focusSearch(); return; }
      if (key === 'Escape') {
        const s = ui.getState();
        if (s.modal !== undefined) s.closeModal();
        else if (s.menu !== undefined) s.closeMenu();
        else if (s.popover !== undefined) s.closePopover();
        else if (s.nowPlayingOpen) s.closeNowPlaying();
        else if (playback.getState().queue.open) playback.getState().setQueueOpen(false);
        return;
      }
      if (event.altKey && key === 'ArrowLeft') { event.preventDefault(); ui.getState().back(); return; }
      if (event.altKey && key === 'ArrowRight') { event.preventDefault(); ui.getState().forward(); return; }
      if (isTyping(event.target)) return;
      const p = playback.getState();
      if (ctrl && key === 'ArrowRight') { event.preventDefault(); void p.next(); }
      else if (ctrl && key === 'ArrowLeft') { event.preventDefault(); void p.previous(); }
      else if (key === ' ' && !ctrl && (event.target as HTMLElement).tagName !== 'BUTTON') { event.preventDefault(); void p.togglePlay(); }
      else if (!ctrl && key.toLowerCase() === 'l') { const s = ui.getState(); if (s.nowPlayingOpen && s.nowPlayingLayout === 'lyrics') s.closeNowPlaying(); else s.openNowPlaying('lyrics'); }
      else if (!ctrl && key.toLowerCase() === 'm') { p.toggleMute(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ui, playback, prefs]);
  return null;
}

/** The whole application screen. */
export function AppRoot() {
  const { prefs, wallpaper: wallpaperStore, ui } = useServices();
  const route = useUi((s) => s.route);
  const collapsed = useStore(prefs, (s) => s.sidebarCollapsed);
  const wallpaperEnabled = useStore(prefs, (s) => s.wallpaperEnabled);
  const dim = useStore(prefs, (s) => s.wallpaperDim);
  const blur = useStore(prefs, (s) => s.wallpaperBlur);
  const wallpaper = useStore(wallpaperStore, (s) => s.wallpaper);
  const scroll = useRef<HTMLDivElement | null>(null);
  const showWallpaper = wallpaperEnabled && wallpaper?.status === 'set';

  // Each page starts at the top.
  useEffect(() => { scroll.current?.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior }); }, [route]);

  return (
    <div className="nx-app" data-testid="app-shell" data-collapsed={collapsed ? 'true' : 'false'} data-wallpaper={showWallpaper ? 'true' : 'false'} onContextMenu={(event) => { if (!(event.target as HTMLElement).closest('[data-allow-native-menu]')) event.preventDefault(); }}>
      <ThemeController />
      <AppEffects />
      <div className="nx-backdrop" aria-hidden="true">
        {showWallpaper && wallpaper !== undefined && wallpaper.status === 'set' && (
          <>
            <div className="nx-wallpaper" data-testid="wallpaper-layer" style={{ backgroundImage: `url("${wallpaper.dataUrl}")`, filter: `blur(${blur}px)` }} />
            <div className="nx-wallpaper-dim" style={{ opacity: dim / 100 }} />
          </>
        )}
        <div className="nx-glow" />
      </div>
      <Sidebar />
      <main className="nx-content">
        <Topbar />
        <ScrollContext.Provider value={scroll}>
          <div className="nx-scroll" ref={scroll} data-testid="main-scroll" key={ui.getState().route.name}>
            <RouteView route={route} />
          </div>
        </ScrollContext.Provider>
        <QueueDrawer />
      </main>
      <Dock />
      <NowPlayingScreen />
      <PopoverLayer />
      <ContextMenuLayer />
      <ModalLayer />
      <ToastLayer />
    </div>
  );
}
