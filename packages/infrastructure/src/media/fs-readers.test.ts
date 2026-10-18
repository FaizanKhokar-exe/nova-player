import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileBounded } from './fs-readers.js';

let dir: string;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nova-readers-')));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('readFileBounded', () => {
  it('reads a regular file, up to the limit', async () => {
    const file = path.join(dir, 'a.lrc');
    fs.writeFileSync(file, '[00:01.00]hello');
    expect(Buffer.from(await readFileBounded(file, 1024)).toString()).toBe('[00:01.00]hello');
    expect(Buffer.from(await readFileBounded(file, 15)).toString()).toBe('[00:01.00]hello'); // exactly the limit is allowed
  });

  it('refuses a file one byte over the limit, without returning any of it', async () => {
    const file = path.join(dir, 'big.lrc');
    fs.writeFileSync(file, 'x'.repeat(16));
    await expect(readFileBounded(file, 15)).rejects.toThrow('too large');
  });

  it('refuses a directory', async () => {
    const folder = path.join(dir, 'a-folder.lrc');
    fs.mkdirSync(folder);
    await expect(readFileBounded(folder, 1024)).rejects.toThrow();
  });

  it.skipIf(process.platform === 'win32')('refuses a link at the last component (swapped in after the path was resolved)', async () => {
    const secret = path.join(dir, 'secret.txt');
    fs.writeFileSync(secret, '[00:01.00]TOP-SECRET');
    const link = path.join(dir, 'song.lrc');
    fs.symlinkSync(secret, link);
    await expect(readFileBounded(link, 1024)).rejects.toThrow();
  });
});
