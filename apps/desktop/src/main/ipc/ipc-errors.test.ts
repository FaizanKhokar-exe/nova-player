import { FileSystemError, LibraryApplicationError, ScanError } from '@nova/infrastructure';
import { describe, expect, it } from 'vitest';
import { ForbiddenSenderError, INTERNAL_MESSAGE, toIpcError } from './ipc-errors.js';
import { InvalidRequestError } from './validation.js';

function convert(error: unknown): { result: ReturnType<typeof toIpcError>; logged: unknown[] } {
  const logged: unknown[] = [];
  return { result: toIpcError(error, 'library:test', (_message, e) => logged.push(e)), logged };
}

describe('toIpcError', () => {
  it('maps a bad request', () => {
    expect(convert(new InvalidRequestError('"limit" must be an integer')).result).toEqual({
      code: 'invalid-request', message: '"limit" must be an integer', operation: 'library:test',
    });
  });

  it('maps a forbidden sender', () => {
    expect(convert(new ForbiddenSenderError()).result.code).toBe('forbidden');
  });

  it.each(['root-unavailable', 'root-not-directory', 'root-exists', 'root-overlaps', 'root-not-found', 'no-roots', 'scan-running'] as const)(
    'passes the application error code %s through with its own message',
    (code) => {
      const { result, logged } = convert(new LibraryApplicationError(code, 'A plain message.'));
      expect(result).toEqual({ code, message: 'A plain message.', operation: 'library:test' });
      expect(logged).toEqual([]); // expected failures are not "errors" to log
    },
  );

  it('maps scan start-up errors that a user can act on', () => {
    expect(convert(new ScanError('root-unavailable', 'Library root is not available (not-found): /x')).result.code).toBe('root-unavailable');
    expect(convert(new ScanError('root-not-directory', 'not a folder')).result.code).toBe('root-not-directory');
  });

  it('turns a filesystem error into a plain-language one, hiding errno and Node detail', () => {
    const cause = Object.assign(new Error("EACCES: permission denied, scandir '/secret/dir'"), { code: 'EACCES' });
    const { result } = convert(new FileSystemError('access-denied', 'Access denied: /secret/dir', { path: '/secret/dir', cause }));
    expect(result).toEqual({ code: 'filesystem-error', message: 'Access to that location was denied.', operation: 'library:test' });
    expect(JSON.stringify(result)).not.toContain('EACCES');
    expect(JSON.stringify(result)).not.toContain('/secret');
  });

  it('an invalid path does not echo the path back', () => {
    const { result } = convert(new FileSystemError('invalid-path', 'Invalid path (x): C:\\bad|path', { path: 'C:\\bad|path' }));
    expect(result).toEqual({ code: 'invalid-path', message: 'That path is not valid.', operation: 'library:test' });
  });

  it.each([
    new Error('SQLITE_CORRUPT: database disk image is malformed'),
    new TypeError("Cannot read properties of undefined (reading 'x')"),
    'a thrown string',
    undefined,
    { code: 'EWHATEVER', stack: 'at secret (/home/user/app.js:1:1)' },
  ])('anything unexpected becomes a generic internal error and is logged, never forwarded: %s', (thrown) => {
    const { result, logged } = convert(thrown);
    expect(result).toEqual({ code: 'internal', message: INTERNAL_MESSAGE, operation: 'library:test' });
    expect(logged).toEqual([thrown]);
    const text = JSON.stringify(result);
    expect(text).not.toMatch(/SQLITE|TypeError|stack|\/home|secret|EWHATEVER/);
  });

  it('the result is plain serializable data', () => {
    const { result } = convert(new LibraryApplicationError('root-exists', 'm'));
    expect(structuredClone(result)).toEqual(result);
    expect(Object.keys(result).sort()).toEqual(['code', 'message', 'operation']);
  });
});
