import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleNovaMediaRequest } from './handle-media-request.js';
import { createMediaKit, mp3Fixture, type MediaKit } from './media-test-kit.js';
import { buildTrackMediaUrl } from './media-url.js';
import type { MediaAccess } from './media-access.js';

/**
 * Phase 8: "are file handles closed after cancellation, errors and partial reads?" - answered by looking at the
 * process's real open file descriptors (Linux: /proc/self/fd), not by trusting the stream code. A leaked
 * descriptor per cancelled seek would exhaust the process after enough seeking in a long session.
 */
const hasProcFd = process.platform === 'linux' && fs.existsSync('/proc/self/fd');

/** How many open descriptors point at a file inside `folder`. */
function openFilesIn(folder: string): number {
  let count = 0;
  for (const entry of fs.readdirSync('/proc/self/fd')) {
    try {
      if (fs.readlinkSync(path.join('/proc/self/fd', entry)).startsWith(folder)) count += 1;
    } catch {
      // the descriptor used to read the directory itself, or one closed meanwhile
    }
  }
  return count;
}
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));

let kit: MediaKit;
beforeEach(() => {
  kit = createMediaKit();
});
afterEach(() => kit.close());

describe.skipIf(!hasProcFd)('no file descriptor outlives a media request', () => {
  const url = (): string => {
    kit.addRoot('music');
    return buildTrackMediaUrl(kit.addTrack('music/song.mp3').id);
  };
  const serve = (request: Request, access: Pick<MediaAccess, 'resolveTrack'> = kit.access) => handleNovaMediaRequest(request, { mediaAccess: access as MediaAccess });

  it('a stream cancelled after one chunk (the user seeks away) releases its file', async () => {
    const address = url();
    for (let i = 0; i < 20; i += 1) {
      const response = await serve(new Request(address));
      const reader = response.body!.getReader();
      await reader.read();
      await reader.cancel();
    }
    await settle();
    expect(openFilesIn(kit.sandbox)).toBe(0);
  });

  it('a stream that is read to the end releases its file', async () => {
    const address = url();
    for (let i = 0; i < 20; i += 1) await (await serve(new Request(address))).arrayBuffer();
    await settle();
    expect(openFilesIn(kit.sandbox)).toBe(0);
  });

  it('HEAD, an unsatisfiable range (416) and an empty file release their file straight away', async () => {
    const address = url();
    kit.addTrack('music/empty.mp3', Buffer.alloc(0));
    const emptyId = kit.trackRepository.list().find((track) => track.sourcePath.endsWith('empty.mp3'))!.id;
    for (let i = 0; i < 10; i += 1) {
      expect((await serve(new Request(address, { method: 'HEAD' }))).status).toBe(200);
      expect((await serve(new Request(address, { headers: { range: 'bytes=99999999-' } }))).status).toBe(416);
      expect((await serve(new Request(buildTrackMediaUrl(emptyId)))).status).toBe(200);
    }
    expect(openFilesIn(kit.sandbox)).toBe(0);
  });

  it('a refusal at the open (the file was swapped for a link after authorization) leaves nothing open', async () => {
    const address = url();
    const file = path.join(kit.sandbox, 'music', 'song.mp3');
    const outside = path.join(kit.sandbox, 'outside.mp3');
    fs.writeFileSync(outside, 'x'.repeat(100));
    const racing: MediaAccess = {
      async resolveTrack(id) {
        const resolution = await kit.access.resolveTrack(id);
        fs.rmSync(file);
        fs.symlinkSync(outside, file);
        return resolution;
      },
    };
    for (let i = 0; i < 5; i += 1) {
      expect((await serve(new Request(address), racing)).status).toBe(403);
      fs.rmSync(file);
      fs.copyFileSync(mp3Fixture, file); // restore the real file for the next round
    }
    expect(openFilesIn(kit.sandbox)).toBe(0);
  });
});
