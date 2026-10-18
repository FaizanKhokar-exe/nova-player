import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFatalErrorHandler,
  createShutdownCoordinator,
  installProcessErrorPolicy,
  isBrokenStdio,
  type BeforeQuitEvent,
  type FatalKind,
} from './lifecycle.js';

const quitEvent = (): BeforeQuitEvent & { prevented: number } => {
  const event = { prevented: 0, preventDefault: () => void (event.prevented += 1) };
  return event;
};

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void } {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('shutdown coordinator', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('the first quit request is held until the cleanup is done, then quits exactly once', async () => {
    const gate = deferred();
    const cleanup = vi.fn(() => gate.promise);
    const quit = vi.fn();
    const coordinator = createShutdownCoordinator({ cleanup, quit, log: vi.fn() });

    const first = quitEvent();
    coordinator.onBeforeQuit(first);
    expect(first.prevented).toBe(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(quit).not.toHaveBeenCalled();

    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(quit).toHaveBeenCalledTimes(1);
    expect(coordinator.isFinished).toBe(true);

    // The quit it asked for fires `before-quit` again: that one is allowed through.
    const second = quitEvent();
    coordinator.onBeforeQuit(second);
    expect(second.prevented).toBe(0);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('EVERY quit request while the cleanup is still running is held too (a second one must not end the process mid-cleanup)', async () => {
    const gate = deferred();
    const cleanup = vi.fn(() => gate.promise);
    const quit = vi.fn();
    const coordinator = createShutdownCoordinator({ cleanup, quit, log: vi.fn() });

    const events = [quitEvent(), quitEvent(), quitEvent()];
    for (const event of events) coordinator.onBeforeQuit(event);
    expect(events.map((event) => event.prevented)).toEqual([1, 1, 1]);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(quit).not.toHaveBeenCalled();

    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(quit).toHaveBeenCalledTimes(1); // however many requests arrived
  });

  it('a cleanup that fails is logged and the app still quits', async () => {
    const log = vi.fn();
    const quit = vi.fn();
    const failure = new Error('disk I/O error');
    const coordinator = createShutdownCoordinator({ cleanup: () => Promise.reject(failure), quit, log });
    coordinator.onBeforeQuit(quitEvent());
    await vi.advanceTimersByTimeAsync(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('shutting down'), failure);
    expect(quit).toHaveBeenCalledTimes(1);
    expect(coordinator.isFinished).toBe(true);
  });

  it('a cleanup that throws synchronously is handled the same way', async () => {
    const log = vi.fn();
    const quit = vi.fn();
    const coordinator = createShutdownCoordinator({
      cleanup: () => {
        throw new Error('sync failure');
      },
      quit,
      log,
    });
    coordinator.onBeforeQuit(quitEvent());
    await vi.advanceTimersByTimeAsync(0);
    expect(log).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it('a cleanup that never finishes is abandoned after the timeout, so the user can always leave', async () => {
    const log = vi.fn();
    const quit = vi.fn();
    const coordinator = createShutdownCoordinator({ cleanup: () => new Promise<void>(() => undefined), quit, log, timeoutMs: 5_000 });
    coordinator.onBeforeQuit(quitEvent());

    await vi.advanceTimersByTimeAsync(4_999);
    expect(quit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(quit).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: expect.stringContaining('5000 ms') }));
  });

  it('a cleanup that finishes in time leaves no timer running and logs nothing', async () => {
    const log = vi.fn();
    const coordinator = createShutdownCoordinator({ cleanup: () => Promise.resolve(), quit: vi.fn(), log, timeoutMs: 5_000 });
    coordinator.onBeforeQuit(quitEvent());
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(log).not.toHaveBeenCalled();
  });

  it('a cleanup that fails AFTER it was abandoned does not become an unhandled rejection', async () => {
    const late = deferred();
    const coordinator = createShutdownCoordinator({ cleanup: () => late.promise, quit: vi.fn(), log: vi.fn(), timeoutMs: 100 });
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      coordinator.onBeforeQuit(quitEvent());
      await vi.advanceTimersByTimeAsync(100);
      late.reject(new Error('too late'));
      await vi.advanceTimersByTimeAsync(10);
      vi.useRealTimers();
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('shutdown() joins one run no matter how often or from where it is called, and never rejects', async () => {
    const gate = deferred();
    const cleanup = vi.fn(() => gate.promise);
    const coordinator = createShutdownCoordinator({ cleanup, quit: vi.fn(), log: vi.fn() });
    const a = coordinator.shutdown();
    const b = coordinator.shutdown();
    expect(a).toBe(b);
    gate.reject(new Error('boom'));
    await expect(a).resolves.toBeUndefined();
    await expect(coordinator.shutdown()).resolves.toBeUndefined();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});

describe('fatal error handler', () => {
  function setup(overrides: Partial<Parameters<typeof createFatalErrorHandler>[0]> = {}) {
    const order: string[] = [];
    const log = vi.fn((message: string) => void order.push(`log:${message}`));
    const shutdown = vi.fn(async () => void order.push('shutdown'));
    const showError = vi.fn((_title: string, _detail: string) => void order.push('showError'));
    const exit = vi.fn((_code: number) => void order.push('exit'));
    const handler = createFatalErrorHandler({ log, shutdown, showError, exit, ...overrides });
    return { handler, log, shutdown, showError, exit, order };
  }

  it('logs, closes the library, tells the user, then exits with code 1 - in that order, and never resumes', async () => {
    const { handler, order, exit, showError } = setup();
    await handler.handle('uncaught-exception', new Error('kaboom'));
    expect(order).toEqual(['log:[nova] FATAL (uncaught-exception):', 'shutdown', 'showError', 'exit']);
    expect(exit).toHaveBeenCalledWith(1);
    const [title, detail] = showError.mock.calls[0]!;
    expect(title).toBe('Nova Player');
    expect(detail).toContain('kaboom');
    expect(detail).toContain('must close');
    expect(detail).toContain('music files are untouched');
  });

  it('a startup failure says the app could not start', async () => {
    const { handler, showError } = setup();
    await handler.handle('startup', new Error('no window'));
    expect(showError.mock.calls[0]![1]).toContain('could not start');
  });

  it('a failure to close the library is logged, and the user is still told and the process still exits', async () => {
    const { handler, log, showError, exit } = setup({ shutdown: () => Promise.reject(new Error('db busy')) });
    await handler.handle('unhandled-rejection', new Error('x'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('could not be closed cleanly'), expect.any(Error));
    expect(showError).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('a dialog that cannot be shown does not stop the exit', async () => {
    const { handler, exit } = setup({
      showError: () => {
        throw new Error('no display');
      },
    });
    await handler.handle('startup', 'a string, not an Error');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('a logger that throws (a dead console) does not stop the sequence', async () => {
    const { handler, exit, showError } = setup({
      log: () => {
        throw new Error('EPIPE');
      },
    });
    await handler.handle('uncaught-exception', new Error('boom'));
    expect(showError).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('only the FIRST fatal error runs the sequence; later ones while it runs are only logged', async () => {
    const gate = deferred();
    const shutdown = vi.fn(() => gate.promise);
    const { handler, exit, showError, log } = setup({ shutdown });
    const first = handler.handle('uncaught-exception', new Error('one'));
    expect(handler.isHandling).toBe(true);
    await handler.handle('unhandled-rejection', new Error('two'));
    await handler.handle('uncaught-exception', new Error('three'));
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('another fatal error (unhandled-rejection)'), expect.any(Error));
    gate.resolve();
    await first;
    expect(showError).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});

describe('isBrokenStdio', () => {
  it.each([
    [{ code: 'EPIPE', syscall: 'write' }, true],
    [{ code: 'EIO', syscall: 'write' }, true],
    [{ code: 'ERR_STREAM_DESTROYED' }, true],
    [{ code: 'EPIPE' }, true],
    [{ code: 'EPIPE', syscall: 'read' }, false],
    [{ code: 'ENOENT', syscall: 'write' }, false],
    [new Error('plain'), false],
    ['EPIPE', false],
    [null, false],
    [undefined, false],
  ])('%j -> %s', (error, expected) => {
    expect(isBrokenStdio(error)).toBe(expected);
  });
});

describe('process error policy', () => {
  function setup() {
    const processLike = new EventEmitter();
    const handled: { kind: FatalKind; error: unknown }[] = [];
    const fatal = {
      isHandling: false,
      handle: vi.fn(async (kind: FatalKind, error: unknown) => void handled.push({ kind, error })),
    };
    return { processLike, fatal, handled };
  }

  it('an uncaught exception and an unhandled rejection both end in the fatal handler', () => {
    const { processLike, fatal, handled } = setup();
    installProcessErrorPolicy(processLike, fatal);
    const exception = new Error('thrown');
    const rejection = new Error('rejected');
    processLike.emit('uncaughtException', exception, 'uncaughtException');
    processLike.emit('unhandledRejection', rejection);
    expect(handled).toEqual([
      { kind: 'uncaught-exception', error: exception },
      { kind: 'unhandled-rejection', error: rejection },
    ]);
  });

  it('an exception whose origin is a rejection (strict mode) is reported as one', () => {
    const { processLike, fatal, handled } = setup();
    installProcessErrorPolicy(processLike, fatal);
    processLike.emit('uncaughtException', new Error('x'), 'unhandledRejection');
    expect(handled[0]!.kind).toBe('unhandled-rejection');
  });

  it('a write to a dead console is not an application fault', () => {
    const { processLike, fatal } = setup();
    installProcessErrorPolicy(processLike, fatal);
    processLike.emit('uncaughtException', Object.assign(new Error('write EPIPE'), { code: 'EPIPE', syscall: 'write' }), 'uncaughtException');
    processLike.emit('unhandledRejection', Object.assign(new Error('write EIO'), { code: 'EIO', syscall: 'write' }));
    expect(fatal.handle).not.toHaveBeenCalled();
  });

  it('installs one listener per signal, and the returned function removes exactly those', () => {
    const { processLike, fatal } = setup();
    processLike.on('uncaughtException', () => undefined); // someone else's listener must survive
    const remove = installProcessErrorPolicy(processLike, fatal);
    expect(processLike.listenerCount('uncaughtException')).toBe(2);
    expect(processLike.listenerCount('unhandledRejection')).toBe(1);
    remove();
    expect(processLike.listenerCount('uncaughtException')).toBe(1);
    expect(processLike.listenerCount('unhandledRejection')).toBe(0);
  });

  it('repeated install / remove cycles never accumulate listeners', () => {
    const { processLike, fatal } = setup();
    for (let i = 0; i < 25; i += 1) installProcessErrorPolicy(processLike, fatal)();
    expect(processLike.listenerCount('uncaughtException')).toBe(0);
    expect(processLike.listenerCount('unhandledRejection')).toBe(0);
  });
});
