/**
 * Phase 8: how the main process starts failing, and how it stops. Everything here is Electron-free (the
 * Electron calls are injected from `main/index.ts`), so the policy is unit-tested rather than assumed.
 *
 * THE POLICY, in one place:
 *
 *  - RECOVERABLE (contained where it happens, logged, the app keeps running): a failed tray/notification/media
 *    key, a throwing subscriber, a failed window-state write, a playback save that cannot be written, a refused
 *    or failed media request, one unreadable audio file. These already have their own handlers and are NOT
 *    routed here.
 *  - FATAL (controlled termination, never "carry on"): a failure while STARTING the app after the database is
 *    open, an uncaught exception, an unhandled promise rejection. The state of the process is unknown, so it is
 *    logged, the library is closed cleanly (so the database is never left mid-write), the user is told, and the
 *    process exits with code 1. Nothing here resumes normal operation.
 *  - QUITTING: every quit request - however many arrive, from the window, the tray, the OS - waits for the
 *    one cleanup to finish; a cleanup that hangs is cut off after a bounded time so the user can always leave.
 */

export interface BeforeQuitEvent {
  preventDefault(): void;
}

export interface ShutdownCoordinatorOptions {
  /** Stops the application layer and closes the services (database last). Must be safe to call more than once. */
  readonly cleanup: () => Promise<void>;
  /** Asks the app to quit again once the cleanup is done (`app.quit`). */
  readonly quit: () => void;
  readonly log: (message: string, error: unknown) => void;
  /** A cleanup still running after this long is abandoned (and logged) so the app can always exit. Default 10 s. */
  readonly timeoutMs?: number;
}

export interface ShutdownCoordinator {
  /** The `before-quit` handler. */
  onBeforeQuit(event: BeforeQuitEvent): void;
  /** Runs the cleanup now (or joins the one already running). Never rejects. */
  shutdown(): Promise<void>;
  /** True once the cleanup has finished (or was abandoned): from then on a quit proceeds. */
  readonly isFinished: boolean;
}

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

export function createShutdownCoordinator(options: ShutdownCoordinatorOptions): ShutdownCoordinator {
  const { cleanup, quit, log } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  let running: Promise<void> | undefined;
  let finished = false;
  let quitScheduled = false;

  function shutdown(): Promise<void> {
    running ??= (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          cleanup(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`shutdown did not finish within ${timeoutMs} ms; quitting anyway`)), timeoutMs);
            timer.unref?.();
          }),
        ]);
      } catch (error) {
        // A cleanup that failed or hung must never trap the user in an app that cannot quit.
        log('[nova] error while shutting down:', error);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        finished = true;
      }
    })();
    return running;
  }

  return {
    get isFinished() {
      return finished;
    },
    shutdown,
    onBeforeQuit(event) {
      if (finished) return; // the cleanup is done: let the quit proceed
      // Every request while the cleanup is pending - the first AND any later one (a second tray click, the window
      // closing as well) - is held. A second request used to slip through unheld and could end the process mid-cleanup.
      event.preventDefault();
      if (quitScheduled) return;
      quitScheduled = true;
      void shutdown().then(quit);
    },
  };
}

/* ------------------------------------------------------------------ *
 * Fatal errors
 * ------------------------------------------------------------------ */

export type FatalKind = 'startup' | 'uncaught-exception' | 'unhandled-rejection';

export interface FatalErrorHandlerOptions {
  readonly log: (message: string, error: unknown) => void;
  /** Closes the library cleanly (the shutdown coordinator's `shutdown`). */
  readonly shutdown: () => Promise<void>;
  /** Tells the user (`dialog.showErrorBox`). */
  readonly showError: (title: string, detail: string) => void;
  /** Ends the process (`app.exit`) without further quit handling. */
  readonly exit: (code: number) => void;
}

export interface FatalErrorHandler {
  /** Never rejects. The first fatal error runs the sequence; later ones while it runs are only logged. */
  handle(kind: FatalKind, error: unknown): Promise<void>;
  readonly isHandling: boolean;
}

const HEADLINES: Readonly<Record<FatalKind, string>> = {
  startup: 'Nova Player could not start.',
  'uncaught-exception': 'Nova Player hit an unexpected error and must close.',
  'unhandled-rejection': 'Nova Player hit an unexpected error and must close.',
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createFatalErrorHandler(options: FatalErrorHandlerOptions): FatalErrorHandler {
  const { log, shutdown, showError, exit } = options;
  let handling = false;

  // Logging must never be the thing that fails (a broken console is a real case - see `isBrokenStdio`).
  const safeLog = (message: string, error: unknown): void => {
    try {
      log(message, error);
    } catch {
      // nowhere left to report to
    }
  };

  return {
    get isHandling() {
      return handling;
    },
    async handle(kind, error) {
      if (handling) {
        safeLog(`[nova] another fatal error (${kind}) while already shutting down:`, error);
        return;
      }
      handling = true;
      safeLog(`[nova] FATAL (${kind}):`, error);
      try {
        await shutdown(); // close the library first, so the database is never left mid-write behind an open dialog
      } catch (shutdownError) {
        safeLog('[nova] the library could not be closed cleanly after a fatal error:', shutdownError);
      }
      try {
        showError('Nova Player', `${HEADLINES[kind]}\n\n${messageOf(error)}\n\nYour music files are untouched. Start Nova Player again to continue.`);
      } catch (dialogError) {
        safeLog('[nova] could not show the error dialog:', dialogError);
      }
      exit(1);
    },
  };
}

/** A write to a closed stdout/stderr (a GUI app launched without a console) is not an application fault, and
 *  reporting it would try to write to the same dead stream again. */
export function isBrokenStdio(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, syscall } = error as { code?: unknown; syscall?: unknown };
  return (code === 'EPIPE' || code === 'EIO' || code === 'ERR_STREAM_DESTROYED') && (syscall === undefined || syscall === 'write');
}

/** The slice of `process` the policy needs. */
export interface ProcessLike {
  on(event: 'uncaughtException', listener: (error: Error, origin: string) => void): unknown;
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown;
  off(event: 'uncaughtException', listener: (error: Error, origin: string) => void): unknown;
  off(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown;
}

/**
 * Routes the two process-wide failure signals to the fatal handler. Electron's own default for an uncaught
 * exception is a dialog after which the app carries on in an unknown state; for an unhandled rejection it is a
 * console warning and carrying on. Neither is acceptable for a process that owns a database, so both end the
 * app in a controlled way instead. The fire-and-forget calls in the main process each have their own `catch`
 * (see `electron-shell.ts`), so an ordinary operation does not end up here. Returns the function that removes them.
 */
export function installProcessErrorPolicy(processLike: ProcessLike, fatal: FatalErrorHandler): () => void {
  const onException = (error: Error, origin: string): void => {
    if (isBrokenStdio(error)) return;
    void fatal.handle(origin === 'unhandledRejection' ? 'unhandled-rejection' : 'uncaught-exception', error);
  };
  const onRejection = (reason: unknown): void => {
    if (isBrokenStdio(reason)) return;
    void fatal.handle('unhandled-rejection', reason);
  };
  processLike.on('uncaughtException', onException);
  processLike.on('unhandledRejection', onRejection);
  return () => {
    processLike.off('uncaughtException', onException);
    processLike.off('unhandledRejection', onRejection);
  };
}
