import { app, BrowserWindow, dialog, ipcMain, net, type IpcMainInvokeEvent, type OpenDialogOptions } from 'electron';
import path from 'node:path';
import fsPromises from 'node:fs/promises';
import { parseTrackId } from '@nova/domain';
import electronUpdater from 'electron-updater';
import { createUpdateService, type UpdaterPort } from './updater/update-service.js';
import fsSync from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PLAYLIST_LIMITS, WALLPAPER_LIMITS } from '@nova/shared';
import {
  registerNovaMediaSchemeAsPrivileged,
  registerNovaMediaProtocolHandler,
  createLibraryApplication,
  createLibraryServices,
  createMediaAccess,
  createTrackSidecars,
  createLrclibProvider,
  createFixtureProvider,
  readEmbeddedPicture,
  readFileBounded,
  createPlaybackApplication,
  createCollectionsApplication,
  createHistoryRecorder,
  createTrackThumbnails,
  createWallpaperStore,
  runDatabaseDiagnostics,
  SUPPORTED_AUDIO_EXTENSIONS,
  type LibraryServicesDiagnostic,
  type LibraryApplication,
  type LibraryServices,
  type PlaybackApplication,
  buildNovaMediaUrl,
  type NovaMediaRequestInfo,
} from '@nova/infrastructure';
import { is } from '@electron-toolkit/utils';
import { createFatalErrorHandler, createShutdownCoordinator, installProcessErrorPolicy } from './lifecycle.js';
import { registerDiagnosticsIpc } from './ipc/register-diagnostics-ipc.js';
import { isTrustedSenderFacts } from './ipc/trusted-sender.js';
import { resolveAppLocation } from './shell/app-location.js';
import { bridgeApplicationEvents, registerLibraryIpc, type PublishEvent } from './ipc/register-library-ipc.js';
import { bridgePlaybackEvents, registerPlaybackIpc } from './ipc/register-playback-ipc.js';
import { registerCollectionsIpc } from './ipc/register-collections-ipc.js';
import { trimCoverBars, createNativeImageResizer, createWallpaperPorts, wallpaperDirectory } from './media/electron-images.js';
import type { AppShell } from './shell/app-shell.js';
import { createElectronShell } from './shell/electron-shell.js';
import { createPinnedFetchText, writeLrcAtomic } from './lyrics/lyrics-ports.js';
import { audioPathFromArgs, createFileOpener } from './shell/open-file.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Phase 0 spike only (the `diagnostics:getSeekSpikeMediaUrl` channel and its
// `nova-media://local/<path>` URL shape): the test fixtures directory, and
// only in an unpackaged development run - a packaged app serves no path-based
// URL at all. Library playback does NOT use this: it goes through opaque
// `nova-media://track/<TrackId>` URLs authorized against the registered roots.
const fixturesRoot = path.resolve(__dirname, '../../../../tests/fixtures');

/**
 * Phase 2G: the library infrastructure (SQLite database, metadata reader,
 * scanner, watchers) is owned by this - the main - process. It is created
 * once at startup and closed on quit. The renderer never touches it: it can
 * only call the typed `library:*` IPC channels, whose handlers go through the
 * single `LibraryApplication` built over these services (Phase 3 half 1).
 */
let libraryServices: LibraryServices | undefined;
let libraryApplication: LibraryApplication | undefined;
let playbackApplication: PlaybackApplication | undefined;
let stopHistoryRecorder: (() => void) | undefined;
/** Phase 7: the desktop shell (the one window, tray, media keys). Created once at startup; disposed on quit. */
let appShell: AppShell | undefined;

// v0.11.3: "Open with Nova Player" / double-click on an audio file. Requests that arrive before the app has started wait here.
const isAudioPath = (filePath: string): boolean => SUPPORTED_AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
let openHandler: ((filePath: string) => void) | undefined;
const waitingOpens: string[] = [];
function requestOpen(filePath: string): void {
  if (openHandler === undefined) waitingOpens.push(filePath);
  else openHandler(filePath);
}
const launchFile = audioPathFromArgs(process.argv.slice(1), isAudioPath);
if (launchFile !== undefined) waitingOpens.push(launchFile);

