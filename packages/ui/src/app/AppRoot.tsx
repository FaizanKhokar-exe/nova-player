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
import { LyricStudio } from '../lyricstudio/LyricStudio.js';
import { ContextMenuLayer, ModalLayer, PopoverLayer, ToastLayer } from './overlays.js';
import { ScrollContext } from './scroll.js';
import { SPEEDS } from '../prefs/prefs-store.js';
import { resolveShortcut } from './shortcuts.js';
import { Tooltips } from './Tooltips.js';
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

export const IDLE_CURSOR_MS = 2500;

/** Window fullscreen through the page itself (Electron maps the standard Fullscreen API onto the window): no extra IPC. */
function toggleFullscreen(): void {
  if (document.fullscreenElement !== null) void document.exitFullscreen().catch(() => undefined);
  else void document.documentElement.requestFullscreen().catch(() => undefined);
}

const isTyping = (target: EventTarget | null): boolean => {
  const el = target as HTMLElement | null;
  return el !== null && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable === true);
};

/** Global effects: engine + visuals follow playback, preferences, shortcuts. Renders nothing. */
function AppEffects() {
  const { engine, visuals, audioControls, collections, wallpaper, playback, ui, prefs, nowPlaying, studio } = useServices();
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
      if (studio.getState().open) return; // Lyric Studio owns the keyboard while it is open
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
      const el = event.target as HTMLElement;
      const action = resolveShortcut({ key, ctrl, shift: event.shiftKey, alt: event.altKey });
      if (action === undefined) return;
      const s = ui.getState();
      // Keys that a focused control or list already uses for itself are left to it.
      const ownControl = el.closest('[role="slider"], [role="menu"], [role="listbox"], select') !== null || el.tagName === 'SELECT' || (el as HTMLInputElement).type === 'range';
      const inList = el.closest('[data-row-index]') !== null; // up/down walk the song list; left/right are free for seeking
      if (s.modal !== undefined || s.menu !== undefined) return;
      const p = playback.getState();
      const state = p;
      switch (action.kind) {
        case 'togglePlay': if (el.tagName === 'BUTTON') return; event.preventDefault(); void p.togglePlay(); return;
        case 'next': event.preventDefault(); void p.next(); return;
        case 'previous': event.preventDefault(); void p.previous(); return;
        case 'seek': if (ownControl || state.session?.current === undefined) return; event.preventDefault(); p.seekMs(Math.max(0, state.positionStore.getState().positionMs + action.deltaSeconds * 1000)); return;
        case 'volume': if (ownControl || inList) return; event.preventDefault(); p.setVolume(Math.min(1, Math.max(0, Math.round((state.engine.volume + action.delta) * 100) / 100))); return;
        case 'seekPercent': { const duration = state.engine.durationMs; if (duration === undefined || state.session?.current === undefined) return; p.seekMs(Math.round((duration * action.percent) / 100)); return; }
        case 'mute': p.toggleMute(); return;
        case 'shuffle': void p.setShuffle(!(state.session?.shuffle ?? false)); return;
        case 'repeat': void p.cycleRepeatMode(); return;
        case 'queue': p.setQueueOpen(!state.queue.open); return;
        case 'lyrics': if (s.nowPlayingOpen && s.nowPlayingLayout === 'lyrics') s.closeNowPlaying(); else s.openNowPlaying('lyrics'); return;
        case 'fullscreen': event.preventDefault(); toggleFullscreen(); return;
        case 'favorite': { const id = state.session?.current?.track.id; if (id !== undefined) void collections.getState().toggleFavorite(id); return; }
        case 'settings': event.preventDefault(); s.navigate({ name: 'settings' }); return;
        case 'speedUp':
        case 'speedDown': {
          const index = SPEEDS.indexOf(prefs.getState().speed as (typeof SPEEDS)[number]);
          const next = SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, (index < 0 ? SPEEDS.indexOf(1) : index) + (action.kind === 'speedUp' ? 1 : -1)))];
          if (next !== undefined) prefs.getState().setSpeed(next);
          return;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ui, playback, prefs, collections, studio]);

  // The .lrc may be edited in another program: when the window comes back to the front, the lyrics are re-read (silently, only if they changed).
  useEffect(() => {
    const refresh = () => void nowPlaying.getState().refreshLyrics();
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [nowPlaying]);

  // Double-click on empty window space toggles fullscreen.
  useEffect(() => {
    const onDouble = (event: MouseEvent) => {
      const el = event.target as HTMLElement;
      if (el.closest('button, input, a, select, textarea, [role="slider"], [data-row-index], .nx-tile-wrap, .nx-lyric, .nx-queue, .nx-dock, .nx-menu, .nx-modal, .nx-popover, [data-no-fullscreen]') !== null) return;
      toggleFullscreen();
    };
    window.addEventListener('dblclick', onDouble);
    return () => window.removeEventListener('dblclick', onDouble);
  }, []);

  // The pointer disappears after a few quiet seconds in Now Playing or fullscreen, and comes back on movement.
  const npOpen = useUi((s) => s.nowPlayingOpen);
  useEffect(() => {
    const root = document.documentElement;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastReset = 0;
    const show = (event?: Event) => {
      // Mouse moves arrive hundreds of times a second: re-arm the timer at most every 150 ms (and always when the pointer was hidden).
      const at = Date.now();
      if (event?.type === 'mousemove' && root.dataset.idle !== 'true' && at - lastReset < 150) return;
      lastReset = at;
      root.dataset.idle = 'false';
      if (timer !== undefined) clearTimeout(timer);
      if (npOpen || document.fullscreenElement !== null) timer = setTimeout(() => { root.dataset.idle = 'true'; }, IDLE_CURSOR_MS);
    };
    show();
    window.addEventListener('mousemove', show);
    window.addEventListener('mousedown', show);
    window.addEventListener('keydown', show);
    return () => {
      window.removeEventListener('mousemove', show);
      window.removeEventListener('mousedown', show);
      window.removeEventListener('keydown', show);
      if (timer !== undefined) clearTimeout(timer);
      root.dataset.idle = 'false';
    };
  }, [npOpen]);
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
      <LyricStudio />
      <ToastLayer />
      <Tooltips />
    </div>
  );
}
