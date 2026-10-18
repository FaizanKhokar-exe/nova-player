import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openAuthorizedFile } from './verified-open.js';
import { serveMediaFile } from './serve-media-file.js';

const posix = process.platform !== 'win32';
let dir: string;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nova-verified-open-')));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe.skipIf(!posix)('openAuthorizedFile', () => {
  it('refuses a link at the last component by itself (O_NOFOLLOW), without needing the path re-check', async () => {
    const target = path.join(dir, 'real.mp3');
    fs.writeFileSync(target, 'AUDIO');
    const link = path.join(dir, 'link.mp3');
    fs.symlinkSync(target, link);
    expect(await openAuthorizedFile(link, { verifyStable: false })).toEqual({ ok: false, refusal: 'changed' });
    const response = await serveMediaFile(new Request('nova-media://track/x'), { filePath: link, contentType: 'audio/mpeg' });
    expect(response.status).toBe(403);
  });

  it('a directory in the path swapped for a link and then swapped BACK is caught by comparing the open file with the path', async () => {
    const album = path.join(dir, 'album');
    const parked = path.join(dir, 'album-parked');
    const outside = path.join(dir, 'outside');
    fs.mkdirSync(album);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(album, 'song.mp3'), 'REAL');
    fs.writeFileSync(path.join(outside, 'song.mp3'), 'SECRET');
    const file = path.join(album, 'song.mp3');

    // The directory is a link while the file is opened (O_NOFOLLOW only looks at the LAST component), and is
    // the real directory again by the time the path is checked: only the open file's identity gives it away.
    fs.renameSync(album, parked);
    fs.symlinkSync(outside, album);
    const originalOpen = fs.promises.open;
    (fs.promises as { open: typeof fs.promises.open }).open = (async (...args: Parameters<typeof fs.promises.open>) => {
      const handle = await originalOpen(...args);
      fs.rmSync(album);
      fs.renameSync(parked, album);
      return handle;
    }) as typeof fs.promises.open;
    try {
      expect(await openAuthorizedFile(file, { verifyStable: true })).toEqual({ ok: false, refusal: 'changed' });
    } finally {
      (fs.promises as { open: typeof fs.promises.open }).open = originalOpen;
    }
  });

  it('an unchanged regular file is opened and reports its size', async () => {
    const file = path.join(dir, 'a.mp3');
    fs.writeFileSync(file, '12345');
    const outcome = await openAuthorizedFile(file, { verifyStable: true });
    expect(outcome.ok && outcome.size).toBe(5);
    if (outcome.ok) await outcome.handle.close();
  });
});
