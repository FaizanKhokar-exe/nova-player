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
    const service = createUpdateService({ updater: port, currentVersion: '0.15.2' });
    service.install();
    expect(port.quitAndInstall).not.toHaveBeenCalled();
    await service.download(); // nothing found yet: no download
    expect(port.downloadUpdate).not.toHaveBeenCalled();
    expect(await service.check()).toMatchObject({ state: 'available', version: '0.16.0' });
    expect(await service.download()).toMatchObject({ state: 'ready', version: '0.16.0', percent: 100 });
    service.install();
    expect(port.quitAndInstall).toHaveBeenCalledWith(true, true);
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