/** The persistent library database lives in the per-user app data folder -
 *  never in the project/install directory. */
function libraryDatabasePath(): string {
  return path.join(app.getPath('userData'), 'library', 'nova.db');
}

/**
 * Must run before app.whenReady() - see nova-media-protocol.ts for why.
 */
registerNovaMediaSchemeAsPrivileged();

// Phase 7: one running Nova Player per user-data folder. A second launch must not open a second
// window / database connection / tray icon / set of media keys: it hands over to the running one
// (which shows its window) and exits. The lock is per `userData`, so it never couples separate profiles.
const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) app.quit();
else {
  app.on('second-instance', (_event, argv) => {
    appShell?.show();
    const file = audioPathFromArgs(argv.slice(1), isAudioPath);
    if (file !== undefined) requestOpen(file);
  });
  // macOS hands files over with an event instead of an argument.
  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    requestOpen(filePath);
  });
}

// Windows taskbar / notification identity (matches `appId` in electron-builder.yml).
if (process.platform === 'win32') app.setAppUserModelId('com.novaplayer.desktop');

/**
 * The three Phase 0 channels (`app:ping`, `diagnostics:*`). Phase 8: they follow the same rules as every later
 * channel (trusted sender, validated request), and the seek-spike channel - which names a path in the source
 * checkout - exists only in an unpackaged run.
 */
function registerIpcHandlers(): void {
  registerDiagnosticsIpc({
    registrar: { handle: (channel, listener) => ipcMain.handle(channel, (event, request: unknown) => listener(event, request)) },
    isTrustedSender,
    checkDatabase: () => runDatabaseDiagnostics(),
    seekSpikeMediaUrl: app.isPackaged
      ? undefined
      : () => {
          const absolutePath = path.join(fixturesRoot, 'seek-spike.mp3');
          return { url: buildNovaMediaUrl(absolutePath), absolutePath };
        },
  });
}

/** The OS folder picker. The renderer never supplies a path: it asks main to
 *  add a library folder, and main asks the user. */
async function pickLibraryFolder(): Promise<string | undefined> {
  const options: OpenDialogOptions = { title: 'Add a music folder', properties: ['openDirectory'] };
  const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
  return result.canceled ? undefined : result.filePaths[0];
}

/** The native "choose a lyrics file" dialog (Phase 10): the renderer asks main to attach lyrics to a track, and main asks the user. */
async function pickLyricsFile(): Promise<string | undefined> {
  const options: OpenDialogOptions = {
    title: 'Choose a lyrics file (.lrc)',
    properties: ['openFile'],
    filters: [
      { name: 'Lyrics (.lrc, .txt)', extensions: ['lrc', 'txt'] },
      { name: 'All files', extensions: ['*'] },
    ],
  };
  const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
  return result.canceled ? undefined : result.filePaths[0];
}

/**
 * The online lyrics-text provider (v0.12.0). A test hook (`NOVA_LYRICS_FIXTURE` = a JSON file in LRCLIB's shape) swaps in
 * a canned answer, but never in a packaged app: a shipped build can only ever talk to lrclib.net.
 */
function lyricsProvider() {
  const fixture = process.env.NOVA_LYRICS_FIXTURE;
  if (!app.isPackaged && fixture !== undefined && fixture !== '') return createFixtureProvider(fsSync.readFileSync(fixture, 'utf8'));
  return createLrclibProvider(
    createPinnedFetchText((url, init) => net.fetch(url, init)),
    `NovaPlayer/${app.getVersion()} (local desktop player)`,
  );
}

/** The native "choose a cover picture" dialog for one track (v0.11.3). Only the type filter; the real judgement (type by content, size) is the sidecars'. */
async function pickArtworkFile(): Promise<string | undefined> {
  const options: OpenDialogOptions = {
    title: 'Choose a cover picture',
    properties: ['openFile'],
    filters: [
      { name: 'Pictures (.jpg, .png, .webp)', extensions: ['jpg', 'jpeg', 'png', 'webp'] },
      { name: 'All files', extensions: ['*'] },
    ],
  };
  const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
  return result.canceled ? undefined : result.filePaths[0];
}

