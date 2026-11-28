import type { UpdateStatusDto } from '@nova/shared';

interface UpdateInfoLike {
  version: string;
  files?: ReadonlyArray<{ size?: number | undefined }>;
}

/** The few things we use from `electron-updater`'s `autoUpdater`, so the logic can be tested without Electron or a network. */
export interface UpdaterPort {
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent: boolean, isForceRunAfter: boolean): void;
  on(event: 'checking-for-update' | 'update-not-available', listener: () => void): unknown;
  on(event: 'update-available' | 'update-downloaded', listener: (info: UpdateInfoLike) => void): unknown;
  on(event: 'download-progress', listener: (progress: { percent: number; total?: number; transferred?: number; bytesPerSecond?: number }) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export interface UpdateService {
  getStatus(): UpdateStatusDto;
  check(): Promise<UpdateStatusDto>;
  download(): Promise<UpdateStatusDto>;
  /**
   * Moves to `installing` straight away (so the window can say "Restarting…" and stay responsive), then quits and installs a
   * downloaded update (silent, then starts the app again). No-op unless one is ready.
   */
  install(): UpdateStatusDto;
}

/** How long we wait for GitHub before saying so. A hung connection must not leave "Checking…" on screen forever. */
export const CHECK_TIMEOUT_MS = 45_000;
/** The window gets this long to paint "Restarting…" before the app closes. */
export const INSTALL_PAINT_MS = 350;

/** Why an update failed, as one calm sentence (never a stack trace, URL or token). */
export function friendlyUpdateError(error: unknown): string {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  if (/timed out|timeout/i.test(text)) return 'The update server took too long to answer. Try again.';
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|net::ERR|offline|network/i.test(text)) return 'Could not reach the update server. Check your internet connection.';
  if (/ENOSPC|no space/i.test(text)) return 'There is not enough free disk space to download the update.';
  if (/sha512|checksum|signature|integrity/i.test(text)) return 'The downloaded update did not pass its safety check, so it was discarded. Try again.';
  if (/404|latest\.yml|no published versions|not found/i.test(text)) return 'No update information has been published yet.';
  if (/403|rate limit/i.test(text)) return 'The update server is busy. Try again in a little while.';
  return 'The update check failed. Try again later.';
}

/** The size of the installer file in the release info, if it says. Used only as an upper bound before the download starts. */
function installerBytes(info: UpdateInfoLike): number | undefined {
  const sizes = (info.files ?? []).map((file) => file.size).filter((size): size is number => typeof size === 'number' && Number.isFinite(size) && size > 0);
  return sizes.length === 0 ? undefined : Math.max(...sizes);
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('The update request timed out')), ms);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * Keeps one honest status for the window. Nothing downloads without a click (`download`), and installing needs a downloaded update.
 * `updater` is undefined where updating is not possible (development, tests, a build that is not installed).
 */
export function createUpdateService(deps: {
  readonly updater: UpdaterPort | undefined;
  readonly currentVersion: string;
  /** Test seam: how the pause before quitting is scheduled. */
  readonly schedule?: (run: () => void, ms: number) => void;
  readonly checkTimeoutMs?: number;
}): UpdateService {
  const { updater, currentVersion } = deps;
  const schedule = deps.schedule ?? ((run, ms) => void setTimeout(run, ms));
  const checkTimeoutMs = deps.checkTimeoutMs ?? CHECK_TIMEOUT_MS;
  let status: UpdateStatusDto = { state: updater === undefined ? 'unsupported' : 'idle', currentVersion };
  /** What the last check found, so a failed download can be retried with one click instead of a new check. */
  let found: { version: string; bytes: number | undefined } | undefined;
  const set = (next: Omit<UpdateStatusDto, 'currentVersion'>): void => {
    status = { currentVersion, ...next };
  };
  const availableStatus = (): Omit<UpdateStatusDto, 'currentVersion'> => (found === undefined ? { state: 'available' } : { state: 'available', version: found.version, ...(found.bytes !== undefined && { totalBytes: found.bytes, sizeKind: 'full' as const }) });
  if (updater !== undefined) {
    updater.on('checking-for-update', () => set({ state: 'checking' }));
    updater.on('update-not-available', () => { found = undefined; set({ state: 'none' }); });
    updater.on('update-available', (info) => {
      found = { version: info.version, bytes: installerBytes(info) };
      set(availableStatus());
    });
    updater.on('download-progress', (p) => {
      const total = typeof p.total === 'number' && p.total > 0 ? p.total : undefined;
      set({
        state: 'downloading',
        ...(status.version !== undefined && { version: status.version }),
        percent: Math.max(0, Math.min(100, Math.round(p.percent))),
        ...(total !== undefined && { totalBytes: total, sizeKind: 'update' as const }),
        ...(typeof p.transferred === 'number' && { downloadedBytes: Math.max(0, p.transferred) }),
        ...(typeof p.bytesPerSecond === 'number' && p.bytesPerSecond > 0 && { bytesPerSecond: p.bytesPerSecond }),
      });
    });
    updater.on('update-downloaded', (info) => set({ state: 'ready', version: info.version, percent: 100, ...(status.sizeKind === 'update' && status.totalBytes !== undefined && { totalBytes: status.totalBytes, sizeKind: 'update' as const }) }));
    updater.on('error', (error) => set({ state: 'error', message: friendlyUpdateError(error), ...(found !== undefined && { version: found.version }) }));
  }
  const busy = (): boolean => status.state === 'checking' || status.state === 'downloading' || status.state === 'installing';

  return {
    getStatus: () => status,
    async check() {
      if (updater === undefined || busy() || status.state === 'ready') return status;
      set({ state: 'checking' });
      try {
        await withTimeout(updater.checkForUpdates(), checkTimeoutMs);
      } catch (error) {
        set({ state: 'error', message: friendlyUpdateError(error) });
      }
      return status;
    },
    async download() {
      // From "available", or from "error" when a download failed after an update was found: one click retries it.
      const retry = status.state === 'error' && found !== undefined;
      if (updater === undefined || (status.state !== 'available' && !retry)) return status;
      const version = found?.version ?? status.version;
      set({ state: 'downloading', ...(version !== undefined && { version }), percent: 0, ...(found?.bytes !== undefined && { totalBytes: found.bytes, sizeKind: 'full' as const }) });
      try {
        await updater.downloadUpdate();
      } catch (error) {
        set({ state: 'error', message: friendlyUpdateError(error), ...(version !== undefined && { version }) });
      }
      return status;
    },
    install() {
      if (updater === undefined || status.state !== 'ready') return status;
      const ready = status;
      set({ state: 'installing', ...(ready.version !== undefined && { version: ready.version }), percent: 100 });
      schedule(() => {
        try {
          updater.quitAndInstall(true, true);
        } catch (error) {
          set({ state: 'error', message: friendlyUpdateError(error) });
        }
      }, INSTALL_PAINT_MS);
      return status;
    },
  };
}
