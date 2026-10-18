import { createStore, type StoreApi } from 'zustand/vanilla';
import type { ChooseWallpaperResponse, NovaBridge, WallpaperDto } from '@nova/shared';

/** The custom wallpaper as the renderer sees it: a data URL (or none) plus the outcome of the last pick. */

export type WallpaperOutcome = Exclude<ChooseWallpaperResponse['outcome'], 'set' | 'cancelled'>;

export const WALLPAPER_MESSAGES: Record<WallpaperOutcome, string> = {
  'unsupported-type': 'That file is not a PNG or JPEG picture.',
  'too-large': 'That picture is larger than 12 MB. Choose a smaller one.',
  'too-small': 'That picture is smaller than 800 x 450 pixels, so it would look blurry. Choose a bigger one.',
  'too-big-dimensions': 'That picture is larger than 10,000 pixels on a side. Choose a smaller one.',
  unreadable: 'That picture could not be read.',
};

export interface WallpaperState {
  readonly wallpaper: WallpaperDto | undefined;
  readonly busy: boolean;
  /** Plain-language result of the last pick (or undefined). */
  readonly message: { readonly text: string; readonly tone: 'ok' | 'error' } | undefined;
  load(): Promise<void>;
  choose(): Promise<void>;
  clear(): Promise<void>;
  dismissMessage(): void;
}
export type WallpaperStoreApi = StoreApi<WallpaperState>;

export function createWallpaperStore(bridge: NovaBridge): WallpaperStoreApi {
  const unreachable = { text: 'Could not reach the application. Try restarting Nova Player.', tone: 'error' as const };
  return createStore<WallpaperState>((set, get) => ({
    wallpaper: undefined,
    busy: false,
    message: undefined,
    async load() {
      try {
        const result = await bridge.invoke('wallpaper:get', undefined);
        if (result.ok) set({ wallpaper: result.value });
      } catch {
        /* no wallpaper is a fine fallback */
      }
    },
    async choose() {
      if (get().busy) return;
      set({ busy: true, message: undefined });
      try {
        const result = await bridge.invoke('wallpaper:choose', undefined);
        if (!result.ok) return void set({ busy: false, message: { text: result.error.message, tone: 'error' } });
        const outcome = result.value.outcome;
        if (outcome === 'set') set({ busy: false, wallpaper: result.value.wallpaper, message: { text: 'Wallpaper updated.', tone: 'ok' } });
        else if (outcome === 'cancelled') set({ busy: false });
        else set({ busy: false, message: { text: WALLPAPER_MESSAGES[outcome], tone: 'error' } });
      } catch {
        set({ busy: false, message: unreachable });
      }
    },
    async clear() {
      try {
        const result = await bridge.invoke('wallpaper:clear', undefined);
        if (result.ok) set({ wallpaper: { status: 'none' }, message: { text: 'Wallpaper removed.', tone: 'ok' } });
        else set({ message: { text: result.error.message, tone: 'error' } });
      } catch {
        set({ message: unreachable });
      }
    },
    dismissMessage() {
      set({ message: undefined });
    },
  }));
}
