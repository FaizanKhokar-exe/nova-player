import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileSystemError, type FileSystemErrorCode } from './file-system-error.js';
import { createNodeFileSystem } from './node-file-system.js';
import type { FileSystem } from './file-system.js';

/**
 * Real-disk tests against throwaway temp directories (never the user's own
 * files). They exercise the platform these tests run on; Windows-specific
 * disk behaviour (case-insensitivity, 8.3 names, junctions, reserved names)
 * cannot be observed on a non-Windows host and is NOT claimed verified here.
 */
let root: string;
let fileSystem: FileSystem;

beforeEach(() => {
  // realpath so the expectations hold even if the temp dir is itself a link (macOS).
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nova-fs-test-')));
  fileSystem = createNodeFileSystem();
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

async function expectFsError(promise: Promise<unknown>, code: FileSystemErrorCode): Promise<FileSystemError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(FileSystemError);
    expect((error as FileSystemError).code).toBe(code);
    return error as FileSystemError;
  }
  throw new Error(`expected FileSystemError(${code}), nothing was thrown`);
}

function write(relative: string, content: string | Buffer = 'x'): string {
  const full = path.join(root, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

/** Symlinks can need privileges on Windows; skip those tests if unavailable. */
function trySymlink(target: string, link: string, type: 'file' | 'dir'): boolean {
  try {
    fs.symlinkSync(target, link, type);
    return true;
  } catch {
    return false;
  }
}

describe('exists', () => {
  it('is true for a file and for a directory', async () => {
    const file = write('a.mp3');
    expect(await fileSystem.exists(file)).toBe(true);
    expect(await fileSystem.exists(root)).toBe(true);
  });

  it('is false for a missing path', async () => {
    expect(await fileSystem.exists(path.join(root, 'nope.mp3'))).toBe(false);
  });

  it('is false (not an error) when a parent component is a file', async () => {
    const file = write('a.mp3');
    expect(await fileSystem.exists(path.join(file, 'child'))).toBe(false);
  });

  it('is false for a broken symlink (it follows links)', async () => {
    const link = path.join(root, 'broken');
    if (!trySymlink(path.join(root, 'missing-target'), link, 'file')) return;
    expect(await fileSystem.exists(link)).toBe(false);
  });

  it('accepts an un-normalised spelling of a real path', async () => {
    write('sub/a.mp3');
    expect(await fileSystem.exists(path.join(root, 'sub', '..', 'sub', '.', 'a.mp3'))).toBe(true);
  });

  it.each(['', 'relative/a.mp3', './a.mp3', 'a.mp3'])('rejects %j instead of resolving it against the working directory', async (input) => {
    await expectFsError(fileSystem.exists(input), 'invalid-path');
  });

  it('rejects a path containing a NUL character', async () => {
    await expectFsError(fileSystem.exists(`${root}${path.sep}a\0b`), 'invalid-path');
  });
});

describe('stat', () => {
  it('reports a file: kind, exact size and canonical path', async () => {
    const file = write('song.mp3', Buffer.alloc(1234, 7));
    const stats = await fileSystem.stat(file);
    expect(stats).toEqual({ path: file, kind: 'file', sizeBytes: 1234, modifiedAtMs: expect.any(Number) });
  });

  it('reports a zero-byte file as size 0', async () => {
    expect((await fileSystem.stat(write('empty.mp3', ''))).sizeBytes).toBe(0);
  });

  it('reports a directory', async () => {
    expect((await fileSystem.stat(root)).kind).toBe('directory');
  });

  it('reports the modification time in whole milliseconds, exactly', async () => {
    const file = write('song.mp3');
    // .500 s is exactly representable as a float, so utimes stores it exactly.
    const when = new Date('2020-01-02T03:04:05.500Z');
    fs.utimesSync(file, when, when);
    const { modifiedAtMs } = await fileSystem.stat(file);
    expect(modifiedAtMs).toBe(when.getTime());
    expect(Number.isInteger(modifiedAtMs)).toBe(true);
  });

  it('agrees with an independent nanosecond-exact reading (rounded down to the millisecond)', async () => {
    const file = write('song.mp3');
    const { modifiedAtMs } = await fileSystem.stat(file);
    const exact = fs.statSync(file, { bigint: true }).mtimeNs / 1_000_000n;
    expect(modifiedAtMs).toBe(Number(exact));
  });

  it('sees a changed modification time and a changed size', async () => {
    const file = write('song.mp3', 'short');
    const base = new Date('2020-01-01T00:00:00.000Z');
    fs.utimesSync(file, base, base);
    const before = await fileSystem.stat(file);

    fs.writeFileSync(file, 'a much longer content');
    const later = new Date(base.getTime() + 60_000);
    fs.utimesSync(file, later, later);
    const after = await fileSystem.stat(file);

    expect(after.sizeBytes).toBeGreaterThan(before.sizeBytes);
    expect(after.modifiedAtMs).toBe(before.modifiedAtMs + 60_000);
  });

  it('returns a canonical path even when given a messy spelling', async () => {
    const file = write('sub/song.mp3');
    const stats = await fileSystem.stat(path.join(root, 'sub', '..', 'sub', 'song.mp3'));
    expect(stats.path).toBe(file);
  });

  it('follows a symlink to its target', async () => {
    const target = write('real.mp3', Buffer.alloc(10));
    const link = path.join(root, 'link.mp3');
    if (!trySymlink(target, link, 'file')) return;
    const stats = await fileSystem.stat(link);
    expect(stats.kind).toBe('file');
    expect(stats.sizeBytes).toBe(10);
  });

  it('throws not-found for a missing path, naming it', async () => {
    const missing = path.join(root, 'missing.mp3');
    const error = await expectFsError(fileSystem.stat(missing), 'not-found');
    expect(error.path).toBe(missing);
    expect(error.cause).toBeInstanceOf(Error);
  });

  it('throws not-found when a parent component is a file', async () => {
    const file = write('a.mp3');
    await expectFsError(fileSystem.stat(path.join(file, 'child')), 'not-found');
  });

  it('throws invalid-path for a relative path', async () => {
    await expectFsError(fileSystem.stat('a.mp3'), 'invalid-path');
  });
});

describe('statFile', () => {
  it('returns stats for a regular file', async () => {
    const file = write('song.mp3', 'abc');
    expect((await fileSystem.statFile(file)).sizeBytes).toBe(3);
  });

  it('throws not-a-file for a directory', async () => {
    const error = await expectFsError(fileSystem.statFile(root), 'not-a-file');
    expect(error.path).toBe(root);
  });

  it('throws not-found for a missing path', async () => {
    await expectFsError(fileSystem.statFile(path.join(root, 'nope')), 'not-found');
  });
});

describe('readDirectory', () => {
  it('lists immediate children with their kinds and joined canonical paths', async () => {
    write('a.mp3');
    write('Sub/inner.mp3');
    const entries = await fileSystem.readDirectory(root);
    expect(entries).toEqual([
      { name: 'Sub', path: path.join(root, 'Sub'), kind: 'directory' },
      { name: 'a.mp3', path: path.join(root, 'a.mp3'), kind: 'file' },
    ]);
  });

  it('distinguishes files from directories', async () => {
    write('file.txt');
    fs.mkdirSync(path.join(root, 'folder'));
    const kinds = Object.fromEntries((await fileSystem.readDirectory(root)).map((e) => [e.name, e.kind]));
    expect(kinds).toEqual({ 'file.txt': 'file', folder: 'directory' });
  });

  it('is NOT recursive', async () => {
    write('top.mp3');
    write('a/b/c/deep.mp3');
    const names = (await fileSystem.readDirectory(root)).map((e) => e.name);
    expect(names).toEqual(['a', 'top.mp3']);
  });

  it('returns an empty list for an empty directory', async () => {
    expect(await fileSystem.readDirectory(root)).toEqual([]);
  });

  it('includes hidden (dot) entries and never "." or ".."', async () => {
    write('.hidden');
    write('visible');
    expect((await fileSystem.readDirectory(root)).map((e) => e.name)).toEqual(['.hidden', 'visible']);
  });

  it('preserves unicode and spaces in names', async () => {
    write('夜に駆ける - YOASOBI.mp3');
    write('my song (live).mp3');
    const names = (await fileSystem.readDirectory(root)).map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(['夜に駆ける - YOASOBI.mp3', 'my song (live).mp3']));
  });

  describe('deterministic order', () => {
    const names = ['b.mp3', 'B.mp3', 'a.mp3', 'A.mp3', '10.mp3', '9.mp3', '_x.mp3', 'é.mp3', 'z.mp3'];

    it('sorts by UTF-16 code-unit order, independent of locale and case-folding', async () => {
      // Skipped-case-insensitive file systems can't hold both 'a' and 'A'; use only distinct-case-safe names there.
      names.forEach((n) => write(n));
      const listed = (await fileSystem.readDirectory(root)).map((e) => e.name);
      const expected = [...names].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
      // On a case-insensitive file system (macOS default) the B/A duplicates collapse; compare what exists.
      expect(listed).toEqual(expected.filter((n) => listed.includes(n)));
      expect(listed.indexOf('B.mp3')).toBeLessThan(listed.indexOf('a.mp3')); // uppercase before lowercase
      expect(listed.indexOf('10.mp3')).toBeLessThan(listed.indexOf('9.mp3')); // not natural/numeric order
    });

    it('returns the same order regardless of creation order, and on repeated calls', async () => {
      const other = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-fs-test-'));
      try {
        ['c', 'a', 'b'].forEach((n) => fs.writeFileSync(path.join(root, n), ''));
        ['b', 'c', 'a'].forEach((n) => fs.writeFileSync(path.join(other, n), ''));
        const first = (await fileSystem.readDirectory(root)).map((e) => e.name);
        const second = (await fileSystem.readDirectory(root)).map((e) => e.name);
        const fromOther = (await fileSystem.readDirectory(other)).map((e) => e.name);
        expect(first).toEqual(['a', 'b', 'c']);
        expect(second).toEqual(first);
        expect(fromOther).toEqual(first);
      } finally {
        fs.rmSync(other, { recursive: true, force: true });
      }
    });
  });

  it('reports a symlink as "symlink" without following it', async () => {
    const target = write('real.mp3');
    const dirTarget = path.join(root, 'realdir');
    fs.mkdirSync(dirTarget);
    const fileLink = trySymlink(target, path.join(root, 'link-to-file'), 'file');
    const dirLink = trySymlink(dirTarget, path.join(root, 'link-to-dir'), 'dir');
    if (!fileLink && !dirLink) return;
    const kinds = Object.fromEntries((await fileSystem.readDirectory(root)).map((e) => [e.name, e.kind]));
    if (fileLink) expect(kinds['link-to-file']).toBe('symlink');
    if (dirLink) expect(kinds['link-to-dir']).toBe('symlink');
    expect(kinds['real.mp3']).toBe('file');
    expect(kinds['realdir']).toBe('directory');
  });

  it('throws not-a-directory when the path is a file', async () => {
    const file = write('a.mp3');
    const error = await expectFsError(fileSystem.readDirectory(file), 'not-a-directory');
    expect(error.path).toBe(file);
  });

  it('throws not-found for a missing directory', async () => {
    await expectFsError(fileSystem.readDirectory(path.join(root, 'nope')), 'not-found');
  });

  it('throws invalid-path for a relative path', async () => {
    await expectFsError(fileSystem.readDirectory('music'), 'invalid-path');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'throws access-denied for an unreadable directory (real permissions; needs a non-root POSIX user)',
    async () => {
      const locked = path.join(root, 'locked');
      fs.mkdirSync(locked);
      fs.chmodSync(locked, 0o000);
      try {
        await expectFsError(fileSystem.readDirectory(locked), 'access-denied');
      } finally {
        fs.chmodSync(locked, 0o700);
      }
    },
  );
});

describe('realPath', () => {
  it('returns the canonical form of an existing path', async () => {
    const file = write('sub/a.mp3');
    expect(await fileSystem.realPath(path.join(root, 'sub', '..', 'sub', 'a.mp3'))).toBe(file);
  });

  it('resolves a symlink to its target', async () => {
    const target = write('real/a.mp3');
    const link = path.join(root, 'link.mp3');
    if (!trySymlink(target, link, 'file')) return;
    expect(await fileSystem.realPath(link)).toBe(target);
  });

  it('throws not-found for a missing path', async () => {
    await expectFsError(fileSystem.realPath(path.join(root, 'nope')), 'not-found');
  });

  it('throws invalid-path for a relative path', async () => {
    await expectFsError(fileSystem.realPath('a.mp3'), 'invalid-path');
  });
});
