import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMediaAccess, contentTypeForFile } from './media-access.js';
import { createMediaKit, flacFixture, type MediaKit } from './media-test-kit.js';
import { makeTrack } from '../repositories/test-tracks.js';

let kit: MediaKit;
beforeEach(() => {
  kit = createMediaKit();
});
afterEach(() => kit.close());

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

describe('createMediaAccess: what may be heard', () => {
  it('serves a file inside a registered root, resolving to its real path and content type', async () => {
    kit.addRoot('music');
    const track = kit.addTrack('music/song.mp3');
    const resolution = await kit.access.resolveTrack(track.id);
    expect(resolution).toEqual({ ok: true, filePath: track.sourcePath, contentType: 'audio/mpeg' });
  });

  it('serves a deeply nested file and a Unicode / spaced file name', async () => {
    kit.addRoot('music');
    const nested = kit.addTrack('music/Artist/Album (1999)/CD 2/夜に駆ける – Ünïcödé.flac', flacFixture);
    const resolution = await kit.access.resolveTrack(nested.id);
    expect(resolution).toEqual({ ok: true, filePath: nested.sourcePath, contentType: 'audio/flac' });
  });

  it('answers per request and never caches: removing the root stops access at once', async () => {
    const root = kit.addRoot('music');
    const track = kit.addTrack('music/song.mp3');
    expect((await kit.access.resolveTrack(track.id)).ok).toBe(true);

    kit.libraryRootRepository.delete(root.id);
    expect(await kit.access.resolveTrack(track.id)).toEqual({ ok: false, denial: 'root-not-registered' });
  });

  it('refuses a track whose root was removed even though the file and the track row still exist', async () => {
    const root = kit.addRoot('music');
    const track = kit.addTrack('music/song.mp3');
    kit.libraryRootRepository.delete(root.id);
    expect(fs.existsSync(track.sourcePath)).toBe(true);
    expect(kit.trackRepository.getById(track.id)).toBeDefined();
    expect(await kit.access.resolveTrack(track.id)).toEqual({ ok: false, denial: 'root-not-registered' });
  });
});

describe('createMediaAccess: refusing what is not a library track', () => {
  it.each([[''], ['not-a-uuid'], ['../../etc/passwd'], ['..%2f..%2fetc%2fpasswd'], ['123e4567-e89b-42d3-a456-426614174000/../x'], ['123e4567-e89b-12d3-a456-426614174000'], ['a'.repeat(5000)]])(
    'refuses the malformed id %j',
    async (id) => {
      expect(await kit.access.resolveTrack(id)).toEqual({ ok: false, denial: 'invalid-id' });
    },
  );

  it('refuses a non-string id', async () => {
    expect(await kit.access.resolveTrack(42 as unknown as string)).toEqual({ ok: false, denial: 'invalid-id' });
    expect(await kit.access.resolveTrack(undefined as unknown as string)).toEqual({ ok: false, denial: 'invalid-id' });
  });

  it('refuses a well-formed id that is not in the library', async () => {
    kit.addRoot('music');
    expect(await kit.access.resolveTrack(crypto.randomUUID())).toEqual({ ok: false, denial: 'track-not-found' });
  });

  it('refuses a track that lies in no registered root at all (an orphan)', async () => {
    kit.addRoot('music');
    const orphan = kit.addTrack('elsewhere/song.mp3');
    expect(await kit.access.resolveTrack(orphan.id)).toEqual({ ok: false, denial: 'root-not-registered' });
  });

  it('refuses a sibling folder that merely shares the root name as a prefix', async () => {
    kit.addRoot('music');
    const sibling = kit.addTrack('music2/song.mp3');
    const secret = kit.addTrack('music-secret/song.mp3');
    expect(await kit.access.resolveTrack(sibling.id)).toEqual({ ok: false, denial: 'root-not-registered' });
    expect(await kit.access.resolveTrack(secret.id)).toEqual({ ok: false, denial: 'root-not-registered' });
  });

  /** Defense in depth: even if a hostile or corrupt path were already in the store (the real
   *  repository rejects some of these at insert time), the access check must still refuse it. */
  function accessOverStoredPath(storedPath: string) {
    const track = makeTrack({ sourcePath: storedPath });
    const access = createMediaAccess({
      trackRepository: { getById: (id) => (id === track.id ? track : undefined) },
      libraryRootRepository: kit.libraryRootRepository,
      fileSystem: kit.fileSystem,
    });
    return { track, access };
  }

  it('refuses a stored path that uses ".." to climb out of the root', async () => {
    const root = kit.addRoot('music');
    kit.addTrack('outside/secret.mp3');
    const { track, access } = accessOverStoredPath(`${root.path}/../outside/secret.mp3`);
    // The path policy normalises it first: it resolves outside the root, so it is not "inside".
    expect(await access.resolveTrack(track.id)).toEqual({ ok: false, denial: 'root-not-registered' });
  });

  it('refuses an absolute path outside the root', async () => {
    kit.addRoot('music');
    const { track, access } = accessOverStoredPath('/etc/passwd.mp3');
    expect(await access.resolveTrack(track.id)).toEqual({ ok: false, denial: 'root-not-registered' });
  });

  it('refuses a relative stored path (it is inside nothing)', async () => {
    kit.addRoot('music');
    const { track, access } = accessOverStoredPath('music/song.mp3');
    expect(await access.resolveTrack(track.id)).toEqual({ ok: false, denial: 'root-not-registered' });
  });

  it('fails closed on a stored path the path policy cannot interpret (NUL character)', async () => {
    const root = kit.addRoot('music');
    const { track, access } = accessOverStoredPath(`${root.path}/a\0.mp3`);
    expect(await access.resolveTrack(track.id)).toEqual({ ok: false, denial: 'root-not-registered' });
  });
});

