import type { ShellCommand } from '@nova/shared';

/** One entry of the tray menu, in a form independent of Electron's `Menu`. */
export type TrayMenuItem =
  | { readonly kind: 'item'; readonly id: 'show' | ShellCommand | 'quit'; readonly label: string; readonly click: () => void }
  | { readonly kind: 'separator' };

/** The slice of Electron's `Tray` the controller uses. */
export interface TrayPort {
  setToolTip(text: string): void;
  setMenu(items: readonly TrayMenuItem[]): void;
  onActivate(listener: () => void): void;
  destroy(): void;
  isDestroyed(): boolean;
}

export interface TrayControllerDependencies {
  /** Creates the OS tray icon. Throws when the icon cannot be loaded or the OS refuses a tray. */
  readonly createTray: () => TrayPort;
  readonly tooltip: string;
  /** Show / restore / focus the one main window. */
  readonly onShow: () => void;
  /** A playback command: it goes to the player through the shell command path, never straight to the audio. */
  readonly onCommand: (command: ShellCommand) => void;
  /** The controlled quit path (the same one the rest of the app uses). */
  readonly onQuit: () => void;
  readonly log: (message: string, error: unknown) => void;
}

export interface TrayController {
  /** Creates the tray icon once. Returns whether a tray is active; calling it again never creates a second. */
  start(): boolean;
  isActive(): boolean;
  /** The menu that is installed (for tests and diagnostics). */
  menu(): readonly TrayMenuItem[];
  dispose(): void;
}

export function buildTrayMenu(dependencies: Pick<TrayControllerDependencies, 'onShow' | 'onCommand' | 'onQuit'>): readonly TrayMenuItem[] {
  const { onShow, onCommand, onQuit } = dependencies;
  return [
    { kind: 'item', id: 'show', label: 'Show Nova Player', click: onShow },
    { kind: 'separator' },
    { kind: 'item', id: 'toggle-play', label: 'Play / Pause', click: () => onCommand('toggle-play') },
    { kind: 'item', id: 'next', label: 'Next', click: () => onCommand('next') },
    { kind: 'item', id: 'previous', label: 'Previous', click: () => onCommand('previous') },
    { kind: 'separator' },
    { kind: 'item', id: 'quit', label: 'Quit Nova Player', click: onQuit },
  ];
}

export function createTrayController(dependencies: TrayControllerDependencies): TrayController {
  const { createTray, tooltip, onShow, log } = dependencies;
  let tray: TrayPort | undefined;
  let items: readonly TrayMenuItem[] = [];

  return {
    start() {
      if (tray !== undefined && !tray.isDestroyed()) return true;
      try {
        const created = createTray();
        items = buildTrayMenu(dependencies);
        created.setToolTip(tooltip);
        created.setMenu(items);
        created.onActivate(onShow);
        tray = created;
        return true;
      } catch (error) {
        // No tray (an unsupported desktop, a missing icon) must not stop the app: the window just closes normally.
        log('[nova] the system tray is unavailable:', error);
        tray = undefined;
        items = [];
        return false;
      }
    },
    isActive: () => tray !== undefined && !tray.isDestroyed(),
    menu: () => items,
    dispose() {
      const current = tray;
      tray = undefined;
      items = [];
      if (current === undefined || current.isDestroyed()) return;
      try {
        current.destroy();
      } catch (error) {
        log('[nova] could not remove the tray icon:', error);
      }
    },
  };
}
