import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, globalShortcut, Menu, nativeImage, Notification, screen, shell, Tray } from 'electron';
import { is } from '@electron-toolkit/utils';
import type { PlaybackApplication } from '@nova/infrastructure';
import { createAppShell, type AppShell } from './app-shell.js';
import { resolveAppLocation } from './app-location.js';
import { createCommandDispatcher } from './command-dispatcher.js';
import { createMediaKeys } from './media-keys.js';
import { createShellStateStore, WINDOW_MIN_HEIGHT, WINDOW_MIN_WIDTH, type ShellStateFileIo, type WindowState } from './shell-state.js';
import { createTrackNotifier, type NotificationPort } from './track-notifier.js';
import { createTrayController, type TrayMenuItem, type TrayPort } from './tray-controller.js';
import { createWindowManager } from './window-manager.js';
import { buildThumbarButtons } from './thumbar.js';
import { applyWindowPolicy, isAppPage } from './window-policy.js';

export interface ElectronShellOptions {
  /** The playback application's event stream (`PlaybackApplication.subscribe`); the shell listens for started tracks. */
  readonly playbackEvents: Pick<PlaybackApplication, 'subscribe'>;
  /** Absolute folder this build's `index.js` runs from (`out/main`). */
  readonly mainDir: string;
  readonly log: (message: string, error: unknown) => void;
}

/**
 * Where the packaged application icon files live. In a packaged app electron-builder copies
 * `resources/` next to the app (`extraResources`); from a source checkout they are in
 * `apps/desktop/resources`. Either way the file is part of the app - never a remote or ad-hoc path.
 */
export function resourcePath(mainDir: string, fileName: string): string {
  return app.isPackaged ? path.join(process.resourcesPath, fileName) : path.resolve(mainDir, '../../resources', fileName);
}

const fileIo: ShellStateFileIo = {
  readFile(filePath) {
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  },
  writeFileAtomic(filePath, contents) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temp = `${filePath}.tmp`;
    fs.writeFileSync(temp, contents, 'utf8');
    fs.renameSync(temp, filePath);
  },
};

function createElectronTray(iconPath: string): TrayPort {
  const icon = nativeImage.createFromPath(iconPath);
  // A missing or unreadable icon would give an invisible tray entry the user cannot find: treat it as "no tray".
  if (icon.isEmpty()) throw new Error(`the tray icon could not be loaded from ${iconPath}`);
  const tray = new Tray(icon);
  return {
    setToolTip: (text) => tray.setToolTip(text),
    setMenu: (items: readonly TrayMenuItem[]) =>
      tray.setContextMenu(
        Menu.buildFromTemplate(items.map((item) => (item.kind === 'separator' ? { type: 'separator' as const } : { label: item.label, click: item.click }))),
      ),
    onActivate: (listener) => {
      tray.on('click', listener);
      tray.on('double-click', listener);
    },
    destroy: () => tray.destroy(),
    isDestroyed: () => tray.isDestroyed(),
  };
}

function createElectronNotificationPort(iconPath: string, log: (message: string, error: unknown) => void): NotificationPort {
  // Electron needs a live reference to a notification until it closes, or it can be garbage collected before it is shown.
  let live: Notification | undefined;
  return {
    isSupported: () => Notification.isSupported(),
    show(content, onClick) {
      live?.close(); // one at a time: a new track replaces the previous notification instead of stacking
      const notification = new Notification({ title: content.title, body: content.body, silent: true, icon: iconPath });
      live = notification;
      notification.on('click', onClick);
      notification.on('failed', (_event, error) => log('[nova] the OS reported a failed track notification:', error));
      notification.on('close', () => {
        if (live === notification) live = undefined;
      });
      notification.show();
    },
  };
}

