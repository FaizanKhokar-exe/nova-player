import { CollectionsApplicationError, FileSystemError, LibraryApplicationError, PlaybackApplicationError, ScanError, TrackSidecarError } from '@nova/infrastructure';
import type { IpcError, IpcErrorCode } from '@nova/shared';
import { InvalidRequestError } from './validation.js';

/** Raised for a call that did not come from the application's own window. */
export class ForbiddenSenderError extends Error {
  constructor() {
    super('This request did not come from the application window.');
    this.name = 'ForbiddenSenderError';
  }
}

/** Plain-language messages for disk failures. The raw error (which names Node
 *  internals and errno codes) stays in the main process. */
const FILESYSTEM_MESSAGES: Record<string, string> = {
  'not-found': 'That path could not be found.',
  'access-denied': 'Access to that location was denied.',
  'not-a-directory': 'That path is not a folder.',
  'not-a-file': 'That path is not a file.',
  'outside-root': 'That path is outside the library folder.',
  'io-error': 'The file system reported an error.',
};

export const INTERNAL_MESSAGE = 'Something went wrong. The details were written to the application log.';

/**
 * Turns anything thrown by a handler into the one serializable error shape.
 * Only errors this application defines produce specific codes and messages;
 * everything else becomes a generic `internal` error and is handed to `log`
 * (main process only), so no stack trace, SQLite message or Node detail ever
 * reaches the renderer.
 */
export function toIpcError(error: unknown, operation: string, log: (message: string, error: unknown) => void): IpcError {
  const make = (code: IpcErrorCode, message: string): IpcError => ({ code, message, operation });

  if (error instanceof InvalidRequestError) return make('invalid-request', error.message);
  if (error instanceof ForbiddenSenderError) return make('forbidden', error.message);
  if (error instanceof LibraryApplicationError) return make(error.code, error.message);
  if (error instanceof CollectionsApplicationError) return make(error.code, error.message);
  if (error instanceof PlaybackApplicationError) return make(error.code, error.message);
  if (error instanceof TrackSidecarError) return make(error.code === 'invalid-id' ? 'invalid-request' : 'track-not-found', error.message);
  if (error instanceof ScanError) {
    if (error.code === 'root-unavailable' || error.code === 'root-not-directory') return make(error.code, error.message);
  }
  if (error instanceof FileSystemError) {
    if (error.code === 'invalid-path') return make('invalid-path', 'That path is not valid.');
    return make('filesystem-error', FILESYSTEM_MESSAGES[error.code] ?? FILESYSTEM_MESSAGES['io-error']!);
  }

  log(`[nova] unexpected error in ${operation}`, error);
  return make('internal', INTERNAL_MESSAGE);
}
