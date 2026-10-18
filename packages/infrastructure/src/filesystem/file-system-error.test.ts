import { describe, expect, it } from 'vitest';
import { FileSystemError, toFileSystemError } from './file-system-error.js';

const errno = (code: string): Error & { code: string } => Object.assign(new Error(`${code}: something`), { code });

describe('toFileSystemError', () => {
  it.each([
    ['ENOENT', 'stat', 'not-found'],
    ['ENOENT', 'readdir', 'not-found'],
    ['ENOTDIR', 'readdir', 'not-a-directory'],
    ['ENOTDIR', 'stat', 'not-found'], // a parent component is a file
    ['ENOTDIR', 'realpath', 'not-found'],
    ['EISDIR', 'stat', 'not-a-file'],
    ['EACCES', 'stat', 'access-denied'],
    ['EACCES', 'readdir', 'access-denied'],
    ['EPERM', 'stat', 'access-denied'],
    ['ENAMETOOLONG', 'stat', 'invalid-path'],
    ['EINVAL', 'readdir', 'invalid-path'],
    ['ERR_INVALID_ARG_VALUE', 'stat', 'invalid-path'],
    ['EMFILE', 'readdir', 'io-error'],
    ['EIO', 'stat', 'io-error'],
    ['ELOOP', 'realpath', 'io-error'],
  ] as const)('%s during %s -> %s', (nodeCode, operation, expected) => {
    expect(toFileSystemError(errno(nodeCode), 'C:\\x', operation).code).toBe(expected);
  });

  it('keeps the path and the original error as cause', () => {
    const original = errno('EACCES');
    const error = toFileSystemError(original, 'C:\\secret', 'stat');
    expect(error).toBeInstanceOf(FileSystemError);
    expect(error.name).toBe('FileSystemError');
    expect(error.path).toBe('C:\\secret');
    expect(error.cause).toBe(original);
    expect(error.message).toContain('C:\\secret');
  });

  it('names the underlying errno in an io-error so it can be diagnosed', () => {
    expect(toFileSystemError(errno('EMFILE'), 'C:\\x', 'stat').message).toContain('EMFILE');
  });

  it('handles values that are not Node errors', () => {
    expect(toFileSystemError('boom', 'C:\\x', 'stat').code).toBe('io-error');
    expect(toFileSystemError(undefined, 'C:\\x', 'stat').code).toBe('io-error');
    expect(toFileSystemError(new Error('plain'), 'C:\\x', 'stat').message).toContain('plain');
  });

  it('returns an existing FileSystemError unchanged', () => {
    const existing = new FileSystemError('invalid-path', 'bad', { path: 'x' });
    expect(toFileSystemError(existing, 'other', 'stat')).toBe(existing);
  });
});
