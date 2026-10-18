import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleNovaMediaRequest, type NovaMediaRequestInfo } from './handle-media-request.js';
import { buildTrackMediaUrl } from './media-url.js';
import { createMediaKit, mp3Fixture, type MediaKit } from './media-test-kit.js';
import { serveMediaFile } from './serve-media-file.js';
import { readFileBounded } from './fs-readers.js';
import type { MediaAccess } from './media-access.js';

/**
 * Phase 8: the gap between "this file may be heard" (`MediaAccess.resolveTrack`) and "the file is opened"
 * (`serveMediaFile`). These tests use REAL symlinks, FIFOs and files on the real file system - the OS
 * behaviour is the thing under test, not a mock of it. They run where POSIX links exist; on Windows
 * (where creating symlinks needs privileges) they are skipped and the real-platform status is "not verified".
 */
const posix = process.platform !== 'win32';
const mp3Bytes = fs.readFileSync(mp3Fixture);
const SECRET = Buffer.from('TOP-SECRET: this file is outside every library folder\n'.repeat(40));

let kit: MediaKit;
let events: NovaMediaRequestInfo[];
beforeEach(() => {
  kit = createMediaKit();
  events = [];
});
afterEach(() => kit.close());

const options = (access: Pick<MediaAccess, 'resolveTrack'> = kit.access, extra: { onError?: (error: unknown) => void } = {}) => ({
  mediaAccess: access as MediaAccess,
  onRequest: (info: NovaMediaRequestInfo) => void events.push(info),
  ...extra,
});
const bytes = async (response: Response): Promise<Buffer> => Buffer.from(await response.arrayBuffer());

/** An access object that authorizes exactly like the real one, then runs `betweenCheckAndOpen` - the race window itself, made deterministic. */
function racing(betweenCheckAndOpen: () => void): MediaAccess {
  return {
    async resolveTrack(trackId) {
      const resolution = await kit.access.resolveTrack(trackId);
      betweenCheckAndOpen();
      return resolution;
    },
  };
}

describe.skipIf(!posix)('time-of-check / time-of-use: the file changes between authorization and opening', () => {
  it('a folder inside the library swapped for a link that leaves it is NOT followed', async () => {
    kit.addRoot('music');
    const track = kit.addTrack('music/album/song.mp3');
    const outside = path.join(kit.sandbox, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'song.mp3'), SECRET);

    const swap = (): void => {
      fs.renameSync(path.join(kit.sandbox, 'music', 'album'), path.join(kit.sandbox, 'music', 'album-moved'));
      fs.symlinkSync(outside, path.join(kit.sandbox, 'music', 'album'));
    };
    const response = await handleNovaMediaRequest(new Request(buildTrackMediaUrl(track.id)), options(racing(swap)));
    const body = await bytes(response);

    expect(body.includes(Buffer.from('TOP-SECRET'))).toBe(false);
    expect(response.status).toBe(403);
    expect(response.headers.get('x-nova-media-denial')).toBe('outside-root');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(events.at(-1)).toMatchObject({ allowed: true }); // authorization passed; it was the open that refused
  });

  it('the file itself swapped for a link to a file outside the library is NOT served (a ranged request too)', async () => {
    kit.addRoot('music');
    const track = kit.addTrack('music/song.mp3');
    const outside = path.join(kit.sandbox, 'secret.mp3');
    fs.writeFileSync(outside, SECRET);

    const swap = (): void => {
      fs.rmSync(path.join(kit.sandbox, 'music', 'song.mp3'));
      fs.symlinkSync(outside, path.join(kit.sandbox, 'music', 'song.mp3'));
    };
    const response = await handleNovaMediaRequest(
      new Request(buildTrackMediaUrl(track.id), { headers: { range: 'bytes=0-99' } }),
      options(racing(swap)),
    );
    const body = await bytes(response);
    expect(body.includes(Buffer.from('TOP-SECRET'))).toBe(false);
    expect(response.status).toBe(403);
  });

  it('a link swapped in and then swapped BACK before the check could notice is still caught (the opened file is not the authorized one)', async () => {
    kit.addRoot('music');
    const track = kit.addTrack('music/song.mp3');
    const outside = path.join(kit.sandbox, 'secret.mp3');
    fs.writeFileSync(outside, SECRET);
    const original = path.join(kit.sandbox, 'music', 'song.mp3');
    const parked = path.join(kit.sandbox, 'music', 'song.parked');

    // Authorization sees the real file. By the time it is opened the path leads to the secret; once it is
    // open, the attacker restores the original name. Only comparing the OPEN FILE with the path can see this.
    let swapped = false;
    const access: MediaAccess = {
      async resolveTrack(trackId) {
        const resolution = await kit.access.resolveTrack(trackId);
        fs.renameSync(original, parked);
        fs.symlinkSync(outside, original);
        swapped = true;
        return resolution;
      },
    };
    const originalOpen = fs.promises.open;
    // Restore the original file name right after the (single) open of the swapped path completes.
    (fs.promises as { open: typeof fs.promises.open }).open = (async (...args: Parameters<typeof fs.promises.open>) => {
      const handle = await originalOpen(...args);
      if (swapped && String(args[0]) === original) {
        fs.rmSync(original);
        fs.renameSync(parked, original);
        swapped = false;
      }
      return handle;
    }) as typeof fs.promises.open;
    try {
      const response = await handleNovaMediaRequest(new Request(buildTrackMediaUrl(track.id)), options(access));
      const body = await bytes(response);
      expect(body.includes(Buffer.from('TOP-SECRET'))).toBe(false);
      expect(response.status).toBe(403);
    } finally {
      (fs.promises as { open: typeof fs.promises.open }).open = originalOpen;
    }
  });

  it('an ordinary request is unaffected: exact bytes, and the file handle is released afterwards', async () => {
    kit.addRoot('music');
    const track = kit.addTrack('music/song.mp3');
    const response = await handleNovaMediaRequest(new Request(buildTrackMediaUrl(track.id), { headers: { range: 'bytes=10-19' } }), options());
    expect(response.status).toBe(206);
    expect((await bytes(response)).equals(mp3Bytes.subarray(10, 20))).toBe(true);
  });
});