/** The native "choose a wallpaper picture" dialog (Phase 11). Only the type filter; the real judgement (type by content, size, dimensions) is `createWallpaperStore`'s. */
async function pickWallpaperFile(): Promise<string | undefined> {
  const options: OpenDialogOptions = {
    title: 'Choose a wallpaper picture',
    properties: ['openFile'],
    filters: [
      { name: 'Pictures', extensions: [...WALLPAPER_LIMITS.extensions] },
      { name: 'All files', extensions: ['*'] },
    ],
  };
  const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
  return result.canceled ? undefined : result.filePaths[0];
}

/** Where the one application page is loaded from (also what a window may navigate to, and what a caller must be showing). */
const appLocation = resolveAppLocation(__dirname, is.dev ? process.env.ELECTRON_RENDERER_URL : undefined);

/** Only calls from the top-level frame of one of our own windows, showing the application's own page, are served. */
function isTrustedSender(event: unknown): boolean {
  try {
    const { sender, senderFrame } = event as IpcMainInvokeEvent;
    if (senderFrame === null || senderFrame === undefined) return false;
    return isTrustedSenderFacts(
      { knownWindow: BrowserWindow.fromWebContents(sender) !== null, isMainFrame: senderFrame === sender.mainFrame, frameUrl: senderFrame.url },
      appLocation.url,
    );
  } catch {
    return false; // a destroyed frame or contents is not a caller to serve
  }
}

const publishToRenderers: PublishEvent = (channel, payload) => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(channel, payload);
  }
};

function logError(message: string, error: unknown): void {
  console.error(message, error);
}

/**
 * Phase 8: stops everything the main process started, in the one safe order (see `lifecycle.ts` for the policy).
 * Safe to call more than once and from any state - including a start that failed half way, when only some of
 * these exist. The database is closed last, after the application layer has stopped writing.
 */
/**
 * Closes the windows and waits until they are gone. A quit request reaches `before-quit` while the windows are
 * still open, and the renderer saves its last playback position as its page goes away (`pagehide`); that write
 * must reach the database BEFORE the database is closed, or the position is lost (found by the real-Electron
 * "quit while playing" spec). Bounded, so a window that refuses to close cannot hold the quit.
 */
async function closeWindows(timeoutMs = 3_000): Promise<void> {
  const open = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed());
  await Promise.all(
    open.map(
      (window) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, timeoutMs);
          timer.unref?.();
          window.once('closed', () => {
            clearTimeout(timer);
            resolve();
          });
          window.close();
        }),
    ),
  );
}

async function cleanup(): Promise<void> {
  const services = libraryServices;
  const application = libraryApplication;
  const playback = playbackApplication;
  libraryServices = undefined;
  libraryApplication = undefined;
  stopHistoryRecorder?.();
  stopHistoryRecorder = undefined;
  playbackApplication = undefined;
  // From here a window close really closes; release the media keys, tray icon and window state (idempotent).
  appShell?.beginQuit();
  await closeWindows(); // the renderer's final position save arrives now, while the database is still open
  appShell?.dispose();
  playback?.dispose(); // every playback write is already committed; this just stops its events
  await application?.dispose(); // aborts the running scan, stops the watcher
  await services?.close();
  if (services !== undefined) console.log('[nova] library closed cleanly');
}

const shutdownCoordinator = createShutdownCoordinator({ cleanup, quit: () => app.quit(), log: logError });
const fatalErrors = createFatalErrorHandler({
  log: logError,
  shutdown: () => shutdownCoordinator.shutdown(),
  showError: (title, detail) => dialog.showErrorBox(title, detail),
  exit: (code) => app.exit(code),
});
// An uncaught exception or an unhandled rejection leaves the process in an unknown state: end it in a controlled way
// (library closed, user told, exit code 1) instead of Electron's default of carrying on.
installProcessErrorPolicy(process, fatalErrors);

