import type { ShellCommand } from '@nova/shared';

/** The OS media keys Electron can register as global shortcuts, and the player command each one is. */
export const MEDIA_KEY_BINDINGS = [
  { accelerator: 'MediaPlayPause', command: 'toggle-play' },
  { accelerator: 'MediaNextTrack', command: 'next' },
  { accelerator: 'MediaPreviousTrack', command: 'previous' },
] as const satisfies readonly { readonly accelerator: string; readonly command: ShellCommand }[];

/** The slice of Electron's `globalShortcut` used here. */
export interface GlobalShortcutPort {
  /** Returns false when the key is taken by another application or unsupported. */
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
  isRegistered(accelerator: string): boolean;
}

export interface MediaKeysResult {
  readonly registered: readonly string[];
  readonly failed: readonly string[];
}

export interface MediaKeys {
  /** Registers the media keys once. A second call changes nothing and returns the first result. */
  start(): MediaKeysResult;
  /** Unregisters exactly what this instance registered. */
  dispose(): void;
}

export function createMediaKeys(options: {
  readonly globalShortcut: GlobalShortcutPort;
  readonly dispatch: (command: ShellCommand) => void;
  readonly log: (message: string, error: unknown) => void;
}): MediaKeys {
  const { globalShortcut, dispatch, log } = options;
  let result: MediaKeysResult | undefined;
  let owned: string[] = [];

  return {
    start() {
      if (result !== undefined) return result;
      const registered: string[] = [];
      const failed: string[] = [];
      for (const { accelerator, command } of MEDIA_KEY_BINDINGS) {
        try {
          if (globalShortcut.register(accelerator, () => dispatch(command))) registered.push(accelerator);
          else {
            failed.push(accelerator);
            log(`[nova] media key ${accelerator} is unavailable (another application may own it):`, undefined);
          }
        } catch (error) {
          failed.push(accelerator);
          log(`[nova] media key ${accelerator} could not be registered:`, error);
        }
      }
      owned = registered;
      result = { registered, failed };
      return result;
    },
    dispose() {
      const toRelease = owned;
      owned = [];
      for (const accelerator of toRelease) {
        try {
          globalShortcut.unregister(accelerator);
        } catch (error) {
          log(`[nova] could not release media key ${accelerator}:`, error);
        }
      }
    },
  };
}
