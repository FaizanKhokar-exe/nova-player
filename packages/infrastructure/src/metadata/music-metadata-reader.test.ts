import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTrack, createTrackId, type RawTrackMetadata } from '@nova/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileSystemError, type FileSystemErrorCode } from '../filesystem/file-system-error.js';
import { createMusicMetadataReader, type MetadataReadResult } from './music-metadata-reader.js';
import { extensionOf, isSupportedAudioFile, SUPPORTED_AUDIO_EXTENSIONS } from './supported-formats.js';

const fixtures = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../tests/fixtures/metadata');
const fixture = (name: string): string => path.join(fixtures, name);
const reader = createMusicMetadataReader();

async function readOk(filePath: string): Promise<RawTrackMetadata> {
  const result = await reader.read(filePath);
  if (result.status !== 'ok') throw new Error(`expected ok, got unreadable: ${result.reason}`);
  return result.metadata;
}

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-meta-test-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('MusicMetadataReader: tagged media', () => {
  it('maps every supported tag onto the domain RawTrackMetadata', async () => {
    const metadata = await readOk(fixture('full-tags.mp3'));
    expect(metadata).toMatchObject({
      title: 'Full Tags Song',
      artist: 'The Tagged Artist',
      album: 'Album Name',
      albumArtist: 'Various Artists',
      genre: 'Rock',
      trackNumber: 3,
      discNumber: 2,
      year: 1999,
      hasEmbeddedArtwork: true,
    });
  });

  it('reports duration in SECONDS (the domain unit)', async () => {
    const metadata = await readOk(fixture('full-tags.mp3'));
    expect(metadata.durationSeconds).toBeGreaterThan(0.4);
    expect(metadata.durationSeconds).toBeLessThan(1); // a ~0.5 s clip - not 500 (ms)
  });

  it('preserves Unicode tags exactly (CJK, accents, emoji)', async () => {
    const metadata = await readOk(fixture('unicode-tags.flac'));
    expect(metadata.title).toBe('夜に駆ける – Ünïcödé 🎵');
    expect(metadata.artist).toBe('YOASOBI');
    expect(metadata.album).toBe('THE BOOK');
    expect(metadata.genre).toBe('J-Pop');
    expect(metadata.trackNumber).toBe(1);
  });

  it('reports no embedded artwork when there is none', async () => {
    expect((await readOk(fixture('unicode-tags.flac'))).hasEmbeddedArtwork).toBe(false);
  });

  it('leaves absent tags absent rather than inventing them', async () => {
    const metadata = await readOk(fixture('unicode-tags.flac'));
    expect(metadata).not.toHaveProperty('albumArtist');
    expect(metadata).not.toHaveProperty('discNumber');
    expect(metadata).not.toHaveProperty('year');
  });

  it('reads the existing Phase 0 fixtures too (mp3 and flac)', async () => {
    const root = path.resolve(fixtures, '..');
    expect((await readOk(path.join(root, 'sample-track.mp3'))).title).toBe('Fixture Title');
    expect((await readOk(path.join(root, 'sample-track.flac'))).artist).toBe('Fixture Flac Artist');
  });
});

describe('MusicMetadataReader: valid media with missing tags', () => {
  it('returns ok with no title/artist for an untagged file (it is valid audio)', async () => {
    const metadata = await readOk(fixture('No Tags Artist - No Tags Title.mp3'));
    expect(metadata).not.toHaveProperty('title');
    expect(metadata).not.toHaveProperty('artist');
    expect(metadata.durationSeconds).toBeGreaterThan(0);
    expect(metadata.hasEmbeddedArtwork).toBe(false);
  });

  it('returns only the tags that exist for a partially tagged file', async () => {
    const metadata = await readOk(fixture('Partial Tags.mp3'));
    expect(metadata.title).toBe('Only A Title');
    expect(metadata).not.toHaveProperty('artist');
  });
});

describe('MusicMetadataReader: the domain bridge (reader -> createTrack)', () => {
  const toTrack = async (filePath: string) =>
    createTrack({ id: createTrackId(), sourcePath: filePath, raw: await readOk(filePath) });

  it('a fully tagged file becomes a tag-sourced Track with every optional field', async () => {
    const track = await toTrack(fixture('full-tags.mp3'));
    expect(track).toMatchObject({
      title: 'Full Tags Song', titleSource: 'tag',
      artist: 'The Tagged Artist', artistSource: 'tag',
      album: 'Album Name', albumArtist: 'Various Artists', genre: 'Rock',
      trackNumber: 3, discNumber: 2, year: 1999,
      artwork: { kind: 'embedded' },
    });
    expect(track.durationSeconds).toBeCloseTo(0.57, 1);
  });

  it('missing tags fall back to the FILE NAME through the domain (not the adapter)', async () => {
    const track = await toTrack(fixture('No Tags Artist - No Tags Title.mp3'));
    expect(track).toMatchObject({
      title: 'No Tags Title', titleSource: 'filename',
      artist: 'No Tags Artist', artistSource: 'filename',
      artwork: { kind: 'none' },
    });
  });

  it('a title-only file keeps the tag title and an honest unknown artist', async () => {
    const track = await toTrack(fixture('Partial Tags.mp3'));
    expect(track).toMatchObject({ title: 'Only A Title', titleSource: 'tag', artist: 'Unknown Artist', artistSource: 'unknown' });
  });

  it('Unicode survives the whole path into the Track', async () => {
    const track = await toTrack(fixture('unicode-tags.flac'));
    expect(track.title).toBe('夜に駆ける – Ünïcödé 🎵');
  });
});

