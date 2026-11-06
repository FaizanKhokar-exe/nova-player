import { createStore, type StoreApi } from 'zustand/vanilla';
import type { GroupKindDto, PlaylistDto, TrackDto } from '@nova/shared';
import type { IconName } from '../theme/Icon.js';

/**
 * Screen-level UI state that is not data: which page is showing (with back/forward history), the full-screen
 * Now Playing layer, and the transient layers on top (context menu, dialogs, popovers). No business rules live here.
 */

export type Route =
  | { readonly name: 'home' }
  | { readonly name: 'songs' }
  | { readonly name: 'albums' }
  | { readonly name: 'artists' }
  | { readonly name: 'genres' }
  | { readonly name: 'group'; readonly kind: GroupKindDto; readonly key: string }
  | { readonly name: 'favorites' }
  | { readonly name: 'recents' }
  | { readonly name: 'playlists' }
  | { readonly name: 'playlist'; readonly id: string }
  | { readonly name: 'search' }
  | { readonly name: 'settings' };

export const routeKey = (route: Route): string => (route.name === 'group' ? `group:${route.kind}:${route.key}` : route.name === 'playlist' ? `playlist:${route.id}` : route.name);

export type NowPlayingLayout = 'full' | 'lyrics' | 'art';

export type MenuItem =
  | { readonly kind: 'item'; readonly id: string; readonly label: string; readonly icon?: IconName; readonly hint?: string; readonly danger?: boolean; readonly disabled?: boolean; readonly run: () => void }
  | { readonly kind: 'submenu'; readonly id: string; readonly label: string; readonly icon?: IconName; readonly build: () => readonly MenuItem[] }
  | { readonly kind: 'sep' }
  | { readonly kind: 'title'; readonly label: string };

export interface OpenMenu {
  readonly x: number;
  readonly y: number;
  readonly items: readonly MenuItem[];
}

export type Modal =
  | { readonly kind: 'create-playlist'; readonly trackIds: readonly string[] }
  | { readonly kind: 'rename-playlist'; readonly playlist: PlaylistDto }
  | { readonly kind: 'edit-info'; readonly track: TrackDto }
  | { readonly kind: 'add-to-playlist'; readonly trackIds: readonly string[] }
  | { readonly kind: 'confirm'; readonly title: string; readonly body: string; readonly confirmLabel: string; readonly danger?: boolean; readonly onConfirm: () => void };

export type PopoverKind = 'speed' | 'sleep' | 'volume' | 'eq';
export interface OpenPopover {
  readonly kind: PopoverKind;
  /** The anchor button's rectangle, so the popover can sit above it. */
  readonly anchor: { readonly left: number; readonly top: number; readonly width: number; readonly height: number };
}

export interface UiState {
  readonly route: Route;
  readonly history: readonly Route[];
  readonly historyIndex: number;
  readonly nowPlayingOpen: boolean;
  readonly nowPlayingLayout: NowPlayingLayout;
  readonly menu: OpenMenu | undefined;
  readonly modal: Modal | undefined;
  readonly popover: OpenPopover | undefined;
  /** Bumped to ask the search box to take focus (Ctrl+K). */
  readonly searchFocusToken: number;

  navigate(route: Route): void;
  back(): void;
  forward(): void;
  canBack(): boolean;
  canForward(): boolean;
  openNowPlaying(layout?: NowPlayingLayout): void;
  closeNowPlaying(): void;
  setNowPlayingLayout(layout: NowPlayingLayout): void;
  openMenu(menu: OpenMenu): void;
  closeMenu(): void;
  openModal(modal: Modal): void;
  closeModal(): void;
  openPopover(popover: OpenPopover): void;
  closePopover(): void;
  focusSearch(): void;
}
export type UiStoreApi = StoreApi<UiState>;

const HISTORY_LIMIT = 60;
const HOME: Route = { name: 'home' };

export function createUiStore(initial: Route = HOME): UiStoreApi {
  return createStore<UiState>((set, get) => ({
    route: initial,
    history: [initial],
    historyIndex: 0,
    nowPlayingOpen: false,
    nowPlayingLayout: 'full',
    menu: undefined,
    modal: undefined,
    popover: undefined,
    searchFocusToken: 0,

    navigate(route) {
      const { route: current, history, historyIndex } = get();
      if (routeKey(route) === routeKey(current)) return set({ nowPlayingOpen: false, menu: undefined, popover: undefined });
      const kept = [...history.slice(0, historyIndex + 1), route].slice(-HISTORY_LIMIT);
      set({ route, history: kept, historyIndex: kept.length - 1, nowPlayingOpen: false, menu: undefined, popover: undefined });
    },
    back() {
      const { history, historyIndex } = get();
      if (historyIndex <= 0) return;
      set({ route: history[historyIndex - 1] as Route, historyIndex: historyIndex - 1, menu: undefined, popover: undefined });
    },
    forward() {
      const { history, historyIndex } = get();
      if (historyIndex >= history.length - 1) return;
      set({ route: history[historyIndex + 1] as Route, historyIndex: historyIndex + 1, menu: undefined, popover: undefined });
    },
    canBack: () => get().historyIndex > 0,
    canForward: () => get().historyIndex < get().history.length - 1,
    openNowPlaying(layout) {
      set({ nowPlayingOpen: true, menu: undefined, popover: undefined, ...(layout !== undefined && { nowPlayingLayout: layout }) });
    },
    closeNowPlaying: () => set({ nowPlayingOpen: false }),
    setNowPlayingLayout: (nowPlayingLayout) => set({ nowPlayingLayout }),
    openMenu: (menu) => set({ menu, popover: undefined }),
    closeMenu: () => set({ menu: undefined }),
    openModal: (modal) => set({ modal, menu: undefined, popover: undefined }),
    closeModal: () => set({ modal: undefined }),
    openPopover: (popover) => set({ popover, menu: undefined }),
    closePopover: () => set({ popover: undefined }),
    focusSearch: () => set((s) => ({ searchFocusToken: s.searchFocusToken + 1 })),
  }));
}