/** Builds the one real desktop shell. Call once, after `app.whenReady()`. */
export function createElectronShell(options: ElectronShellOptions): AppShell {
  const { mainDir, log, playbackEvents } = options;
  const iconPath = resourcePath(mainDir, 'icon.png');
  const trayIconPath = resourcePath(mainDir, 'tray.png');

  Menu.setApplicationMenu(null);
  const stateStore = createShellStateStore({ filePath: path.join(app.getPath('userData'), 'shell-state.json'), io: fileIo, log });

  function createMainWindow(state: WindowState): BrowserWindow {
    const mainWindow = new BrowserWindow({
      width: state.width,
      height: state.height,
      ...(state.x !== undefined && state.y !== undefined ? { x: state.x, y: state.y } : {}),
      // Phase 6: below this the library, player bar and Now Playing cannot all stay usable (the layout stacks at 560).
      minWidth: WINDOW_MIN_WIDTH,
      minHeight: WINDOW_MIN_HEIGHT,
      icon: iconPath,
      // No File/Edit/View/Window bar: the app is its own chrome (also removed below, so Alt never brings it back).
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        preload: path.join(mainDir, '../preload/index.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    if (state.maximized) mainWindow.maximize();
    mainWindow.removeMenu();
    mainWindow.once('ready-to-show', () => {
      mainWindow.show();
      // Windows: Previous / Play-Pause / Next under the taskbar preview. They go through the same shell command path as the tray and media keys. (No-op elsewhere.)
      if (process.platform === 'win32') {
        const buttons = buildThumbarButtons((name) => resourcePath(mainDir, name)).map((button) => ({ tooltip: button.tooltip, icon: nativeImage.createFromPath(button.iconPath), click: () => void dispatch(button.id) }));
        if (!buttons.some((button) => button.icon.isEmpty())) mainWindow.setThumbarButtons(buttons);
        else log('[nova] the taskbar buttons are unavailable: an icon could not be loaded.', undefined);
      }
    });

    // Phase 8: the window shows only the application's own page; a link that wants a new window is handed to the
    // OS browser only when it is an ordinary http(s) address (never `file:` or another program's scheme); no
    // `<webview>`; every permission request is refused except "fullscreen" for our own page (double-click / F11 fullscreen); see `window-policy.ts`.
    const location = resolveAppLocation(mainDir, is.dev ? process.env.ELECTRON_RENDERER_URL : undefined);
    applyWindowPolicy(mainWindow.webContents, { appUrl: location.url, openExternal: (url) => shell.openExternal(url), log });
    mainWindow.webContents.session.setPermissionRequestHandler((_contents, permission, callback, details) => callback(permission === 'fullscreen' && isAppPage(details.requestingUrl, location.url)));
    mainWindow.webContents.session.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) => permission === 'fullscreen' && isAppPage(details.requestingUrl ?? requestingOrigin, location.url));
    mainWindow.webContents.on('render-process-gone', (_event, details) => log(`[nova] the window's renderer process ended (${details.reason}, exit code ${details.exitCode}).`, undefined));

    // A load that fails (the window was closed while loading, the file is missing) is logged, never an unhandled rejection.
    const loading = location.kind === 'dev-server' ? mainWindow.loadURL(location.url) : mainWindow.loadFile(location.filePath ?? '');
    void loading.catch((error: unknown) => log('[nova] the application page could not be loaded:', error));
    return mainWindow;
  }

  const windows = createWindowManager({
    createWindow: createMainWindow,
    stateStore,
    displays: () => screen.getAllDisplays().map((display) => display.workArea),
    shouldHideOnClose: () => windows.preferences.closeToTray() && tray.isActive(),
    log,
  });
  const tray = createTrayController({
    createTray: () => createElectronTray(trayIconPath),
    tooltip: 'Nova Player',
    onShow: () => appShell.show(),
    onCommand: (command) => void appShell.dispatch(command),
    onQuit: () => app.quit(),
    log,
  });
  const dispatch = createCommandDispatcher({
    target: () => {
      const window = windows.current() as BrowserWindow | undefined;
      return window === undefined ? undefined : { isDestroyed: () => window.isDestroyed() || window.webContents.isDestroyed(), send: (channel, payload) => window.webContents.send(channel, payload) };
    },
    log,
  });
  const mediaKeys = createMediaKeys({
    globalShortcut: {
      register: (accelerator, callback) => globalShortcut.register(accelerator, callback),
      unregister: (accelerator) => globalShortcut.unregister(accelerator),
      isRegistered: (accelerator) => globalShortcut.isRegistered(accelerator),
    },
    dispatch: (command) => void dispatch(command),
    log,
  });
  const notifier = createTrackNotifier({
    subscribe: (listener) => playbackEvents.subscribe(listener),
    port: createElectronNotificationPort(iconPath, log),
    shouldNotify: () => {
      const window = windows.current() as BrowserWindow | undefined;
      return window === undefined || !window.isFocused();
    },
    onClick: () => appShell.show(),
    log,
  });
  const appShell: AppShell = createAppShell({ windows, tray, mediaKeys, notifier, dispatch });
  return appShell;
}
