import type { UpdateStatusDto } from '@nova/shared';

/** The few things we use from `electron-updater`'s `autoUpdater`, so the logic can be tested without Electron or a network. */
export interface UpdaterPort {
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent: boolean, isForceRunAfter: boolean): void;
  on(event: 'checking-for-update' | 'update-not-available', listener: () => void): unknown;
  on(event: 'update-available' | 'update-downloaded', listener: (info: { version: string }) => void): unknown;
  on(event: 'download-progress', listener: (progress: { percent: number }) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export interface UpdateService {
  getStatus(): UpdateStatusDto;
  check(): Promise<UpdateStatusDto>;
  download(): Promise<UpdateStatusDto>;
  /** Quits and installs a downloaded update (silent, then starts the app again). No-op unless one is ready. */
  install(): UpdateStatusDto;
}

/** Why an update failed, as one calm sentence (never a stack trace, URL or token). */
export function friendlyUpdateError(error: unknown): string {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|net::ERR|offline|network/i.test(text)) return 'Could not reach the update server. Check your internet connection.';
  if (/404|latest\.yml|no published versions|not found/i.test(text)) return 'No update information has been published yet.';
  if (/403|rate limit/i.test(text)) return 'The update server is busy. Try again in a little while.';
  return 'The update check failed. Try again later.';
}

/**
 * Keeps one honest status for the window. Nothing downloads without a click (`download`), and installing needs a downloaded update.
 * `updater` is undefined where updating is not possible (development, tests, a build that is not installed).
 */
export function createUpdateService(deps: { readonly updater: UpdaterPort | undefined; readonly currentVersion: string }): UpdateService {
  const { updater, currentVersion } = deps;
  let status: UpdateStatusDto = { state: updater === undefined ? 'unsupported' : 'idle', currentVersion };
  const set = (next: Omit<UpdateStatusDto, 'currentVersion'>): void => {
    status = { currentVersion, ...next };
  };
  if (updater !== undefined) {
    updater.on('checking-for-update', () => set({ state: 'checking' }));
    updater.on('update-not-available', () => set({ state: 'none' }));
    updater.on('update-available', (info) => set({ state: 'available', version: info.version }));
    updater.on('download-progress', (p) => set({ state: 'downloading', ...(status.version !== undefined && { version: status.version }), percent: Math.max(0, Math.min(100, Math.round(p.percent))) }));
    updater.on('update-downloaded', (info) => set({ state: 'ready', version: info.version, percent: 100 }));
    updater.on('error', (error) => set({ state: 'error', message: friendlyUpdateError(error) }));
  }
  const busy = (): boolean => status.state === 'checking' || status.state === 'downloading';

  return {
    getStatus: () => status,
    async check() {
      if (updater === undefined || busy() || status.state === 'ready') return status;
      set({ state: 'checking' });
      try {
        await updater.checkForUpdates();
      } catch (error) {
        set({ state: 'error', message: friendlyUpdateError(error) });
      }
      return status;
    },
    async download() {
      if (updater === undefined || status.state !== 'available') return status;
      const version = status.version;
      set({ state: 'downloading', ...(version !== undefined && { version }), percent: 0 });
      try {
        await updater.downloadUpdate();
      } catch (error) {
        set({ state: 'error', message: friendlyUpdateError(error) });
      }
      return status;
    },
    install() {
      if (updater !== undefined && status.state === 'ready') updater.quitAndInstall(true, true);
      return status;
    },
  };
}
