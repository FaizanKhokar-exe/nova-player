import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMediaKit, mp3Fixture, type MediaKit } from './media-test-kit.js';
import { readFileBounded } from './fs-readers.js';
import { readEmbeddedPicture } from '../metadata/music-metadata-reader.js';
import { MAX_ARTWORK_BYTES, MAX_LYRICS_BYTES, createTrackSidecars, TrackSidecarError, type TrackSidecarsDependencies } from './track-sidecars.js';

let kit: MediaKit;
beforeEach(() => {
  kit = createMediaKit();
});
afterEach(() => kit.close());

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

function sidecars(overrides: Partial<TrackSidecarsDependencies> = {}) {
  return createTrackSidecars({
    mediaAccess: kit.access,
    libraryRootRepository: kit.libraryRootRepository,
    fileSystem: kit.fileSystem,
    readFile: readFileBounded,
    readEmbeddedArtwork: readEmbeddedPicture,
    ...overrides,
  });
}
const write = (relative: string, text: string | Buffer): string => {
  const target = path.join(kit.sandbox, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
  return target;
};
const LRC = '[ti:Song]\n[offset:+500]\n[00:01.00]one\n[00:02.50]two\nnot a lyric line\n[00:04.00]three\n';

describe('lyrics lookup: the sidecar of the track', () => {
  it('finds <name>.lrc next to the audio and parses it with the domain parser (offset applied, ms)', async () => {
    kit.addRoot('music');
    const track = kit.addTrack('music/song.mp3');
    write('music/song.lrc', LRC);
    const result = await sidecars().getLyrics(track.id);
    expect(result).toEqual({
      status: 'found',
      lines: [
        { timeMs: 1500, text: 'one' },
        { timeMs: 3000, text: 'two' },
        { timeMs: 4500, text: 'three' },
      ],
    });
  });

  it('pairs a sidecar with its own track only, whatever the audio extension', async () => {
    kit.addRoot('music');
    const a = kit.addTrack('music/Album/a.mp3');
    const b = kit.addTrack('music/Album/b.flac', fs.readFileSync(mp3Fixture));
    write('music/Album/a.lrc', '[00:01.00]from A');
    write('music/Album/b.lrc', '[00:01.00]from B');
    expect((await sidecars().getLyrics(a.id)).lines[0]?.text).toBe('from A');
    expect((await sidecars().getLyrics(b.id)).lines[0]?.text).toBe('from B');
  });

  it('a sidecar named for a different track is not used; no sidecar is "none"', async () => {
    kit.addRoot('music');
    const track = kit.addTrack('music/song.mp3');
    write('music/other.lrc', '[00:01.00]not mine');
    write('music/song.txt', '[00:01.00]not an lrc');
    expect(await sidecars().getLyrics(track.id)).toEqual({ status: 'none', lines: [] });
  });

  it('precedence is fixed: song.lrc before song.LRC', async () => {
    kit.addRoot('music');
    const track = kit.addTrack('music/song.mp3');
    write('music/song.LRC', '[00:01.00]upper');
    write('music/song.lrc', '[00:01.00]lower');
    expect((await sidecars().getLyrics(track.id)).lines[0]?.text).toBe('lower');
    fs.rmSync(path.join(kit.sandbox, 'music/song.lrc'));
    expect((await sidecars().getLyrics(track.id)).lines[0]?.text).toBe('upper');
  });

  it('an empty file, or one with no timed lines, is "empty"; malformed content never throws', async () => {
    kit.addRoot('music');
    const track = kit.addTrack('music/song.mp3');
    write('music/song.lrc', '');
    expect(await sidecars().getLyrics(track.id)).toEqual({ status: 'empty', lines: [] });
    write('music/song.lrc', '[ar:Someone]\njust words\n[xx:yy]\n\u0000\u0001garbage[00:99');
    expect(await sidecars().getLyrics(track.id)).toEqual({ status: 'empty', lines: [] });
    write('music/song.lrc', Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x5b]));
    expect((await sidecars().getLyrics(track.id)).status).toBe('empty');
  });

  it('keeps empty timed lines and multiple timestamps (the domain rules), and a leading BOM', async () => {
    kit.addRoot('music');
    const track = kit.addTrack('music/song.mp3');
    write('music/song.lrc', '\uFEFF[00:05.00][00:01.00]chorus\n[00:03.00]\n');
    expect((await sidecars().getLyrics(track.id)).lines).toEqual([
      { timeMs: 1000, text: 'chorus' },
      { timeMs: 3000, text: '' },
      { timeMs: 5000, text: 'chorus' },
    ]);
  });

  it('a sidecar over the size limit is "unreadable" (and is never read whole)', async () => {
    kit.addRoot('music');
    const track = kit.addTrack('music/song.mp3');
    write('music/song.lrc', Buffer.alloc(MAX_LYRICS_BYTES + 1, 0x61));
    let read = false;
    const result = await sidecars({
      readFile: async (p, m) => {
        read = true;
        return readFileBounded(p, m);
      },
    }).getLyrics(track.id);
    expect(result).toEqual({ status: 'unreadable', lines: [] });
    expect(read).toBe(false);
  });

  it('a directory called song.lrc is unreadable, not a crash', async () => {
    kit.addRoot('music');
    const track = kit.addTrack('music/song.mp3');
    fs.mkdirSync(path.join(kit.sandbox, 'music/song.lrc'));
    expect((await sidecars().getLyrics(track.id)).status).toBe('unreadable');
  });

  it.skipIf(isRoot)('a sidecar the process may not read is "unreadable"', async () => {
    kit.addRoot('music');
    const track = kit.addTrack('music/song.mp3');
    const file = write('music/song.lrc', LRC);
    fs.chmodSync(file, 0o000);
    expect((await sidecars().getLyrics(track.id)).status).toBe('unreadable');
    fs.chmodSync(file, 0o644);
  });
});

