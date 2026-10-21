import type { ShellCommand } from '@nova/shared';
import type { MediaKeys } from './media-keys.js';
import type { TrackNotifier } from './track-notifier.js';
import type { TrayController } from './tray-controller.js';
import type { WindowManager } from './window-manager.js';

export interface AppShell {
  /** Brings the shell up: the one window, the tray, the media keys, the track notifications. Idempotent: a second call does nothing. */
  start(): void;
  /** Show / restore / focus the one window (tray click, a second launch, taskbar activation). */
  show(): void;
  /** The user (or the OS) is quitting: closing a window now really closes it. */
  beginQuit(): void;
  /** Releases everything the shell owns: media keys, tray icon, remembered window state. Idempotent. */
  dispose(): void;
  readonly windows: WindowManager;
  readonly tray: TrayController;
  readonly mediaKeys: MediaKeys;
  readonly notifier: TrackNotifier;
  dispatch(command: ShellCommand): boolean;
  /** Tell the player to play one track (the user opened its file from the OS). */
  openTrack(trackId: string): boolean;
}

export function createAppShell(dependencies: {
  readonly windows: WindowManager;
  readonly tray: TrayController;
  readonly mediaKeys: MediaKeys;
  readonly notifier: TrackNotifier;
  readonly dispatch: (command: ShellCommand) => boolean;
  readonly openTrack: (trackId: string) => boolean;
}): AppShell {
  const { windows, tray, mediaKeys, notifier, dispatch, openTrack } = dependencies;
  let started = false;
  let disposed = false;

  return {
    windows,
    tray,
    mediaKeys,
    notifier,
    dispatch,
    openTrack,
    start() {
      if (started || disposed) return;
      started = true;
      windows.show();
      tray.start();
      mediaKeys.start();
      notifier.start();
    },
    show() {
      if (disposed) return;
      windows.show();
    },
    beginQuit() {
      windows.beginQuit();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      // Stop listening and release the media keys first (nothing may reach a half-closed app), then the tray.
      notifier.dispose();
      mediaKeys.dispose();
      tray.dispose();
      windows.dispose();
    },
  };
}
