import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeImage } from 'electron';
import { planThumbnail, type ImageResizer, type WallpaperPorts } from '@nova/infrastructure';

/**
 * The Electron-specific halves of the Phase 11 image features. `@nova/infrastructure` never imports Electron; it asks
 * for these through small ports, so its rules are tested without a window. `nativeImage` decodes PNG and JPEG.
 */

/** Cover thumbnails: crop/scale with `nativeImage`, JPEG out. `undefined` for anything that does not decode. */
export function createNativeImageResizer(): ImageResizer {
  return {
    async thumbnail(bytes, spec) {
      const image = nativeImage.createFromBuffer(Buffer.from(bytes));
      if (image.isEmpty()) return undefined;
      const { width, height } = image.getSize();
      if (width < 1 || height < 1) return undefined;
      const plan = planThumbnail(width, height, spec);
      const cropped = plan.crop.width === width && plan.crop.height === height ? image : image.crop(plan.crop);
      const sized = cropped.resize({ width: plan.target.width, height: plan.target.height, quality: 'best' });
      const jpeg = sized.toJPEG(spec.quality);
      return jpeg.length === 0 ? undefined : jpeg;
    },
  };
}

/** The wallpaper's disk and decoder ports. The stored picture is `<directory>/wallpaper.jpg`, replaced atomically. */
export function createWallpaperPorts(directory: string, onError: (error: unknown) => void): WallpaperPorts {
  const target = join(directory, 'wallpaper.jpg');
  return {
    async readFile(filePath, maxBytes) {
      try {
        const info = await stat(filePath);
        if (!info.isFile()) return undefined;
        if (info.size > maxBytes) return 'too-large';
        const handle = await open(filePath, 'r');
        try {
          const buffer = Buffer.alloc(Math.min(info.size, maxBytes) + 1);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          return bytesRead > maxBytes ? 'too-large' : buffer.subarray(0, bytesRead);
        } finally {
          await handle.close();
        }
      } catch {
        return undefined;
      }
    },
    async encodeJpeg(bytes, box, quality) {
      const image = nativeImage.createFromBuffer(Buffer.from(bytes));
      if (image.isEmpty()) return undefined;
      const { width, height } = image.getSize();
      const scale = Math.min(1, box.maxWidth / width, box.maxHeight / height);
      const out = scale < 1 ? image.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), quality: 'best' }) : image;
      const size = out.getSize();
      const jpeg = out.toJPEG(quality);
      return jpeg.length === 0 ? undefined : { bytes: jpeg, width: size.width, height: size.height };
    },
    storage: {
      async read() {
        try {
          return await readFile(target);
        } catch {
          return undefined;
        }
      },
      async write(bytes) {
        await mkdir(directory, { recursive: true });
        const temporary = `${target}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, bytes);
          await rename(temporary, target);
        } finally {
          await rm(temporary, { force: true });
        }
      },
      async remove() {
        try {
          await stat(target);
        } catch {
          return false;
        }
        await rm(target, { force: true });
        return true;
      },
    },
    onError,
  };
}

export const wallpaperDirectory = (userData: string): string => join(userData, 'wallpaper');