describe('lyrics lookup: containment and access (the same rules as the audio)', () => {
  it('ignores a .lrc that is a symlink to a file OUTSIDE the library root', async () => {
    kit.addRoot('music');
    const track = kit.addTrack('music/song.mp3');
    const outside = write('elsewhere/secret.lrc', '[00:01.00]SECRET');
    fs.symlinkSync(outside, path.join(kit.sandbox, 'music/song.lrc'));
    expect(await sidecars().getLyrics(track.id)).toEqual({ status: 'none', lines: [] });
  });

  it('follows a symlink that stays INSIDE the root', async () => {
    kit.addRoot('music');
    const track = kit.addTrack('music/song.mp3');
    const real = write('music/lyrics/real.lrc', '[00:01.00]inside');
    fs.symlinkSync(real, path.join(kit.sandbox, 'music/song.lrc'));
    expect((await sidecars().getLyrics(track.id)).lines[0]?.text).toBe('inside');
  });

  it('a track whose own file is a link out of the root has no lyrics access at all', async () => {
    kit.addRoot('music');
    const outsideAudio = write('elsewhere/x.mp3', fs.readFileSync(mp3Fixture));
    write('elsewhere/x.lrc', '[00:01.00]outside');
    fs.symlinkSync(outsideAudio, path.join(kit.sandbox, 'music/linked.mp3'));
    const track = kit.addTrackRecordOnly(path.join(kit.sandbox, 'music/linked.mp3'));
    write('music/linked.lrc', '[00:01.00]beside the link');
    expect((await sidecars().getLyrics(track.id)).status).toBe('unavailable');
  });

  it('removing the root stops lyrics at once (no caching)', async () => {
    const root = kit.addRoot('music');
    const track = kit.addTrack('music/song.mp3');
    write('music/song.lrc', LRC);
    expect((await sidecars().getLyrics(track.id)).status).toBe('found');
    kit.libraryRootRepository.delete(root.id);
    expect(await sidecars().getLyrics(track.id)).toEqual({ status: 'unavailable', lines: [] });
  });

  it('an unavailable root, or a missing audio file, is "unavailable" - never an error', async () => {
    kit.addRoot('music');
    const track = kit.addTrack('music/song.mp3');
    write('music/song.lrc', LRC);
    fs.rmSync(path.join(kit.sandbox, 'music/song.mp3'));
    expect(await sidecars().getLyrics(track.id)).toEqual({ status: 'unavailable', lines: [] });
    fs.renameSync(path.join(kit.sandbox, 'music'), path.join(kit.sandbox, 'music-away'));
    expect((await sidecars().getLyrics(track.id)).status).toBe('unavailable');
  });

  it('refuses an invalid id and an unknown track with typed errors, and reads nothing', async () => {
    kit.addRoot('music');
    for (const id of ['', 'nope', '../../etc/passwd', '../song', 42 as unknown as string, undefined as unknown as string]) {
      await expect(sidecars().getLyrics(id)).rejects.toMatchObject({ name: 'TrackSidecarError', code: 'invalid-id' });
    }
    await expect(sidecars().getLyrics(crypto.randomUUID())).rejects.toBeInstanceOf(TrackSidecarError);
    await expect(sidecars().getLyrics(crypto.randomUUID())).rejects.toMatchObject({ code: 'track-not-found' });
  });

  it('a track record pointing outside every root has no lyrics', async () => {
    kit.addRoot('music');
    const stray = kit.addTrackRecordOnly(write('elsewhere/stray.mp3', fs.readFileSync(mp3Fixture)));
    write('elsewhere/stray.lrc', '[00:01.00]stray');
    expect((await sidecars().getLyrics(stray.id)).status).toBe('unavailable');
  });

  it('the result carries no path of any kind', async () => {
    kit.addRoot('music');
    const track = kit.addTrack('music/song.mp3');
    write('music/song.lrc', LRC);
    expect(JSON.stringify(await sidecars().getLyrics(track.id))).not.toContain(kit.sandbox);
  });
});

