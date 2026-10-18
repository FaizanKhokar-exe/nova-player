import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseByteRange, handleNovaMediaRequest, buildNovaMediaUrl } from './nova-media-protocol.js';

const fixturesDir = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../tests/fixtures');
const mp3Fixture = path.join(fixturesDir, 'sample-track.mp3');
const mp3Size = fs.statSync(mp3Fixture).size;

async function readAll(response: Response): Promise<Uint8Array> {
  const buf = await response.arrayBuffer();
  return new Uint8Array(buf);
}

describe('parseByteRange (pure)', () => {
  const total = 1000;

  it('parses a bounded range', () => {
    expect(parseByteRange('bytes=100-200', total)).toEqual({ kind: 'single', start: 100, end: 200 });
  });

  it('parses an open-ended range ("bytes=0-")', () => {
    expect(parseByteRange('bytes=0-', total)).toEqual({ kind: 'single', start: 0, end: 999 });
  });

  it('parses a suffix range ("last N bytes")', () => {
    expect(parseByteRange('bytes=-100', total)).toEqual({ kind: 'single', start: 900, end: 999 });
  });

  it('clamps a range extending beyond EOF instead of erroring', () => {
    expect(parseByteRange('bytes=900-5000', total)).toEqual({ kind: 'single', start: 900, end: 999 });
  });

  it('reports start > end as unsatisfiable', () => {
    expect(parseByteRange('bytes=500-100', total)).toEqual({ kind: 'unsatisfiable' });
  });

  it('reports a start at or beyond the resource size as unsatisfiable', () => {
    expect(parseByteRange('bytes=1000-1999', total)).toEqual({ kind: 'unsatisfiable' });
  });

  it('reports a malformed range as unsatisfiable', () => {
    expect(parseByteRange('bytes=abc-def', total)).toEqual({ kind: 'unsatisfiable' });
  });

  it('reports "bytes=-" (no numbers at all) as unsatisfiable', () => {
    expect(parseByteRange('bytes=-', total)).toEqual({ kind: 'unsatisfiable' });
  });

  it('reports a non-"bytes=" unit as unsupported', () => {
    expect(parseByteRange('items=0-1', total)).toEqual({ kind: 'unsupported' });
  });

  it('reports a multi-range request as unsupported (server may serve full body instead)', () => {
    expect(parseByteRange('bytes=0-10,20-30', total)).toEqual({ kind: 'unsupported' });
  });

  it('treats every range as unsatisfiable against a zero-length resource', () => {
    expect(parseByteRange('bytes=0-10', 0)).toEqual({ kind: 'unsatisfiable' });
  });
});