describe('MusicMetadataReader: every supported extension parses', () => {
  it.each(['ogg', 'opus', 'm4a', 'aac', 'wav'])('formats-sample.%s is readable', async (ext) => {
    const result = await reader.read(fixture(`formats-sample.${ext}`));
    expect(result.status).toBe('ok');
  });

  it('reads titles from the formats that carry them', async () => {
    expect((await readOk(fixture('formats-sample.ogg'))).title).toBe('Ogg Title');
    expect((await readOk(fixture('formats-sample.m4a'))).title).toBe('M4A Title');
    expect((await readOk(fixture('formats-sample.wav'))).title).toBe('Wav Title');
  });

  it('a raw AAC stream has no duration and that is simply absent, not 0', async () => {
    expect(await readOk(fixture('formats-sample.aac'))).not.toHaveProperty('durationSeconds');
  });
});

describe('MusicMetadataReader: unsupported / corrupt media is "unreadable", never an empty track', () => {
  async function expectUnreadable(result: Promise<MetadataReadResult>): Promise<void> {
    const outcome = await result;
    expect(outcome.status).toBe('unreadable');
    if (outcome.status === 'unreadable') expect(outcome.reason.length).toBeGreaterThan(0);
  }
  const write = (name: string, content: Buffer | string): string => {
    const file = path.join(tmp, name);
    fs.writeFileSync(file, content);
    return file;
  };

  it('an empty file with an audio extension', () => expectUnreadable(reader.read(write('empty.mp3', ''))));
  it('garbage bytes named .mp3', () => expectUnreadable(reader.read(write('garbage.mp3', Buffer.alloc(5000, 0x41)))));
  it('text named .mp3', () => expectUnreadable(reader.read(write('text.mp3', 'not audio at all '.repeat(100)))));
  it('random bytes named .flac', () =>
    expectUnreadable(reader.read(write('random.flac', Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 7919) % 251))))));
  it('a file that is ONLY a tag header with the audio cut off', () => {
    const whole = fs.readFileSync(fixture('full-tags.mp3'));
    return expectUnreadable(reader.read(write('tags-only.mp3', whole.subarray(0, 300))));
  });
  it('an image pretending to be audio', () => {
    return expectUnreadable(
      reader.read(write('cover.mp3', Buffer.from('89504e470d0a1a0a0000000d49484452000000100000001008020000009091', 'hex'))),
    );
  });
});

describe('MusicMetadataReader: filesystem failures are thrown, distinct from unreadable media', () => {
  async function expectFsError(promise: Promise<unknown>, code: FileSystemErrorCode): Promise<void> {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(FileSystemError);
      expect((error as FileSystemError).code).toBe(code);
      return;
    }
    throw new Error(`expected FileSystemError(${code})`);
  }

  it('missing file -> not-found (not an "unreadable" result)', () =>
    expectFsError(reader.read(path.join(tmp, 'missing.mp3')), 'not-found'));
  it('a directory -> not-a-file', () => expectFsError(reader.read(tmp), 'not-a-file'));
  it('a relative path -> invalid-path', () => expectFsError(reader.read('song.mp3'), 'invalid-path'));
});

describe('supported formats', () => {
  it('matches extensions case-insensitively', () => {
    for (const name of ['a.mp3', 'A.MP3', 'b.Flac', 'c.OGG', 'd.opus', 'e.M4a', 'f.wav', 'g.aac', 'h.oga']) {
      expect(isSupportedAudioFile(name), name).toBe(true);
    }
  });

  it.each(['notes.txt', 'cover.jpg', 'song.mp3.bak', 'mp3', '.mp3', 'archive.zip', 'song.wma', 'noextension', ''])(
    'ignores %j',
    (name) => expect(isSupportedAudioFile(name)).toBe(false),
  );

  it('extensionOf only looks at the last dot', () => {
    expect(extensionOf('a.b.FLAC')).toBe('.flac');
    expect(extensionOf('.hidden')).toBe('');
  });

  it('is a small, deliberate list', () => {
    expect([...SUPPORTED_AUDIO_EXTENSIONS].sort()).toEqual(['.aac', '.flac', '.m4a', '.mp3', '.oga', '.ogg', '.opus', '.wav']);
  });
});

describe('music-metadata does not leak out of its adapter', () => {
  const srcRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
  const ALLOWED = new Set(['metadata-reader.ts', path.join('metadata', 'music-metadata-reader.ts')]); // Phase 0 probe + the adapter

  function sourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [full] : [];
    });
  }

  it('only the adapter (and the Phase 0 probe) import music-metadata', () => {
    const importers = sourceFiles(srcRoot)
      .filter((file) => /from\s+['"]music-metadata['"]/.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(srcRoot, file));
    expect(importers.sort()).toEqual([...ALLOWED].sort());
  });

  it('the domain package never mentions it', () => {
    const domainSrc = path.resolve(srcRoot, '../../domain/src');
    const hits = sourceFiles(domainSrc).filter((file) => fs.readFileSync(file, 'utf8').includes("'music-metadata'"));
    expect(hits).toEqual([]);
  });

  it('a read result contains only plain domain-shaped data', async () => {
    const result = await reader.read(fixture('full-tags.mp3'));
    expect(JSON.parse(JSON.stringify(result))).toEqual(result); // plain data, round-trips through JSON
    if (result.status === 'ok') {
      const allowedKeys = ['title', 'artist', 'album', 'albumArtist', 'genre', 'trackNumber', 'discNumber', 'year', 'durationSeconds', 'hasEmbeddedArtwork'];
      expect(Object.keys(result.metadata).filter((k) => !allowedKeys.includes(k))).toEqual([]);
    }
  });
});