/** An ID3v2.3 tag with one APIC picture, prepended to a real mp3: a file music-metadata reads artwork from. */
export function mp3WithPicture(mime: string, picture: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from([0]), Buffer.from(`${mime}\0`, 'latin1'), Buffer.from([3]), Buffer.from([0]), picture]);
  const frameHeader = Buffer.alloc(10);
  frameHeader.write('APIC', 0, 'latin1');
  frameHeader.writeUInt32BE(body.length, 4);
  const frame = Buffer.concat([frameHeader, body]);
  const size = frame.length;
  const header = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f]);
  return Buffer.concat([header, frame, fs.readFileSync(mp3Fixture)]);
}
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

describe('artwork lookup', () => {
  it('reads the embedded picture of a real file, with its image type', async () => {
    kit.addRoot('music');
    const track = kit.addTrack('music/art.mp3', mp3WithPicture('image/png', PNG_1X1));
    const result = await sidecars().getArtwork(track.id);
    expect(result.status).toBe('found');
    if (result.status === 'found') {
      expect(result.mimeType).toBe('image/png');
      expect(Buffer.from(result.bytes).equals(PNG_1X1)).toBe(true);
    }
  });

  it('a file with no picture has no artwork (not an error)', async () => {
    kit.addRoot('music');
    const track = kit.addTrack('music/plain.mp3');
    expect(await sidecars().getArtwork(track.id)).toEqual({ status: 'none' });
  });

  it('refuses non-image types, empty and oversized pictures, and a reader that throws', async () => {
    kit.addRoot('music');
    const track = kit.addTrack('music/song.mp3');
    const answer = (value: { mimeType: string; data: Uint8Array } | undefined | Error) =>
      sidecars({
        readEmbeddedArtwork: async () => {
          if (value instanceof Error) throw value;
          return value;
        },
      }).getArtwork(track.id);
    expect(await answer({ mimeType: 'text/html', data: Buffer.from('<script>') })).toEqual({ status: 'none' });
    expect(await answer({ mimeType: 'image/svg+xml', data: Buffer.from('<svg/>') })).toEqual({ status: 'none' });
    expect(await answer({ mimeType: 'image/png', data: new Uint8Array(0) })).toEqual({ status: 'none' });
    expect(await answer({ mimeType: 'image/png', data: new Uint8Array(MAX_ARTWORK_BYTES + 1) })).toEqual({ status: 'none' });
    expect(await answer(new Error('corrupt tags'))).toEqual({ status: 'none' });
    expect((await answer({ mimeType: 'IMAGE/JPEG', data: Buffer.from([1]) })).status).toBe('found');
  });

  it('follows the same access rules as the audio: removed root, missing file, invalid id', async () => {
    const root = kit.addRoot('music');
    const track = kit.addTrack('music/art.mp3', mp3WithPicture('image/png', PNG_1X1));
    let reads = 0;
    const counting = sidecars({ readEmbeddedArtwork: async (p) => (reads += 1, readEmbeddedPicture(p)) });
    expect((await counting.getArtwork(track.id)).status).toBe('found');
    kit.libraryRootRepository.delete(root.id);
    expect(await counting.getArtwork(track.id)).toEqual({ status: 'unavailable' });
    expect(reads).toBe(1); // no file was touched once access was denied
    await expect(counting.getArtwork('../x')).rejects.toMatchObject({ code: 'invalid-id' });
    await expect(counting.getArtwork(crypto.randomUUID())).rejects.toMatchObject({ code: 'track-not-found' });
  });

  it('a track outside the root is not read', async () => {
    kit.addRoot('music');
    const stray = kit.addTrackRecordOnly(write('elsewhere/s.mp3', mp3WithPicture('image/png', PNG_1X1)));
    expect(await sidecars().getArtwork(stray.id)).toEqual({ status: 'unavailable' });
  });
});