describe('handleNovaMediaRequest (integration, real fixture files)', () => {
  const allowedRoots = [fixturesDir];

  it('serves a normal request with no Range header as 200, full content, Accept-Ranges advertised', async () => {
    const request = new Request(buildNovaMediaUrl(mp3Fixture));
    const response = await handleNovaMediaRequest(request, { allowedRoots });

    expect(response.status).toBe(200);
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('content-length')).toBe(String(mp3Size));
    expect(response.headers.get('content-type')).toBe('audio/mpeg');

    const bytes = await readAll(response);
    expect(bytes.length).toBe(mp3Size);
  });

  it('serves an open-ended range ("bytes=0-") as 206 with correct Content-Range and full length', async () => {
    const request = new Request(buildNovaMediaUrl(mp3Fixture), { headers: { Range: 'bytes=0-' } });
    const response = await handleNovaMediaRequest(request, { allowedRoots });

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe(`bytes 0-${mp3Size - 1}/${mp3Size}`);
    expect(response.headers.get('content-length')).toBe(String(mp3Size));
    expect(response.headers.get('accept-ranges')).toBe('bytes');

    const bytes = await readAll(response);
    expect(bytes.length).toBe(mp3Size);
  });

  it('serves a bounded range as 206 with the exact requested byte count', async () => {
    const request = new Request(buildNovaMediaUrl(mp3Fixture), { headers: { Range: 'bytes=10-109' } });
    const response = await handleNovaMediaRequest(request, { allowedRoots });

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe(`bytes 10-109/${mp3Size}`);
    expect(response.headers.get('content-length')).toBe('100');

    const bytes = await readAll(response);
    expect(bytes.length).toBe(100);

    // The bytes returned must actually be the right slice of the real file,
    // not just the right length.
    const expected = fs.readFileSync(mp3Fixture).subarray(10, 110);
    expect(Buffer.from(bytes).equals(expected)).toBe(true);
  });

  it('serves a range extending beyond EOF as 206, clamped to the actual end of the file', async () => {
    const rangeStart = mp3Size - 50;
    const request = new Request(buildNovaMediaUrl(mp3Fixture), {
      headers: { Range: `bytes=${rangeStart}-${mp3Size + 10_000}` },
    });
    const response = await handleNovaMediaRequest(request, { allowedRoots });

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe(`bytes ${rangeStart}-${mp3Size - 1}/${mp3Size}`);
    expect(response.headers.get('content-length')).toBe('50');

    const bytes = await readAll(response);
    expect(bytes.length).toBe(50);
  });

  it('returns 416 with a correct Content-Range for an invalid (start > end) range', async () => {
    const request = new Request(buildNovaMediaUrl(mp3Fixture), { headers: { Range: 'bytes=500-100' } });
    const response = await handleNovaMediaRequest(request, { allowedRoots });

    expect(response.status).toBe(416);
    expect(response.headers.get('content-range')).toBe(`bytes */${mp3Size}`);
  });

  it('returns 416 for a range starting at or beyond the file size', async () => {
    const request = new Request(buildNovaMediaUrl(mp3Fixture), {
      headers: { Range: `bytes=${mp3Size}-${mp3Size + 100}` },
    });
    const response = await handleNovaMediaRequest(request, { allowedRoots });

    expect(response.status).toBe(416);
    expect(response.headers.get('content-range')).toBe(`bytes */${mp3Size}`);
  });

  it('returns 403 for a path outside every allowed root (traversal / out-of-scope)', async () => {
    const outsidePath = path.resolve(fixturesDir, '..', 'not-a-real-secret-file.mp3');
    const request = new Request(buildNovaMediaUrl(outsidePath));
    const response = await handleNovaMediaRequest(request, { allowedRoots });

    expect(response.status).toBe(403);
  });

  it('returns 403 for a path attempting to traverse out via "..' + '"', async () => {
    const traversalAttempt = path.join(fixturesDir, '..', '..', 'etc', 'passwd');
    const request = new Request(buildNovaMediaUrl(traversalAttempt));
    const response = await handleNovaMediaRequest(request, { allowedRoots });

    expect(response.status).toBe(403);
  });

  it('returns 404 for a file that does not exist inside an allowed root', async () => {
    const missingPath = path.join(fixturesDir, 'this-file-does-not-exist.mp3');
    const request = new Request(buildNovaMediaUrl(missingPath));
    const response = await handleNovaMediaRequest(request, { allowedRoots });

    expect(response.status).toBe(404);
  });

  it('reports every request via the onRequest callback, including the resolved response status', async () => {
    const events: Array<{ allowed: boolean; responseStatus?: number }> = [];
    const request = new Request(buildNovaMediaUrl(mp3Fixture), { headers: { Range: 'bytes=0-9' } });

    await handleNovaMediaRequest(request, {
      allowedRoots,
      onRequest: (info) => events.push(info),
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.allowed).toBe(true);
    expect(events[0]?.responseStatus).toBe(206);
  });
});

describe('allowed-root containment (shared path policy)', () => {
  const root = path.resolve(fixturesDir);
  const respond = async (requestedPath: string): Promise<number> =>
    (await handleNovaMediaRequest(new Request(buildNovaMediaUrl(requestedPath)), { allowedRoots: [root] })).status;

  it('serves a file inside the root', async () => {
    expect(await respond(mp3Fixture)).toBe(200);
  });

  it('does not treat a sibling folder that merely shares the root\'s name as inside it', async () => {
    // e.g. root ".../fixtures" must not allow ".../fixtures-secret/x.mp3"
    expect(await respond(path.join(`${root}-secret`, 'sample-track.mp3'))).toBe(403);
  });

  it('refuses a path containing a NUL character instead of crashing', async () => {
    const response = await handleNovaMediaRequest(new Request(`nova-media://local${path.join(root, 'a')}%00.mp3`), { allowedRoots: [root] });
    expect([403, 404]).toContain(response.status);
  });

  it('accepts a root given with a trailing separator or un-normalised segments', async () => {
    const messyRoot = `${root}${path.sep}.${path.sep}`;
    const response = await handleNovaMediaRequest(new Request(buildNovaMediaUrl(mp3Fixture)), { allowedRoots: [messyRoot] });
    expect(response.status).toBe(200);
  });
});