describe('createMediaAccess: the root itself', () => {
  it('refuses with root-unavailable when the root folder has gone missing', async () => {
    const root = kit.addRoot('music');
    const track = kit.addTrack('music/song.mp3');
    fs.renameSync(root.path, `${root.path}-unplugged`);
    expect(await kit.access.resolveTrack(track.id)).toEqual({ ok: false, denial: 'root-unavailable' });
  });

  it('serves again once the root is back (an unavailable root is not a permanent denial)', async () => {
    const root = kit.addRoot('music');
    const track = kit.addTrack('music/song.mp3');
    fs.renameSync(root.path, `${root.path}-unplugged`);
    expect((await kit.access.resolveTrack(track.id)).ok).toBe(false);
    fs.renameSync(`${root.path}-unplugged`, root.path);
    expect((await kit.access.resolveTrack(track.id)).ok).toBe(true);
  });

  it('refuses with root-changed when the registered folder was replaced by a link to somewhere else', async () => {
    const root = kit.addRoot('music');
    const track = kit.addTrack('music/song.mp3');
    // The attacker/accident: `music` becomes a link to a folder that happens to hold the same file name.
    const elsewhere = path.join(kit.sandbox, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.copyFileSync(track.sourcePath, path.join(elsewhere, 'song.mp3'));
    fs.rmSync(root.path, { recursive: true });
    fs.symlinkSync(elsewhere, root.path, 'dir');

    expect(await kit.access.resolveTrack(track.id)).toEqual({ ok: false, denial: 'root-changed' });
  });

  it('a root that is a link at registration time is fine only if registered by its real path', async () => {
    // LibraryApplication.addRoot stores `realPath`, so a registered root is always a real path.
    const real = kit.addRoot('real-music');
    const track = kit.addTrack('real-music/song.mp3');
    const alias = path.join(kit.sandbox, 'alias');
    fs.symlinkSync(real.path, alias, 'dir');
    // The track row's path goes through the alias, but the registered root is the real folder.
    const viaAlias = kit.addTrackRecordOnly(path.join(alias, 'song.mp3'));
    expect(await kit.access.resolveTrack(track.id)).toMatchObject({ ok: true });
    // An alias path lies in no registered root lexically, so it is refused rather than guessed at.
    expect(await kit.access.resolveTrack(viaAlias.id)).toEqual({ ok: false, denial: 'root-not-registered' });
  });
});

describe('createMediaAccess: symlinks and junctions (the Phase 2 policy: links are never followed out)', () => {
  it('refuses a file symlink inside the root that points at a file outside it', async () => {
    const root = kit.addRoot('music');
    const secret = path.join(kit.sandbox, 'secret', 'private.mp3');
    fs.mkdirSync(path.dirname(secret));
    fs.copyFileSync(flacFixture, secret);
    const link = path.join(root.path, 'innocent.mp3');
    fs.symlinkSync(secret, link);
    const track = kit.addTrackRecordOnly(link);

    expect(await kit.access.resolveTrack(track.id)).toEqual({ ok: false, denial: 'outside-root' });
  });

  it('refuses a file reached through a directory symlink that leaves the root', async () => {
    const root = kit.addRoot('music');
    const outsideDir = path.join(kit.sandbox, 'outside');
    fs.mkdirSync(outsideDir);
    fs.copyFileSync(flacFixture, path.join(outsideDir, 'x.mp3'));
    fs.symlinkSync(outsideDir, path.join(root.path, 'portal'), 'dir');
    const track = kit.addTrackRecordOnly(path.join(root.path, 'portal', 'x.mp3'));

    expect(await kit.access.resolveTrack(track.id)).toEqual({ ok: false, denial: 'outside-root' });
  });

  it('allows a symlink whose real target stays inside the root, and opens the verified real path', async () => {
    const root = kit.addRoot('music');
    const real = kit.addTrack('music/real/song.mp3');
    const link = path.join(root.path, 'alias.mp3');
    fs.symlinkSync(real.sourcePath, link);
    const viaLink = kit.addTrackRecordOnly(link);

    const resolution = await kit.access.resolveTrack(viaLink.id);
    expect(resolution).toEqual({ ok: true, filePath: real.sourcePath, contentType: 'audio/mpeg' });
  });

  it('refuses a dangling symlink as a missing file', async () => {
    const root = kit.addRoot('music');
    const link = path.join(root.path, 'dangling.mp3');
    fs.symlinkSync(path.join(kit.sandbox, 'does-not-exist.mp3'), link);
    const track = kit.addTrackRecordOnly(link);
    expect(await kit.access.resolveTrack(track.id)).toEqual({ ok: false, denial: 'file-missing' });
  });
});

describe('createMediaAccess: the file itself', () => {
  it('refuses a file that no longer exists', async () => {
    kit.addRoot('music');
    const track = kit.addTrack('music/song.mp3');
    fs.rmSync(track.sourcePath);
    expect(await kit.access.resolveTrack(track.id)).toEqual({ ok: false, denial: 'file-missing' });
  });

  it('refuses a directory where a file was expected', async () => {
    const root = kit.addRoot('music');
    const dir = path.join(root.path, 'folder.mp3');
    fs.mkdirSync(dir);
    const track = kit.addTrackRecordOnly(dir);
    expect(await kit.access.resolveTrack(track.id)).toEqual({ ok: false, denial: 'not-a-file' });
  });

  it.each(['notes.txt', 'archive.zip', 'script.js', 'noextension', '.mp3'])('refuses a non-audio file name (%s)', async (name) => {
    kit.addRoot('music');
    const track = kit.addTrack(`music/${name}`, Buffer.from('not music'));
    expect(await kit.access.resolveTrack(track.id)).toEqual({ ok: false, denial: 'unsupported-format' });
  });

  it.skipIf(isRoot)('refuses a file the OS will not let us open (access denied)', async () => {
    const root = kit.addRoot('music');
    const dir = path.join(root.path, 'locked');
    fs.mkdirSync(dir);
    const track = kit.addTrack('music/locked/song.mp3');
    fs.chmodSync(dir, 0o000);
    try {
      expect(await kit.access.resolveTrack(track.id)).toEqual({ ok: false, denial: 'file-inaccessible' });
    } finally {
      fs.chmodSync(dir, 0o755);
    }
  });
});

describe('createMediaAccess: unexpected failures are not swallowed as denials', () => {
  it('rethrows an error that is not a FileSystemError (a bug must stay visible)', async () => {
    const root = kit.addRoot('music');
    const track = kit.addTrack('music/song.mp3');
    const access = createMediaAccess({
      trackRepository: kit.trackRepository,
      libraryRootRepository: kit.libraryRootRepository,
      fileSystem: {
        realPath: () => Promise.reject(new TypeError('boom')),
        statFile: kit.fileSystem.statFile,
      },
    });
    await expect(access.resolveTrack(track.id)).rejects.toThrow('boom');
    expect(root.id).toBeTruthy();
  });
});

describe('contentTypeForFile', () => {
  it.each([
    ['a.mp3', 'audio/mpeg'],
    ['a.FLAC', 'audio/flac'],
    ['a.wav', 'audio/wav'],
    ['a.ogg', 'audio/ogg'],
    ['a.oga', 'audio/ogg'],
    ['a.opus', 'audio/opus'],
    ['a.m4a', 'audio/mp4'],
    ['a.aac', 'audio/aac'],
    ['/some.dir.mp3/readme', undefined],
    ['C:\\music\\song.MP3', 'audio/mpeg'],
    ['song.txt', undefined],
  ])('%s -> %s', (name, expected) => {
    expect(contentTypeForFile(name)).toBe(expected);
  });
});