describe('Phase 10: lyrics attached by hand', () => {
  function store() {
    const rows = new Map<string, string>();
    return { rows, get: (id: string) => rows.get(id), set: (id: string, text: string) => void rows.set(id, text), delete: (id: string) => rows.delete(id) };
  }
  const ATTACHED = '[00:01.00]attached one\n[00:02.00]attached two\n';

  it('attaching copies the text into the store and answers with the parsed lines', async () => {
    kit.addRoot('music');
    const track = kit.addTrack('music/song.mp3');
    const picked = write('elsewhere/my lyrics.lrc', ATTACHED);
    const attachedLyrics = store();
    const result = await sidecars({ attachedLyrics }).attachLyricsFromFile(track.id, picked);
    expect(result).toEqual({ outcome: 'attached', lines: [{ timeMs: 1000, text: 'attached one' }, { timeMs: 2000, text: 'attached two' }] });
    expect(attachedLyrics.rows.get(track.id)).toBe(ATTACHED);
  });

  it('nothing is read from the picked file afterwards: deleting it changes nothing', async () => {
    kit.addRoot('music');
    const track = kit.addTrack('music/song.mp3');
    const picked = write('elsewhere/l.lrc', ATTACHED);
    const s = sidecars({ attachedLyrics: store() });
    await s.attachLyricsFromFile(track.id, picked);
    fs.rmSync(picked);
    expect((await s.getLyrics(track.id)).lines.map((l) => l.text)).toEqual(['attached one', 'attached two']);
  });

  it('attached lyrics win over a sidecar and are marked attached; detaching brings the sidecar back', async () => {
    kit.addRoot('music');
    const track = kit.addTrack('music/song.mp3');
    write('music/song.lrc', '[00:01.00]from the sidecar');
    const s = sidecars({ attachedLyrics: store() });
    expect(await s.getLyrics(track.id)).toMatchObject({ status: 'found', lines: [{ text: 'from the sidecar' }] });
    expect(((await s.getLyrics(track.id)) as { attached?: true }).attached).toBeUndefined();

    await s.attachLyricsFromFile(track.id, write('elsewhere/a.lrc', ATTACHED));
    const attached = await s.getLyrics(track.id);
    expect(attached).toMatchObject({ status: 'found', attached: true, lines: [{ text: 'attached one' }, { text: 'attached two' }] });

    expect(await s.detachLyrics(track.id)).toBe(true);
    expect(await s.detachLyrics(track.id)).toBe(false);
    expect(await s.getLyrics(track.id)).toMatchObject({ status: 'found', lines: [{ text: 'from the sidecar' }] });
  });

  it('a file with no timed lines is "empty" and attaches nothing (an existing attachment is kept)', async () => {
    kit.addRoot('music');
    const track = kit.addTrack('music/song.mp3');
    const attachedLyrics = store();
    const s = sidecars({ attachedLyrics });
    await s.attachLyricsFromFile(track.id, write('e/good.lrc', ATTACHED));
    expect(await s.attachLyricsFromFile(track.id, write('e/words.txt', 'just some words\nno times'))).toEqual({ outcome: 'empty' });
    expect(attachedLyrics.rows.get(track.id)).toBe(ATTACHED);
  });

  it('a missing file, a directory, and a file over 1 MiB are refused with specific outcomes', async () => {
    kit.addRoot('music');
    const track = kit.addTrack('music/song.mp3');
    const s = sidecars({ attachedLyrics: store() });
    expect(await s.attachLyricsFromFile(track.id, path.join(kit.sandbox, 'nope.lrc'))).toEqual({ outcome: 'unreadable' });
    fs.mkdirSync(path.join(kit.sandbox, 'adir.lrc'));
    expect(await s.attachLyricsFromFile(track.id, path.join(kit.sandbox, 'adir.lrc'))).toEqual({ outcome: 'unreadable' });
    const big = write('e/big.lrc', `[00:01.00]${'x'.repeat(MAX_LYRICS_BYTES)}`);
    expect(await s.attachLyricsFromFile(track.id, big)).toEqual({ outcome: 'too-large' });
  });

  it('decodes UTF-8 with a BOM, UTF-16 and Windows-1252 files', async () => {
    kit.addRoot('music');
    const track = kit.addTrack('music/song.mp3');
    const s = sidecars({ attachedLyrics: store() });
    const utf8Bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('[00:01.00]café ♪')]);
    expect((await s.attachLyricsFromFile(track.id, write('e/u8.lrc', utf8Bom)))).toMatchObject({ outcome: 'attached', lines: [{ text: 'café ♪' }] });
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('[00:01.00]hola ñ', 'utf16le')]);
    expect((await s.attachLyricsFromFile(track.id, write('e/u16.lrc', utf16)))).toMatchObject({ outcome: 'attached', lines: [{ text: 'hola ñ' }] });
    const cp1252 = Buffer.from([...Buffer.from('[00:01.00]caf'), 0xe9, ...Buffer.from(' au lait, très bien, déjà vu, naïve, façade')]);
    expect((await s.attachLyricsFromFile(track.id, write('e/ansi.lrc', cp1252)))).toMatchObject({ outcome: 'attached', lines: [{ text: expect.stringMatching(/^café au lait/) }] });
  });

  it('an unknown or invalid track id is refused before any file is touched', async () => {
    const s = sidecars({ attachedLyrics: store() });
    await expect(s.attachLyricsFromFile(crypto.randomUUID(), '/x.lrc')).rejects.toMatchObject({ code: 'track-not-found' });
    await expect(s.attachLyricsFromFile('../etc/passwd', '/x.lrc')).rejects.toMatchObject({ code: 'invalid-id' });
    await expect(s.detachLyrics('nope')).rejects.toBeInstanceOf(TrackSidecarError);
  });

  it('a track whose folder is unreachable cannot be attached to, and without a store nothing is attached', async () => {
    kit.addRoot('music');
    const track = kit.addTrack('music/song.mp3');
    const picked = write('e/a.lrc', ATTACHED);
    expect(await sidecars().attachLyricsFromFile(track.id, picked)).toEqual({ outcome: 'unavailable' });
    fs.rmSync(path.join(kit.sandbox, 'music'), { recursive: true });
    expect(await sidecars({ attachedLyrics: store() }).attachLyricsFromFile(track.id, picked)).toEqual({ outcome: 'unavailable' });
  });

  it('a damaged stored text that no longer parses never hides the sidecar', async () => {
    kit.addRoot('music');
    const track = kit.addTrack('music/song.mp3');
    write('music/song.lrc', '[00:01.00]sidecar');
    const attachedLyrics = store();
    attachedLyrics.set(track.id, 'garbage with no times');
    expect((await sidecars({ attachedLyrics }).getLyrics(track.id)).lines[0]?.text).toBe('sidecar');
  });
});

