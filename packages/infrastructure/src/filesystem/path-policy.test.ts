import { describe, expect, it } from 'vitest';
import { FileSystemError, type FileSystemErrorCode } from './file-system-error.js';
import { canonicalizePath, isPathWithin, pathComparisonKey, resolveWithin } from './path-policy.js';

/**
 * Every test here passes an explicit flavor, so the Windows rules run (and
 * are verified) on any host: they are pure string logic over
 * `node:path/win32`. What these tests CANNOT prove is how a real Windows
 * disk treats a path (see the limitations in the Phase 2C report).
 */
function expectError(fn: () => unknown, code: FileSystemErrorCode): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(FileSystemError);
    expect((error as FileSystemError).code).toBe(code);
    return;
  }
  throw new Error(`expected FileSystemError(${code}), nothing was thrown`);
}

const win = (p: string): string => canonicalizePath(p, 'win32');
const nix = (p: string): string => canonicalizePath(p, 'posix');

describe('canonicalizePath (win32)', () => {
  it.each([
    ['C:\\Music\\Song.mp3', 'C:\\Music\\Song.mp3'],
    ['C:/Music/Song.mp3', 'C:\\Music\\Song.mp3'],
    ['C:/Music\\Rock/Song.mp3', 'C:\\Music\\Rock\\Song.mp3'],
    ['C:\\Music\\\\Rock\\\\\\Song.mp3', 'C:\\Music\\Rock\\Song.mp3'],
    ['C:\\Music\\.\\Rock\\Song.mp3', 'C:\\Music\\Rock\\Song.mp3'],
    ['C:\\Music\\Old\\..\\Rock\\Song.mp3', 'C:\\Music\\Rock\\Song.mp3'],
    ['C:\\Music\\Rock\\', 'C:\\Music\\Rock'],
    ['C:\\Music\\Rock\\\\', 'C:\\Music\\Rock'],
    ['c:\\music\\Rock', 'C:\\music\\Rock'], // drive upper-cased, the rest's case kept
    ['C:\\', 'C:\\'],
    ['c:/', 'C:\\'],
    ['C:', undefined], // drive-relative: rejected, see below
  ])('%s -> %s', (input, expected) => {
    if (expected === undefined) expectError(() => win(input), 'invalid-path');
    else expect(win(input)).toBe(expected);
  });

  it('clamps ".." at the root exactly as Windows does (it cannot climb above C:\\)', () => {
    expect(win('C:\\..\\..\\Music')).toBe('C:\\Music');
  });

  it('keeps unicode, spaces and ordinary punctuation untouched', () => {
    expect(win('C:\\音楽\\Ünïcödé & Friends (2020) [Live]\\夜に駆ける - YOASOBI.mp3')).toBe(
      'C:\\音楽\\Ünïcödé & Friends (2020) [Live]\\夜に駆ける - YOASOBI.mp3',
    );
  });

  it('is idempotent', () => {
    for (const input of ['c:/a//b/../c/', '\\\\srv\\share\\x\\..\\y', '\\\\?\\C:\\a\\b']) {
      const once = win(input);
      expect(win(once)).toBe(once);
    }
  });

  describe('UNC shares', () => {
    it.each([
      ['\\\\server\\share\\Music\\a.mp3', '\\\\server\\share\\Music\\a.mp3'],
      ['//server/share/Music/a.mp3', '\\\\server\\share\\Music\\a.mp3'],
      ['\\\\server\\share\\Music\\', '\\\\server\\share\\Music'],
      ['\\\\server\\share', '\\\\server\\share\\'],
      ['\\\\Server\\Share\\x', '\\\\Server\\Share\\x'], // case preserved
    ])('%s -> %s', (input, expected) => {
      expect(win(input)).toBe(expected);
    });

    it('does not let ".." climb out of the share into the server', () => {
      expect(win('\\\\server\\share\\..\\..\\x')).toBe('\\\\server\\share\\x');
    });
  });

  describe('extended-length (\\\\?\\) paths', () => {
    it('unwraps a drive path', () => expect(win('\\\\?\\C:\\Music\\a.mp3')).toBe('C:\\Music\\a.mp3'));
    it('unwraps a UNC path', () => expect(win('\\\\?\\UNC\\server\\share\\a.mp3')).toBe('\\\\server\\share\\a.mp3'));
    it('does not let ".." escape the unwrapped UNC share', () => {
      expect(win('\\\\?\\UNC\\server\\share\\..\\..\\x')).toBe('\\\\server\\share\\x');
    });
    it.each(['\\\\?\\Volume{01234567-89ab-cdef-0123-456789abcdef}\\a', '\\\\?\\GLOBALROOT\\x', '\\\\.\\COM1', '\\\\.\\PhysicalDrive0', '//./C:/a'])(
      'rejects device/volume path %s',
      (input) => expectError(() => win(input), 'invalid-path'),
    );
  });

  describe('rejected as not absolute', () => {
    it.each(['Music\\Song.mp3', '.\\Song.mp3', '..\\Song.mp3', 'Song.mp3', 'C:Music\\Song.mp3', '\\Music\\Song.mp3', '/Music/Song.mp3', '\\\\server'])(
      '%s',
      (input) => expectError(() => win(input), 'invalid-path'),
    );
  });

  describe('rejected as unusable', () => {
    it.each([
      ['empty', ''],
      ['NUL character', 'C:\\Music\\a\0.mp3'],
      ['control character', 'C:\\Music\\a\n.mp3'],
      ['angle bracket', 'C:\\Music\\a<b.mp3'],
      ['pipe', 'C:\\Music\\a|b.mp3'],
      ['question mark', 'C:\\Music\\what?.mp3'],
      ['asterisk', 'C:\\Music\\*.mp3'],
      ['quote', 'C:\\Music\\"a".mp3'],
      ['stray colon / alternate data stream', 'C:\\Music\\a.mp3:stream'],
      ['segment ending in a dot', 'C:\\Music\\Dir.\\a.mp3'],
      ['segment ending in a space', 'C:\\Music\\Dir \\a.mp3'],
      ['reserved name CON', 'C:\\Music\\CON'],
      ['reserved name with extension', 'C:\\Music\\nul.txt'],
      ['reserved name COM1', 'C:\\Music\\COM1.mp3'],
      ['reserved name LPT9 (mixed case)', 'C:\\Music\\Lpt9'],
    ])('%s', (_label, input) => expectError(() => win(input), 'invalid-path'));

    it('does not over-reject names that merely start like a reserved one', () => {
      expect(win('C:\\Music\\CONSOLE.mp3')).toBe('C:\\Music\\CONSOLE.mp3');
      expect(win('C:\\Music\\COM10')).toBe('C:\\Music\\COM10');
      expect(win('C:\\Music\\NULL')).toBe('C:\\Music\\NULL');
      expect(win('C:\\Music\\AUXILIARY')).toBe('C:\\Music\\AUXILIARY');
    });

    it('rejects non-string input', () => {
      expectError(() => canonicalizePath(undefined as unknown as string, 'win32'), 'invalid-path');
      expectError(() => canonicalizePath(42 as unknown as string, 'win32'), 'invalid-path');
    });

    it('reports the offending path on the error', () => {
      try {
        win('relative\\path');
      } catch (error) {
        expect((error as FileSystemError).path).toBe('relative\\path');
        return;
      }
      throw new Error('expected an error');
    });
  });
});

