import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPinnedFetchText, writeLrcAtomic, type NetFetch } from './lyrics-ports.js';

const stream = (text: string): ReadableStream<Uint8Array> => new Response(text).body as ReadableStream<Uint8Array>;
const init = { headers: { 'User-Agent': 'x' }, timeoutMs: 500, maxBytes: 100 };

describe('pinned fetch', () => {
  it('only talks https to lrclib.net, refuses redirects, reads the body', async () => {
    const seen: string[] = [];
    const netFetch: NetFetch = async (url, options) => {
      seen.push(`${url}|${options.redirect}`);
      return { status: 200, body: stream('[]') };
    };
    const fetchText = createPinnedFetchText(netFetch);
    expect(await fetchText('https://lrclib.net/api/search?q=1', init)).toEqual({ status: 200, text: '[]' });
    expect(seen).toEqual(['https://lrclib.net/api/search?q=1|error']);
    await expect(fetchText('https://evil.example/api', init)).rejects.toThrow('host not allowed');
    await expect(fetchText('http://lrclib.net/api', init)).rejects.toThrow('host not allowed');
    await expect(fetchText('https://lrclib.net.evil.example/', init)).rejects.toThrow('host not allowed');
    expect(seen).toHaveLength(1);
  });
  it('stops reading past the size cap and aborts on timeout', async () => {
    const big = createPinnedFetchText(async () => ({ status: 200, body: stream('x'.repeat(500)) }));
    await expect(big('https://lrclib.net/', init)).rejects.toThrow('too large');
    const slow = createPinnedFetchText((_u, o) => new Promise((_resolve, reject) => o.signal.addEventListener('abort', () => reject(new Error('aborted')))));
    await expect(slow('https://lrclib.net/', { ...init, timeoutMs: 20 })).rejects.toThrow('aborted');
  });
});

describe('writeLrcAtomic', () => {
  it('writes a new file, then backs the old one up on the next write', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-lrc-'));
    const target = path.join(dir, 'a.lrc');
    await writeLrcAtomic(target, new TextEncoder().encode('one'));
    expect(fs.readFileSync(target, 'utf8')).toBe('one');
    expect(fs.existsSync(`${target}.bak`)).toBe(false);
    await writeLrcAtomic(target, new TextEncoder().encode('two'));
    expect(fs.readFileSync(target, 'utf8')).toBe('two');
    expect(fs.readFileSync(`${target}.bak`, 'utf8')).toBe('one');
    expect(fs.readdirSync(dir).sort()).toEqual(['a.lrc', 'a.lrc.bak']);
    fs.rmSync(dir, { recursive: true });
  });
});