describe.skipIf(!posix)('special files', () => {
  /** Opens the write end of a FIFO so a reader blocked in open() is released (otherwise the test would leak a stuck thread). */
  function release(fifo: string): void {
    try {
      const fd = fs.openSync(fifo, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
      fs.closeSync(fd);
    } catch {
      // nothing is waiting
    }
  }

  it('a named pipe swapped in for the file does not hang the request: it is refused promptly', async () => {
    kit.addRoot('music');
    const track = kit.addTrack('music/song.mp3');
    const file = path.join(kit.sandbox, 'music', 'song.mp3');
    const access: MediaAccess = {
      async resolveTrack(trackId) {
        const resolution = await kit.access.resolveTrack(trackId);
        fs.rmSync(file);
        execFileSync('mkfifo', [file]);
        return resolution;
      },
    };
    const outcome = await Promise.race([
      handleNovaMediaRequest(new Request(buildTrackMediaUrl(track.id)), options(access)).then((response) => response.status),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 2000)),
    ]);
    release(file);
    expect(outcome).not.toBe('hung');
    expect([403, 404]).toContain(outcome);
  });

  it('serveMediaFile on a directory or a pipe answers 404 instead of opening it', async () => {
    const dir = path.join(kit.sandbox, 'a-dir.mp3');
    fs.mkdirSync(dir);
    expect((await serveMediaFile(new Request('nova-media://track/x'), { filePath: dir, contentType: 'audio/mpeg' })).status).toBe(404);

    const fifo = path.join(kit.sandbox, 'pipe.mp3');
    execFileSync('mkfifo', [fifo]);
    const outcome = await Promise.race([
      serveMediaFile(new Request('nova-media://track/x'), { filePath: fifo, contentType: 'audio/mpeg' }).then((response) => response.status),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 2000)),
    ]);
    release(fifo);
    expect(outcome).toBe(404);
  });

  it('readFileBounded (lyrics) refuses a pipe promptly instead of blocking', async () => {
    const fifo = path.join(kit.sandbox, 'x.lrc');
    execFileSync('mkfifo', [fifo]);
    const outcome = await Promise.race([
      readFileBounded(fifo, 1024).then(() => 'read', () => 'refused'),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 2000)),
    ]);
    release(fifo);
    expect(outcome).toBe('refused');
  });
});

describe('unexpected failures are contained, reported and never leak detail', () => {
  const id = (): string => {
    kit.addRoot('music');
    return buildTrackMediaUrl(kit.addTrack('music/song.mp3').id);
  };

  it('an authorization step that throws becomes a 500 refusal (not a rejected promise), is reported once, and carries no detail', async () => {
    const url = id();
    const errors: unknown[] = [];
    const broken: MediaAccess = {
      async resolveTrack() {
        throw new Error('The database connection is not open. (C:\\Users\\someone\\AppData\\nova.db)');
      },
    };
    const response = await handleNovaMediaRequest(new Request(url), options(broken, { onError: (error) => errors.push(error) }));
    expect(response.status).toBe(500);
    expect(response.headers.get('x-nova-media-denial')).toBe('internal-error');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const text = await response.text();
    expect(text).not.toContain('database');
    expect(text).not.toContain('C:\\');
    expect(errors).toHaveLength(1);
    expect(String((errors[0] as Error).message)).toContain('database connection');
    expect(events.at(-1)).toMatchObject({ allowed: false, responseStatus: 500, denial: 'internal-error' });
  });

  it('a throwing onError sink cannot turn the refusal back into a rejection', async () => {
    const url = id();
    const broken: MediaAccess = { resolveTrack: () => Promise.reject(new Error('boom')) };
    const response = await handleNovaMediaRequest(new Request(url), options(broken, { onError: () => { throw new Error('sink failed'); } }));
    expect(response.status).toBe(500);
  });
});
