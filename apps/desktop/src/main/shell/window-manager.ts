import { type Rect, type ShellState, type ShellStateStore, type WindowState } from './shell-state.js';

/** What the window manager needs from a window. `BrowserWindow` satisfies it; tests use a fake. */
export interface ManagedWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  isVisible(): boolean;
  isMaximized(): boolean;
  getNormalBounds(): Rect;
  restore(): void;
  show(): void;
  hide(): void;
  focus(): void;
  on(event: 'close', listener: (event: { preventDefault(): void }) => void): unknown;
  on(event: 'closed', listener: () => void): unknown;
}

export interface WindowManagerDependencies {
  /** Builds the one window, from the (already sanitised) remembered state. */
  readonly createWindow: (state: WindowState) => ManagedWindow;
  readonly stateStore: ShellStateStore;
  readonly displays: () => readonly Rect[];
  /** True when closing the window should hide it (a tray exists and the preference is on). */
  readonly shouldHideOnClose: () => boolean;
  readonly log: (message: string, error: unknown) => void;
}

export interface WindowManager {
  /** Shows the one main window: creates it if there is none, otherwise restores / shows / focuses it. Never makes a second. */
  show(): ManagedWindow;
  current(): ManagedWindow | undefined;
  /** From now on a close really closes (the user chose Quit): the hide-to-tray policy stops applying. */
  beginQuit(): void;
  isQuitting(): boolean;
  /** Remembers the window's geometry now. */
  saveState(): void;
  /** Persisted preference (the close-to-tray choice lives next to the window state). */
  readonly preferences: { closeToTray(): boolean };
  dispose(): void;
}

/**
 * Owns the single main window's lifecycle: creation, show/restore/focus, hide-on-close, and
 * remembering its geometry. Every path that wants the window (tray click, a second launch, the
 * dock/taskbar activation, the first start) goes through `show()`, so there is only ever one.
 */
export function createWindowManager(dependencies: WindowManagerDependencies): WindowManager {
  const { createWindow, stateStore, displays, shouldHideOnClose, log } = dependencies;
  let state: ShellState = stateStore.load(displays());
  let window: ManagedWindow | undefined;
  let quitting = false;
  let disposed = false;

  function persist(): void {
    if (window === undefined || window.isDestroyed()) return;
    const bounds = window.getNormalBounds();
    const maximized = window.isMaximized();
    state = {
      ...state,
      window: { width: bounds.width, height: bounds.height, x: bounds.x, y: bounds.y, maximized },
    };
    stateStore.save(state);
  }

  function create(): ManagedWindow {
    const created = createWindow(state.window);
    // These listeners belong to THIS window object and die with it; a recreated window gets its own, once.
    created.on('close', (event) => {
      persist();
      if (!quitting && shouldHideOnClose()) {
        event.preventDefault();
        created.hide();
      }
    });
    created.on('closed', () => {
      if (window === created) window = undefined;
    });
    return created;
  }

  return {
    show() {
      if (disposed) throw new Error('The window manager was disposed.');
      if (window === undefined || window.isDestroyed()) window = create();
      const target = window;
      try {
        if (target.isMinimized()) target.restore();
        if (!target.isVisible()) target.show();
        target.focus();
      } catch (error) {
        log('[nova] could not bring the window to the front:', error);
      }
      return target;
    },
    current: () => (window === undefined || window.isDestroyed() ? undefined : window),
    beginQuit() {
      quitting = true;
    },
    isQuitting: () => quitting,
    saveState: persist,
    preferences: { closeToTray: () => state.closeToTray },
    dispose() {
      if (disposed) return;
      disposed = true;
      persist();
    },
  };
}
