/**
 * Reads an image's TYPE and PIXEL SIZE from its first bytes, without decoding it (Phase 11). The wallpaper picker
 * uses it to judge a chosen file by its CONTENT (a file named `.png` that is not a PNG is refused) and to refuse a
 * picture with absurd dimensions BEFORE anything tries to decode it (a small file can describe a huge bitmap).
 * Supports exactly the formats the wallpaper accepts: PNG, JPEG, WebP. Pure; never throws.
 */

export type ImageType = 'png' | 'jpeg' | 'webp';
export interface ImageHeader {
  readonly type: ImageType;
  readonly width: number;
  readonly height: number;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const ascii = (bytes: Uint8Array, offset: number, text: string): boolean => {
  for (let i = 0; i < text.length; i += 1) if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  return true;
};
const u16be = (b: Uint8Array, o: number): number => ((b[o] as number) << 8) | (b[o + 1] as number);
const u32be = (b: Uint8Array, o: number): number => (((b[o] as number) * 2 ** 24) + ((b[o + 1] as number) << 16) + ((b[o + 2] as number) << 8) + (b[o + 3] as number));
const u16le = (b: Uint8Array, o: number): number => (b[o] as number) | ((b[o + 1] as number) << 8);
const u24le = (b: Uint8Array, o: number): number => (b[o] as number) | ((b[o + 1] as number) << 8) | ((b[o + 2] as number) << 16);

/** The kind of image the bytes ARE (by signature), or `undefined` when it is none of the supported ones. */
export function detectImageType(bytes: Uint8Array): ImageType | undefined {
  if (bytes.length >= 8 && PNG_MAGIC.every((value, index) => bytes[index] === value)) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 12 && ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP')) return 'webp';
  return undefined;
}

/** Type and size, or `undefined` when the file is not a supported image or its header is damaged/truncated. */
export function readImageHeader(bytes: Uint8Array): ImageHeader | undefined {
  const type = detectImageType(bytes);
  if (type === undefined) return undefined;
  const size = type === 'png' ? pngSize(bytes) : type === 'jpeg' ? jpegSize(bytes) : webpSize(bytes);
  if (size === undefined || size.width < 1 || size.height < 1) return undefined;
  return { type, ...size };
}

function pngSize(b: Uint8Array): { width: number; height: number } | undefined {
  // 8-byte signature, then the IHDR chunk: length(4) "IHDR"(4) width(4) height(4)
  if (b.length < 24 || !ascii(b, 12, 'IHDR')) return undefined;
  return { width: u32be(b, 16), height: u32be(b, 20) };
}

function jpegSize(b: Uint8Array): { width: number; height: number } | undefined {
  let offset = 2;
  while (offset + 3 < b.length) {
    if (b[offset] !== 0xff) return undefined;
    let marker = b[offset + 1] as number;
    while (marker === 0xff && offset + 2 < b.length) {
      offset += 1; // fill bytes
      marker = b[offset + 1] as number;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2; // markers without a length
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return undefined; // end of image / start of scan before any frame header
    const length = u16be(b, offset + 2);
    if (length < 2) return undefined;
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (offset + 9 > b.length) return undefined;
      return { height: u16be(b, offset + 5), width: u16be(b, offset + 7) };
    }
    offset += 2 + length;
  }
  return undefined;
}

function webpSize(b: Uint8Array): { width: number; height: number } | undefined {
  if (b.length < 30) return undefined;
  if (ascii(b, 12, 'VP8 ')) {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return undefined;
    return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  if (ascii(b, 12, 'VP8L')) {
    if (b[20] !== 0x2f) return undefined;
    const bits = (b[21] as number) | ((b[22] as number) << 8) | ((b[23] as number) << 16) | ((b[24] as number) * 2 ** 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (ascii(b, 12, 'VP8X')) return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  return undefined;
}
