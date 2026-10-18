import fs from 'node:fs';
import path from 'node:path';

/**
 * A tiny, valid, tagless WAV (mono, 8 kHz, 8-bit PCM, a quiet 440 Hz tone),
 * generated on demand so the repository needs no extra binary fixtures. Real
 * enough for `music-metadata` to read a duration and for Chromium's decoder
 * to play. Named `<Artist> - <Title>.wav`, the project's own filename
 * fallback gives it that artist and title.
 */
export function wavBytes(seconds: number): Buffer {
  const rate = 8000;
  const samples = Math.round(rate * seconds);
  const buffer = Buffer.alloc(44 + samples, 128);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + samples, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate, 28); // byte rate
  buffer.writeUInt16LE(1, 32); // block align
  buffer.writeUInt16LE(8, 34); // bits
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples, 40);
  for (let i = 0; i < samples; i += 1) buffer[44 + i] = 128 + Math.round(40 * Math.sin((2 * Math.PI * 440 * i) / rate));
  return buffer;
}

export function writeWav(folder: string, name: string, seconds: number): string {
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `${name}.wav`);
  fs.writeFileSync(file, wavBytes(seconds));
  return file;
}

export interface WavTags {
  readonly title: string;
  readonly artist: string;
  readonly album?: string;
  readonly genre?: string;
  readonly year?: number;
  readonly track?: number;
}

function infoChunk(id: string, value: string): Buffer {
  const text = Buffer.from(`${value}\0`, 'latin1');
  const padded = text.length % 2 === 0 ? text : Buffer.concat([text, Buffer.from([0])]);
  const header = Buffer.alloc(8);
  header.write(id, 0, 'latin1');
  header.writeUInt32LE(text.length, 4);
  return Buffer.concat([header, padded]);
}

/**
 * A valid WAV like `wavBytes`, plus a RIFF `LIST`/`INFO` chunk carrying real tags (title, artist,
 * album, genre, year, track number) that `music-metadata` reads - so the Phase 5 specs get real
 * albums, artists and genres from the real scanning pipeline, with no binary fixtures in the repo.
 */
export function taggedWavBytes(seconds: number, tags: WavTags): Buffer {
  const wav = wavBytes(seconds);
  const chunks = [
    infoChunk('INAM', tags.title),
    infoChunk('IART', tags.artist),
    ...(tags.album !== undefined ? [infoChunk('IPRD', tags.album)] : []),
    ...(tags.genre !== undefined ? [infoChunk('IGNR', tags.genre)] : []),
    ...(tags.year !== undefined ? [infoChunk('ICRD', String(tags.year))] : []),
    ...(tags.track !== undefined ? [infoChunk('ITRK', String(tags.track))] : []),
  ];
  const info = Buffer.concat([Buffer.from('INFO', 'latin1'), ...chunks]);
  const list = Buffer.alloc(8);
  list.write('LIST', 0, 'latin1');
  list.writeUInt32LE(info.length, 4);
  const out = Buffer.concat([wav, list, info]);
  out.writeUInt32LE(out.length - 8, 4); // RIFF size covers everything after the first 8 bytes
  return out;
}

/** Writes `<file>.wav` with the given tags; the file name does not matter to the tags. */
export function writeTaggedWav(folder: string, file: string, seconds: number, tags: WavTags): string {
  fs.mkdirSync(folder, { recursive: true });
  const target = path.join(folder, `${file}.wav`);
  fs.writeFileSync(target, taggedWavBytes(seconds, tags));
  return target;
}


/** A 1x1 PNG: a real, decodable image for the embedded-artwork specs (no binary file in the repo). */
export const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

function id3Frame(id: string, body: Buffer): Buffer {
  const header = Buffer.alloc(10);
  header.write(id, 0, 'latin1');
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}
const id3Text = (id: string, value: string): Buffer => id3Frame(id, Buffer.concat([Buffer.from([0]), Buffer.from(value, 'latin1')]));

/**
 * A valid WAV carrying an ID3v2.3 tag (title, artist, album and an embedded PNG cover) in an `id3 `
 * chunk, which `music-metadata` reads - so the Phase 6 specs get real embedded artwork from the real
 * scanner. The cover is a PNG; the audio itself plays like any other fixture.
 */
export function artworkWavBytes(seconds: number, tags: { title: string; artist: string; album?: string; png?: Buffer }): Buffer {
  const picture = id3Frame('APIC', Buffer.concat([Buffer.from([0]), Buffer.from('image/png\0', 'latin1'), Buffer.from([3]), Buffer.from([0]), tags.png ?? PNG_1X1]));
  const frames = Buffer.concat([id3Text('TIT2', tags.title), id3Text('TPE1', tags.artist), ...(tags.album !== undefined ? [id3Text('TALB', tags.album)] : []), picture]);
  const size = frames.length;
  const header = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f]);
  const tag = Buffer.concat([header, frames]);
  const chunk = Buffer.alloc(8);
  chunk.write('id3 ', 0, 'latin1');
  chunk.writeUInt32LE(tag.length, 4);
  const out = Buffer.concat([wavBytes(seconds), chunk, tag, tag.length % 2 === 0 ? Buffer.alloc(0) : Buffer.from([0])]);
  out.writeUInt32LE(out.length - 8, 4);
  return out;
}

export function writeArtworkWav(folder: string, file: string, seconds: number, tags: { title: string; artist: string; album?: string }): string {
  fs.mkdirSync(folder, { recursive: true });
  const target = path.join(folder, `${file}.wav`);
  fs.writeFileSync(target, artworkWavBytes(seconds, tags));
  return target;
}