/** Describes what the library repaired while opening; the user's files are never touched by it. */
function logLibraryDiagnostic(event: LibraryServicesDiagnostic): void {
  if (event.kind === 'unreadable-tracks-removed') {
    console.warn(`[nova] ${event.rows.length} stored track record(s) could not be read and were removed; the next scan re-adds them from their files:`, event.rows);
  } else {
    logError('[nova] stored track records could not be read and the automatic repair failed:', event.error);
  }
}

function startApplication(): void {
  if (!isPrimaryInstance) return;
  try {
    libraryServices = createLibraryServices({ databasePath: libraryDatabasePath(), onDiagnostic: logLibraryDiagnostic });
  } catch (error) {
    // A library that cannot be opened (corrupt file, newer-version database,
    // unwritable folder) must be reported, not silently ignored or half-run.
    const detail = error instanceof Error ? error.message : String(error);
    console.error('[nova] could not open the library database:', error);
    dialog.showErrorBox('Nova Player cannot open its library', `${detail}\n\nThe database is at:\n${libraryDatabasePath()}`);
    app.exit(1);
    return;
  }

  registerIpcHandlers();
  // Test hook only (like `NOVA_STARTUP_SYNC`): fails the start AFTER the database is open and the first handlers are
  // registered, so the real-Electron specs can prove that a half-started app is closed cleanly and exits non-zero.
  if (process.env.NOVA_E2E_FAIL_STARTUP === '1') throw new Error('induced startup failure (NOVA_E2E_FAIL_STARTUP)');

  // The one application service over the Phase 2 services; the IPC handlers
  // (and nothing else) call it. Its events reach the renderer as DTOs.
  libraryApplication = createLibraryApplication({
    services: libraryServices,
    onInternalError: (error) => logError('[nova] contained internal error:', error),
  });

  // Phase 4. Media access is decided here, per request, against the roots
  // that are registered at that moment; the protocol holds no allowlist of its own.
  const mediaAccess = createMediaAccess({
    trackRepository: libraryServices.trackRepository,
    libraryRootRepository: libraryServices.libraryRootRepository,
    fileSystem: libraryServices.fileSystem,
  });
  registerNovaMediaProtocolHandler({
    mediaAccess,
    allowedRoots: app.isPackaged ? [] : [fixturesRoot],
    onError: (error) => logError('[nova-media] unexpected failure while serving a request:', error),
    onRequest: ({ requestedPath, rangeHeader, allowed, responseStatus, denial }: NovaMediaRequestInfo) => {
      // Refusals only (never a per-range chatter line); `requestedPath` is an opaque id for library tracks.
      if (!allowed) console.warn(`[nova-media] refused ${requestedPath || '(invalid request)'} status=${responseStatus} reason=${denial} range=${rangeHeader ?? '(none)'}`);
    },
  });

  // Phase 11: favourites, recently played and playlists (one service), the cover thumbnails and the wallpaper.
  const collectionsApplication = createCollectionsApplication({
    trackRepository: libraryServices.trackRepository,
    favorites: libraryServices.favoritesRepository,
    history: libraryServices.historyRepository,
    playlists: libraryServices.playlistRepository,
    limits: PLAYLIST_LIMITS,
  });
  const trackSidecars = createTrackSidecars({
    mediaAccess,
    libraryRootRepository: libraryServices.libraryRootRepository,
    fileSystem: libraryServices.fileSystem,
    readFile: readFileBounded,
    readEmbeddedArtwork: readEmbeddedPicture,
    attachedLyrics: libraryServices.attachedLyricsRepository,
    customCovers: libraryServices.customCoverRepository,
    writeFile: writeLrcAtomic,
  });
  const trackThumbnails = createTrackThumbnails({
    sidecars: trackSidecars,
    resizer: createNativeImageResizer(),
    onError: (error) => logError('[nova] thumbnail failure:', error),
  });
  const wallpaperStore = createWallpaperStore(createWallpaperPorts(wallpaperDirectory(app.getPath('userData')), (error) => logError('[nova] wallpaper failure:', error)));

  playbackApplication = createPlaybackApplication({
    trackRepository: libraryServices.trackRepository,
    playbackSessionRepository: libraryServices.playbackSessionRepository,
    library: libraryApplication,
    mediaAccess,
    collections: collectionsApplication,
    onInternalError: (error) => logError('[nova] contained playback error:', error),
  });

  registerLibraryIpc({
    registrar: { handle: (channel, listener) => ipcMain.handle(channel, (event, request: unknown) => listener(event, request)) },
    application: libraryApplication,
    pickFolder: pickLibraryFolder,
    isTrustedSender,
    log: logError,
  });
  bridgeApplicationEvents(libraryApplication, publishToRenderers);

  // v0.15.2: updates come from GitHub Releases through electron-updater, and only for an INSTALLED app (never in development).
  const updateService = createUpdateService({ updater: app.isPackaged ? installedUpdater() : undefined, currentVersion: app.getVersion() });
  registerPlaybackIpc({
    registrar: { handle: (channel, listener) => ipcMain.handle(channel, (event, request: unknown) => listener(event, request)) },
    application: playbackApplication,
    sidecars: trackSidecars,
    trimCover: trimCoverBars,
    pickLyricsFile,
    pickArtworkFile,
    onArtworkChanged: () => trackThumbnails.invalidate(),
    updates: updateService,
    editTrackInfo: (trackId, edit) => {
      const edits = libraryServices?.trackEdits;
      const id = parseTrackId(trackId);
      if (edits === undefined || id === undefined) return 'unknown';
      if (edit === undefined) {
        if (libraryServices?.trackRepository.getById(id) === undefined) return 'unknown';
        const removed = edits.clearEdit(id);
        if (removed) publishToRenderers('library:changed', { reason: 'tags-edited' });
        return removed ? 'done' : 'nothing';
      }
      if (!edits.setEdit(id, edit)) return 'unknown';
      publishToRenderers('library:changed', { reason: 'tags-edited' });
      return 'done';
    },
    describeTrack: (trackId) => {
      const track = libraryServices?.trackRepository.getById(trackId as never);
      if (track === undefined) return undefined;
      return { title: track.title, artist: track.artist, ...(track.album !== undefined && { album: track.album }), ...(track.durationSeconds !== undefined && { durationSec: Math.round(track.durationSeconds) }) };
    },
    lyricsProvider: lyricsProvider(),
    isTrustedSender,
    log: logError,
  });
  bridgePlaybackEvents(playbackApplication, publishToRenderers);

  registerCollectionsIpc({
    registrar: { handle: (channel, listener) => ipcMain.handle(channel, (event, request: unknown) => listener(event, request)) },
    collections: collectionsApplication,
    playback: playbackApplication,
    thumbnails: trackThumbnails,
    wallpaper: wallpaperStore,
    pickWallpaperFile,
    isTrustedSender,
    log: logError,
  });
  // "Recently played" is recorded here in main, from the playback traffic the renderer already sends - no channel of its own.
  stopHistoryRecorder = createHistoryRecorder({
    playback: playbackApplication,
    record: (trackId) => collectionsApplication.recordPlay(trackId),
    onError: (error) => logError('[nova] could not record a play:', error),
  });

  // Playback follows the library, never the other way round: whenever the
  // track list changes (a scan, the watcher, a removed folder), the queue is
  // re-checked so it can never keep pointing at a track that is gone.
  const playback = playbackApplication;
  libraryApplication.subscribe((event) => {
    if (event.type === 'library-changed') {
      playback.reconcileLibrary();
      trackThumbnails.invalidate();
    }
  });

  // Phase 7: the shell creates the one main window, the tray and the media keys. Every shell command
  // reaches the player through the typed `shell:command` event - never by touching the audio directly.
  appShell = createElectronShell({ mainDir: __dirname, log: logError, playbackEvents: playbackApplication });
  appShell.start();
  if (process.env.NOVA_E2E_SHELL_HOOKS === '1') {
    // Test hook only (main-process globals, unreachable from the renderer): the shell, and a promise that settles
    // when the window has really been shown for the first time (`isVisible()` alone is true before that on some platforms).
    const hooks = globalThis as { __novaShell?: AppShell; __novaWindowReady?: Promise<void> };
    hooks.__novaShell = appShell;
    const first = appShell.windows.current() as BrowserWindow | undefined;
    hooks.__novaWindowReady = new Promise<void>((resolve) => (first === undefined ? resolve() : void first.once('ready-to-show', () => resolve())));
  }

  // Phase 5 launch policy (see `LibraryApplication.startup`): watch the registered folders and run
  // one incremental reconciliation scan over the ones that are reachable. It starts AFTER the window
  // exists and runs in the background, so the UI is usable immediately; progress arrives as events.
  // `NOVA_STARTUP_SYNC=off` is a test hook only (it keeps the older E2E specs, which drive scanning by
  // hand, deterministic); there is no user-facing setting - the settings system is later work.
  if (process.env.NOVA_STARTUP_SYNC !== 'off') {
    const library = libraryApplication;
    void library
      .startup()
      .then((report) => console.log(`[nova] startup sync: roots=${report.rootCount} available=${report.availableRoots} watching=${report.watching} scan=${report.scanStarted}`))
      .catch((error: unknown) => logError('[nova] startup sync failed:', error));
  }

  // Opening an audio file from the OS: find it in the library (or add its folder), then tell the player to play it.
  const library2 = libraryApplication;
  const fileOpener = createFileOpener({
    library: {
      listTracks: () => library2.listTracks(),
      listRoots: () => library2.listRoots(),
      addRoot: (folder) => library2.addRoot(folder),
      startScan: (request) => library2.startScan(request),
      scanning: () => library2.getScanState().active !== undefined,
      onceScanFinished: (listener) => {
        const off = library2.subscribe((event) => {
          if (event.type !== 'scan-finished') return;
          off();
          listener();
        });
        return off;
      },
    },
    isAudioFile: isAudioPath,
    resolveFile: async (filePath) => {
      try {
        const real = await fsPromises.realpath(filePath);
        return (await fsPromises.stat(real)).isFile() ? real : undefined;
      } catch {
        return undefined;
      }
    },
    play: (trackId) => appShell?.openTrack(trackId) ?? false,
    show: () => appShell?.show(),
    caseInsensitive: process.platform === 'win32' || process.platform === 'darwin',
    log: logError,
  });
  const firstWindow = appShell.windows.current() as BrowserWindow | undefined;
  const rendererReady =
    firstWindow === undefined || !firstWindow.webContents.isLoading()
      ? Promise.resolve()
      : new Promise<void>((resolve) => firstWindow.webContents.once('did-finish-load', () => setTimeout(resolve, 900)));
  void rendererReady.then(() => {
    openHandler = (filePath) => void fileOpener.open(filePath);
    for (const filePath of waitingOpens.splice(0)) openHandler(filePath);
  });

  app.on('activate', () => appShell?.show());
}

// A failure while starting - after the database is open, so some services already exist - is fatal, not "carry on".
void app.whenReady().then(startApplication).catch((error: unknown) => void fatalErrors.handle('startup', error));

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Orderly shutdown (Phase 8: `createShutdownCoordinator`): EVERY quit request is held until the one cleanup has
// finished - stop the application layer (aborts the running scan, stops the watcher), then close the services
// (database last) - and only then does the quit proceed. A cleanup that hangs is cut off after a bounded time.
app.on('before-quit', (event) => {
  // Phase 7: from here a window close really closes; release the media keys, tray icon and window state.
  // Both calls are idempotent (this event fires more than once - see above).
  appShell?.beginQuit();
  appShell?.dispose();
  shutdownCoordinator.onBeforeQuit(event);
});

/** `electron-updater` set up the careful way: nothing downloads by itself, and the finished download installs when the app is quit. */
function installedUpdater(): UpdaterPort {
  const { autoUpdater } = electronUpdater;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = null;
  return autoUpdater as unknown as UpdaterPort;
}