describe('canonicalizePath (posix)', () => {
  it.each([
    ['/music/song.mp3', '/music/song.mp3'],
    ['/music//rock///song.mp3', '/music/rock/song.mp3'],
    ['//music/song.mp3', '/music/song.mp3'],
    ['/music/./rock/../pop/song.mp3', '/music/pop/song.mp3'],
    ['/music/rock/', '/music/rock'],
    ['/', '/'],
    ['/..', '/'],
    ['/Music/Song.mp3', '/Music/Song.mp3'], // case preserved
  ])('%s -> %s', (input, expected) => expect(nix(input)).toBe(expected));

  it('treats a backslash as an ordinary filename character, not a separator', () => {
    expect(nix('/music/a\\b.mp3')).toBe('/music/a\\b.mp3');
  });

  it('allows characters that are only illegal on Windows', () => {
    expect(nix('/music/what?: <a>|*.mp3')).toBe('/music/what?: <a>|*.mp3');
  });

  it.each(['music/song.mp3', './song.mp3', '', 'C:\\music'])('rejects %j (not absolute)', (input) => {
    expectError(() => nix(input), 'invalid-path');
  });

  it('rejects a NUL character', () => expectError(() => nix('/music/a\0b'), 'invalid-path'));
});

describe('pathComparisonKey', () => {
  it('makes Windows paths that differ only by case, slashes or trailing separator equal', () => {
    const keys = ['C:\\Music\\Song.mp3', 'c:\\music\\SONG.MP3', 'C:/Music//Song.mp3', 'c:/MUSIC/song.mp3'].map((p) =>
      pathComparisonKey(p, 'win32'),
    );
    expect(new Set(keys).size).toBe(1);
  });

  it('folds case in UNC host and share names too', () => {
    expect(pathComparisonKey('\\\\SERVER\\Share\\a', 'win32')).toBe(pathComparisonKey('\\\\server\\share\\A', 'win32'));
  });

  it('keeps genuinely different Windows paths different', () => {
    expect(pathComparisonKey('C:\\Music\\a.mp3', 'win32')).not.toBe(pathComparisonKey('C:\\Music\\b.mp3', 'win32'));
    expect(pathComparisonKey('C:\\Music\\a.mp3', 'win32')).not.toBe(pathComparisonKey('D:\\Music\\a.mp3', 'win32'));
  });

  it('does NOT fold case on POSIX, where the file system is case-sensitive', () => {
    expect(pathComparisonKey('/Music/a.mp3', 'posix')).not.toBe(pathComparisonKey('/music/a.mp3', 'posix'));
  });

  it('rejects invalid input just like canonicalizePath', () => {
    expectError(() => pathComparisonKey('relative', 'win32'), 'invalid-path');
  });
});

