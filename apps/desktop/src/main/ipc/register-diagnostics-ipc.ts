import type { IpcContract } from '@nova/shared';
import { ForbiddenSenderError } from './ipc-errors.js';
import { InvalidRequestError, isRecord, rejectUnknownKeys, validateNoRequest } from './validation.js';
import type { IpcRegistrar } from './register-library-ipc.js';

/**
 * The three Phase 0 channels (`app:ping`, `diagnostics:checkDatabase`, `diagnostics:getSeekSpikeMediaUrl`).
 *
 * Phase 8: they used to be registered straight on `ipcMain` with no sender check and no validation, unlike every
 * later channel. They now follow the same rules: the call must come from the application's own window, the
 * request is validated, and the spike channel - which names an absolute path of the source checkout - exists
 * only in an unpackaged (development / test) run. A packaged app refuses it outright.
 */
export interface DiagnosticsIpcDependencies {
  readonly registrar: IpcRegistrar;
  readonly isTrustedSender: (event: unknown) => boolean;
  readonly checkDatabase: () => IpcContract['diagnostics:checkDatabase']['response'];
  /** `undefined` in a packaged app: the spike channel then refuses every call. */
  readonly seekSpikeMediaUrl: (() => IpcContract['diagnostics:getSeekSpikeMediaUrl']['response']) | undefined;
  readonly now?: () => number;
}

export const MAX_PING_NONCE_LENGTH = 200;

export function validatePing(raw: unknown): IpcContract['app:ping']['request'] {
  if (!isRecord(raw)) throw new InvalidRequestError('Expected an object with a "nonce".');
  rejectUnknownKeys(raw, ['nonce']);
  const { nonce } = raw;
  if (typeof nonce !== 'string' || nonce.length > MAX_PING_NONCE_LENGTH) {
    throw new InvalidRequestError(`"nonce" must be a string of at most ${MAX_PING_NONCE_LENGTH} characters.`);
  }
  return { nonce };
}

export function registerDiagnosticsIpc(dependencies: DiagnosticsIpcDependencies): void {
  const { registrar, isTrustedSender, checkDatabase, seekSpikeMediaUrl } = dependencies;
  const now = dependencies.now ?? Date.now;

  // These three keep their original plain (non-`IpcResult`) responses, so a refusal is a rejected invoke, with a fixed message.
  registrar.handle('app:ping', (event, raw): IpcContract['app:ping']['response'] => {
    if (!isTrustedSender(event)) throw new ForbiddenSenderError();
    const request = validatePing(raw);
    return { nonce: request.nonce, pong: true, receivedAtMs: now() };
  });

  registrar.handle('diagnostics:checkDatabase', (event, raw): IpcContract['diagnostics:checkDatabase']['response'] => {
    if (!isTrustedSender(event)) throw new ForbiddenSenderError();
    validateNoRequest(raw);
    return checkDatabase();
  });

  registrar.handle('diagnostics:getSeekSpikeMediaUrl', (event, raw): IpcContract['diagnostics:getSeekSpikeMediaUrl']['response'] => {
    if (!isTrustedSender(event)) throw new ForbiddenSenderError();
    validateNoRequest(raw);
    if (seekSpikeMediaUrl === undefined) throw new InvalidRequestError('This diagnostic is not available in the packaged application.');
    return seekSpikeMediaUrl();
  });
}
