import { WALLPAPER_LIMITS } from '@nova/shared';
import { readImageHeader, detectImageType } from './image-header.js';

/**
 * The custom wallpaper (Phase 11). The listener picks a picture through a dialog that lives in the main process;
 * this module judges it and keeps ONE downscaled JPEG copy. Everything outside the pure rules is an injected port
 * (file reading, image encoding with Electron's `nativeImage`, the storage folder), so the rules are unit-tested
 * without Electron or a disk.
 *
 * CONDITIONS (`WALLPAPER_LIMITS`): a real PNG or JPEG judged by its first bytes (the file name is not trusted);
 * at most 12 MiB; between 800x450 and 10 000 px per side (judged from the HEADER, before any decoding, so a tiny
 * file claiming a gigantic bitmap is refused cheaply). The stored copy fits inside 1920x1080 (never upscaled) as
 * JPEG, so the picture the page paints is small and cheap to decode no matter what was chosen. The original is not kept.
 *
 * The renderer never sees a path: it gets the stored picture back as a `data:` URL.
 */

export type WallpaperChosen =
  | { readonly outcome: 'set'; readonly wallpaper: { readonly status: 'set'; readonly dataUrl: string; readonly width: number; readonly height: number } }
  | { readonly outcome: 'cancelled' | 'unsupported-type' | 'too-large' | 'too-small' | 'too-big-dimensions' | 'unreadable' };

export type WallpaperCurrent = { readonly status: 'none' } | { readonly status: 'set'; readonly dataUrl: string; readonly width: number; readonly height: number };

export interface WallpaperPorts {
  /** Reads the chosen file. `'too-large'` when it exceeds `maxBytes` (decided from its size, before reading it all); `undefined` when unreadable. */
  readonly readFile: (filePath: string, maxBytes: number) => Promise<Uint8Array | 'too-large' | undefined>;
  /** Scales the picture to fit inside the box (no upscaling) and encodes JPEG; `undefined` when it cannot be decoded. */
  readonly encodeJpeg: (bytes: Uint8Array, box: { readonly maxWidth: number; readonly maxHeight: number }, quality: number) => Promise<{ readonly bytes: Uint8Array; readonly width: number; readonly height: number } | undefined>;
  /** The stored copy: read it (or `undefined`), replace it ATOMICALLY (a crash leaves the old one or the new one, never half), delete it. */
  readonly storage: {
    readonly read: () => Promise<Uint8Array | undefined>;
    readonly write: (bytes: Uint8Array) => Promise<void>;
    readonly remove: () => Promise<boolean>;
  };
  readonly onError?: (error: unknown) => void;
}

export interface WallpaperStore {
  get(): Promise<WallpaperCurrent>;
  /** Judges and stores the picture at `filePath` (the caller - the IPC handler - got it from the dialog). */
  setFromFile(filePath: string): Promise<WallpaperChosen>;
  clear(): Promise<boolean>;
}

const NONE: WallpaperCurrent = { status: 'none' };
const JPEG_QUALITY = 85;

const toDataUrl = (bytes: Uint8Array): string => `data:image/jpeg;base64,${Buffer.from(bytes).toString('base64')}`;

export function createWallpaperStore(ports: WallpaperPorts): WallpaperStore {
  let cached: WallpaperCurrent | undefined;
  let busy: Promise<unknown> = Promise.resolve();
  const report = (error: unknown): void => {
    try {
      ports.onError?.(error);
    } catch {
      /* nothing sensible is left to do */
    }
  };
  /** Changes are serialised, so two quick picks can never interleave their writes. */
  const exclusive = <T>(job: () => Promise<T>): Promise<T> => {
    const run = busy.then(job, job);
    busy = run.catch(() => undefined);
    return run;
  };

  async function load(): Promise<WallpaperCurrent> {
    try {
      const stored = await ports.storage.read();
      if (stored === undefined) return NONE;
      const header = readImageHeader(stored);
      if (header === undefined || header.type !== 'jpeg') return NONE; // damaged or foreign file: act as if none
      return { status: 'set', dataUrl: toDataUrl(stored), width: header.width, height: header.height };
    } catch (error) {
      report(error);
      return NONE;
    }
  }

  return {
    async get() {
      cached ??= await load();
      return cached;
    },

    setFromFile(filePath) {
      return exclusive(async (): Promise<WallpaperChosen> => {
        try {
          const read = await ports.readFile(filePath, WALLPAPER_LIMITS.maxBytes);
          if (read === 'too-large') return { outcome: 'too-large' };
          if (read === undefined) return { outcome: 'unreadable' };
          if (read.length > WALLPAPER_LIMITS.maxBytes) return { outcome: 'too-large' };
          // WebP is refused: Electron's `nativeImage` (what decodes the picture) reads only PNG and JPEG, so accepting it would promise what cannot be delivered.
          const kind = detectImageType(read);
          if (kind !== 'png' && kind !== 'jpeg') return { outcome: 'unsupported-type' };
          const header = readImageHeader(read);
          if (header === undefined) return { outcome: 'unreadable' };
          if (header.width > WALLPAPER_LIMITS.maxDimension || header.height > WALLPAPER_LIMITS.maxDimension) return { outcome: 'too-big-dimensions' };
          if (header.width < WALLPAPER_LIMITS.minWidth || header.height < WALLPAPER_LIMITS.minHeight) return { outcome: 'too-small' };
          const encoded = await ports.encodeJpeg(read, { maxWidth: WALLPAPER_LIMITS.storedMaxWidth, maxHeight: WALLPAPER_LIMITS.storedMaxHeight }, JPEG_QUALITY);
          if (encoded === undefined || encoded.bytes.length === 0) return { outcome: 'unreadable' };
          await ports.storage.write(encoded.bytes);
          cached = { status: 'set', dataUrl: toDataUrl(encoded.bytes), width: encoded.width, height: encoded.height };
          return { outcome: 'set', wallpaper: cached };
        } catch (error) {
          report(error);
          return { outcome: 'unreadable' };
        }
      });
    },

    clear() {
      return exclusive(async () => {
        try {
          const removed = await ports.storage.remove();
          cached = NONE;
          return removed;
        } catch (error) {
          report(error);
          return false;
        }
      });
    },
  };
}