describe('isPathWithin', () => {
  it.each([
    ['C:\\Music', 'C:\\Music\\a.mp3', true],
    ['C:\\Music', 'C:\\Music\\Rock\\Deep\\a.mp3', true],
    ['C:\\Music', 'C:\\Music', true], // the root itself counts
    ['C:\\Music\\', 'C:\\Music\\a.mp3', true], // trailing separator on the root
    ['C:\\', 'C:\\Anything\\a.mp3', true], // a drive root contains its whole drive
    ['C:\\Music', 'c:\\MUSIC\\a.mp3', true], // case-insensitive on Windows
    ['C:\\Music', 'C:/Music/a.mp3', true], // slash style irrelevant
    ['C:\\Music', 'C:\\Music\\..foo\\a.mp3', true], // a name that merely starts with ".."
    ['C:\\Music', 'C:\\Music2\\a.mp3', false], // string-prefix trap
    ['C:\\Music', 'C:\\Music-old\\a.mp3', false],
    ['C:\\Music', 'C:\\a.mp3', false],
    ['C:\\Music', 'C:\\Music\\..\\Other\\a.mp3', false], // traversal out
    ['C:\\Music', 'C:\\Music\\..\\..\\Windows', false],
    ['C:\\Music', 'D:\\Music\\a.mp3', false], // different drive
    ['C:\\Music\\Rock', 'C:\\Music', false], // parent is not inside child
    ['\\\\srv\\share\\Music', '\\\\SRV\\SHARE\\music\\a.mp3', true],
    ['\\\\srv\\share\\Music', '\\\\srv\\other\\Music\\a.mp3', false],
  ])('win32: %s contains %s -> %s', (root, candidate, expected) => {
    expect(isPathWithin(root, candidate, 'win32')).toBe(expected);
  });

  it.each([
    ['/music', '/music/a.mp3', true],
    ['/music', '/music', true],
    ['/music', '/music2/a.mp3', false],
    ['/music', '/music/../etc/passwd', false],
    ['/music', '/Music/a.mp3', false], // case-sensitive
    ['/', '/anything', true],
  ])('posix: %s contains %s -> %s', (root, candidate, expected) => {
    expect(isPathWithin(root, candidate, 'posix')).toBe(expected);
  });

  it('throws for an invalid (e.g. relative) path instead of guessing', () => {
    expectError(() => isPathWithin('C:\\Music', 'a.mp3', 'win32'), 'invalid-path');
    expectError(() => isPathWithin('Music', 'C:\\Music\\a.mp3', 'win32'), 'invalid-path');
  });
});

describe('resolveWithin', () => {
  it.each([
    ['C:\\Music', 'Rock\\a.mp3', 'C:\\Music\\Rock\\a.mp3'],
    ['C:\\Music', 'Rock/a.mp3', 'C:\\Music\\Rock\\a.mp3'],
    ['C:\\Music\\', 'cover.jpg', 'C:\\Music\\cover.jpg'],
    ['C:\\Music', 'Rock\\..\\Pop\\a.mp3', 'C:\\Music\\Pop\\a.mp3'], // dips and stays inside
    ['C:\\Music', '', 'C:\\Music'],
    ['C:\\Music', '.', 'C:\\Music'],
    ['C:\\Music', 'Rock\\', 'C:\\Music\\Rock'],
  ])('win32: %s + %s -> %s', (root, relative, expected) => {
    expect(resolveWithin(root, relative, 'win32')).toBe(expected);
  });

  it.each(['..\\Other\\a.mp3', '..', 'Rock\\..\\..\\a.mp3', '../../Windows/System32', 'Rock\\..\\..\\Music2\\a.mp3'])(
    'win32: refuses to escape the root via %s',
    (relative) => expectError(() => resolveWithin('C:\\Music', relative, 'win32'), 'outside-root'),
  );

  it.each(['D:\\Other\\a.mp3', 'C:\\Windows', 'C:a.mp3', '\\Windows', '/Windows', '\\\\server\\share\\x'])(
    'win32: refuses an absolute/rooted/drive-qualified "relative" path %s',
    (relative) => expectError(() => resolveWithin('C:\\Music', relative, 'win32'), 'invalid-path'),
  );

  it('win32: a sibling whose name starts with the root name is still outside', () => {
    expectError(() => resolveWithin('C:\\Music', '..\\Music2\\a.mp3', 'win32'), 'outside-root');
  });

  it('win32: still validates the joined result (illegal characters)', () => {
    expectError(() => resolveWithin('C:\\Music', 'a|b.mp3', 'win32'), 'invalid-path');
  });

  it('posix: resolves inside and refuses to escape', () => {
    expect(resolveWithin('/music', 'rock/a.mp3', 'posix')).toBe('/music/rock/a.mp3');
    expect(resolveWithin('/music', 'rock/../pop/a.mp3', 'posix')).toBe('/music/pop/a.mp3');
    expectError(() => resolveWithin('/music', '../etc/passwd', 'posix'), 'outside-root');
    expectError(() => resolveWithin('/music', '/etc/passwd', 'posix'), 'invalid-path');
  });

  it('rejects an invalid root', () => {
    expectError(() => resolveWithin('Music', 'a.mp3', 'win32'), 'invalid-path');
  });
});
