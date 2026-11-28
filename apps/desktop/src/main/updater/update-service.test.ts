import { describe, expect, it, vi } from 'vitest';
import { createUpdateService, friendlyUpdateError, type UpdaterPort } from './update-service.js';

function fakeUpdater(script: { check?: () => Promise<void>; download?: () => Promise<void> } = {}) {
  const handlers = new Map<string, (arg?: never) => void>();
  const port: UpdaterPort = {
    checkForUpdates: vi.fn(script.check ?? (async () => undefined)),
    downloadUpdate: vi.fn(script.download ?? (async () => undefined)),
    quitAndInstall: vi.fn(),
    on: ((event: string, listener: (arg?: never) => void) => void handlers.set(event, listener)) as UpdaterPort['on'],
  };
  return { port, emit: (event: string, arg?: unknown) => handlers.get(event)?.(arg as never) };
}

describe('update service', () => {
  it('is unsupported (and does nothing) where updating cannot work', async () => {
    const service = createUpdateService({ updater: undefined, currentVersion: '0.15.2' });
    expect(service.getStatus()).toEqual({ state: 'unsupported', currentVersion: '0.15.2' });
    expect((await service.check()).state).toBe('unsupported');
    expect((await service.download()).state).toBe('unsupported');
    expect(service.install().state).toBe('unsupported');
  });

  it('walks check -> available -> download -> ready -> install, and only installs when ready', async () => {
    const { port, emit } = fakeUpdater({
      check: async () => {
        emit('checking-for-update');
        emit('update-available', { version: '0.16.0' });
      },
      download: async () => {
        emit('download-progress', { percent: 41.6 });
        emit('update-downloaded', { version: '0.16.0' });
      },
    });
    const later: Array<() => void> = [];
    const service = createUpdateService({ updater: port, currentVersion: '0.15.2', schedule: (run) => void later.push(run) });
    service.install();
    expect(port.quitAndInstall).not.toHaveBeenCalled();
    await service.download(); // nothing found yet: no download
    expect(port.downloadUpdate).not.toHaveBeenCalled();
    expect(await service.check()).toMatchObject({ state: 'available', version: '0.16.0' });
    expect(await service.download()).toMatchObject({ state: 'ready', version: '0.16.0', percent: 100 });
    expect(service.install().state).toBe('installing'); // the window can say "Restarting…" before the app closes
    expect(port.quitAndInstall).not.toHaveBeenCalled();
    later.forEach((run) => run());
    expect(port.quitAndInstall).toHaveBeenCalledWith(true, true);
  });

  it('shows the installer size before the download (an upper bound) and the real update size once it runs', async () => {
    const { port, emit } = fakeUpdater({
      check: async () => emit('update-available', { version: '2.0.0', files: [{ size: 90_000_000 }, { size: 120_000_000 }] }),
      download: async () => {
        emit('download-progress', { percent: 50, total: 6_000_000, transferred: 3_000_000, bytesPerSecond: 1_000_000 });
        emit('update-downloaded', { version: '2.0.0' });
      },
    });
    const service = createUpdateService({ updater: port, currentVersion: '1.0.0' });
    expect(await service.check()).toMatchObject({ state: 'available', totalBytes: 120_000_000, sizeKind: 'full' });
    await service.download();
    expect(service.getStatus()).toMatchObject({ state: 'ready', totalBytes: 6_000_000, sizeKind: 'update' });
  });

  it('shows only the update size while downloading, not the whole app', async () => {
    const { port, emit } = fakeUpdater({ check: async () => emit('update-available', { version: '2.0.0', files: [{ size: 120_000_000 }] }) });
    const service = createUpdateService({ updater: port, currentVersion: '1.0.0' });
    await service.check();
    emit('download-progress', { percent: 10, total: 5_000_000, transferred: 500_000, bytesPerSecond: 250_000 });
    expect(service.getStatus()).toMatchObject({ state: 'downloading', totalBytes: 5_000_000, sizeKind: 'update', downloadedBytes: 500_000, bytesPerSecond: 250_000 });
  });

  it('retries a failed download with one click, without checking again', async () => {
    let attempt = 0;
    const { port, emit } = fakeUpdater({
      check: async () => emit('update-available', { version: '2.0.0' }),
      download: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('read ECONNRESET');
        emit('update-downloaded', { version: '2.0.0' });
      },
    });
    const service = createUpdateService({ updater: port, currentVersion: '1.0.0' });
    await service.check();
    expect(await service.download()).toMatchObject({ state: 'error', version: '2.0.0' });
    expect((await service.download()).state).toBe('ready');
    expect(port.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('gives up on a check that never answers, with a calm sentence', async () => {
    const { port } = fakeUpdater({ check: () => new Promise<void>(() => undefined) });
    const service = createUpdateService({ updater: port, currentVersion: '1.0.0', checkTimeoutMs: 20 });
    expect(await service.check()).toMatchObject({ state: 'error', message: 'The update server took too long to answer. Try again.' });
    expect(service.getStatus().state).toBe('error'); // and a new check is allowed
  });

  it('reports an install that fails to start instead of silently doing nothing', async () => {
    const { port, emit } = fakeUpdater({ check: async () => emit('update-available', { version: '2.0.0' }), download: async () => emit('update-downloaded', { version: '2.0.0' }) });
    (port.quitAndInstall as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('boom'); });
    const service = createUpdateService({ updater: port, currentVersion: '1.0.0', schedule: (run) => run() });
    await service.check();
    await service.download();
    service.install();
    expect(service.getStatus().state).toBe('error');
  });

  it('reports "none" when up to date, and a calm sentence when it fails', async () => {
    const a = fakeUpdater({ check: async () => void a.emit('update-not-available') });
    expect((await createUpdateService({ updater: a.port, currentVersion: '1.0.0' }).check()).state).toBe('none');
    const b = fakeUpdater({ check: async () => { throw new Error('getaddrinfo ENOTFOUND github.com'); } });
    const status = await createUpdateService({ updater: b.port, currentVersion: '1.0.0' }).check();
    expect(status).toEqual({ state: 'error', currentVersion: '1.0.0', message: 'Could not reach the update server. Check your internet connection.' });
  });

  it('does not start a second check while one runs, and shows progress as whole numbers', async () => {
    let release: () => void = () => undefined;
    const { port, emit } = fakeUpdater({ check: () => new Promise<void>((resolve) => { release = resolve; }) });
    const service = createUpdateService({ updater: port, currentVersion: '1.0.0' });
    const first = service.check();
    await service.check();
    expect(port.checkForUpdates).toHaveBeenCalledTimes(1);
    emit('update-available', { version: '1.1.0' });
    emit('download-progress', { percent: 12.4 });
    expect(service.getStatus()).toMatchObject({ state: 'downloading', percent: 12, version: '1.1.0' });
    release();
    await first;
  });

  it('never leaks addresses or stack traces in its messages', () => {
    expect(friendlyUpdateError(new Error('HttpError: 404 https://github.com/x/y/latest.yml'))).toBe('No update information has been published yet.');
    expect(friendlyUpdateError(new Error('rate limit exceeded, 403'))).toBe('The update server is busy. Try again in a little while.');
    expect(friendlyUpdateError('weird')).toBe('The update check failed. Try again later.');
  });
});