describe('Phase 11: folder cover fallback', () => {
  const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 1)]);
  const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(16)]);

  it('uses a cover file of the folder when the file has no picture, with the type judged by content', async () => {
    kit.addRoot('music');
    const track = kit.addTrack('music/Album/song.mp3');
    write('music/Album/Cover.JPG', JPEG);
    const result = await sidecars().getArtwork(track.id);
    expect(result).toMatchObject({ status: 'found', mimeType: 'image/jpeg' });
  });

  it('the embedded picture wins over a folder file', async () => {
    kit.addRoot('music');
    const track = kit.addTrack('music/Album/song.mp3', mp3WithPicture('image/png', PNG_1X1));
    write('music/Album/cover.jpg', JPEG);
    const result = await sidecars().getArtwork(track.id);
    expect(result).toMatchObject({ status: 'found', mimeType: 'image/png' });
  });

  it('prefers names in the documented order (cover before folder) and extensions (jpg before webp)', async () => {
    kit.addRoot('music');
    const track = kit.addTrack('music/A/song.mp3');
    write('music/A/folder.png', PNG_1X1);
    write('music/A/cover.webp', WEBP);
    expect(await sidecars().getArtwork(track.id)).toMatchObject({ mimeType: 'image/webp' });
    write('music/A/cover.jpg', JPEG);
    expect(await sidecars().getArtwork(track.id)).toMatchObject({ mimeType: 'image/jpeg' });
  });

  it('every track of the folder gets the same cover; another folder does not', async () => {
    kit.addRoot('music');
    const a = kit.addTrack('music/A/1.mp3');
    const b = kit.addTrack('music/A/2.mp3');
    const other = kit.addTrack('music/B/1.mp3');
    write('music/A/front.png', PNG_1X1);
    const [ra, rb] = [await sidecars().getArtwork(a.id), await sidecars().getArtwork(b.id)];
    expect(ra).toMatchObject({ status: 'found', mimeType: 'image/png' });
    expect(rb).toMatchObject({ status: 'found', mimeType: 'image/png' });
    expect(await sidecars().getArtwork(other.id)).toEqual({ status: 'none' });
  });

  it('ignores other names, non-images named like covers, oversized and empty files', async () => {
    kit.addRoot('music');
    const track = kit.addTrack('music/A/song.mp3');
    write('music/A/photo.jpg', JPEG);
    write('music/A/cover.jpg', 'not an image at all');
    write('music/A/folder.png', Buffer.alloc(0));
    write('music/A/front.jpg', Buffer.concat([JPEG, Buffer.alloc(MAX_ARTWORK_BYTES)]));
    expect(await sidecars().getArtwork(track.id)).toEqual({ status: 'none' });
    write('music/A/album.png', PNG_1X1); // a later name that IS valid still wins over the bad ones
    expect(await sidecars().getArtwork(track.id)).toMatchObject({ status: 'found', mimeType: 'image/png' });
  });

  it.skipIf(process.platform === 'win32')('a cover that is a link to a file outside the library is ignored', async () => {
    kit.addRoot('music');
    const track = kit.addTrack('music/A/song.mp3');
    const outside = write('elsewhere/secret.jpg', JPEG);
    fs.symlinkSync(outside, path.join(kit.sandbox, 'music/A/cover.jpg'));
    expect(await sidecars().getArtwork(track.id)).toEqual({ status: 'none' });
  });
});
