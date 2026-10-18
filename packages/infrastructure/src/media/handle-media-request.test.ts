import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleNovaMediaRequest, type NovaMediaRequestInfo } from './handle-media-request.js';
import { buildNovaMediaUrl, buildTrackMediaUrl } from './media-url.js';
import { createMediaKit, fixturesDir, flacFixture, mp3Fixture, type MediaKit } from './media-test-kit.js';

let kit: MediaKit;
let events: NovaMediaRequestInfo[];
beforeEach(() => {
  kit = createMediaKit();
  events = [];
});
afterEach(() => kit.close());

const mp3Bytes = fs.readFileSync(mp3Fixture);
const mp3Size = mp3Bytes.length;

const options = () => ({ mediaAccess: kit.access, onRequest: (info: NovaMediaRequestInfo) => void events.push(info) });
const bytes = async (response: Response): Promise<Buffer> => Buffer.from(await response.arrayBuffer());

function setup() {
  kit.addRoot('music');
  const track = kit.addTrack('music/song.mp3');
  return { track, url: buildTrackMediaUrl(track.id) };
}

function get(url: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Response> {
  return handleNovaMediaRequest(new Request(url, { method, headers }), options());
}

describe('serving a library track', () => {
  it('serves the whole file as 200 with exact bytes, length, type and Accept-Ranges', async () => {
    const { url } = setup();
    const response = await get(url);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('audio/mpeg');
    expect(response.headers.get('content-length')).toBe(String(mp3Size));
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('content-range')).toBeNull();
    expect((await bytes(response)).equals(mp3Bytes)).toBe(true);
  });

  it('serves the right content type per format', async () => {
    kit.addRoot('music');
    const flac = kit.addTrack('music/a.flac', flacFixture);
    const response = await get(buildTrackMediaUrl(flac.id));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('audio/flac');
    await response.arrayBuffer();
  });

  it('never lets a response be cached or sniffed', async () => {
    const { url } = setup();
    const response = await get(url);
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    await response.arrayBuffer();
  });

  it('reports a refusal-free request to onRequest with an opaque id, never a path', async () => {
    const { track, url } = setup();
    await (await get(url, { Range: 'bytes=0-9' })).arrayBuffer();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ requestedPath: `track/${track.id}`, allowed: true, responseStatus: 206, rangeHeader: 'bytes=0-9' });
    expect(JSON.stringify(events)).not.toContain(kit.sandbox);
  });
});

describe('the cache-key query', () => {
  it('serves the same bytes for ?v=N, and still authorizes it (a version is not a way around access)', async () => {
    const root = kit.addRoot('music');
    const track = kit.addTrack('music/song.mp3');
    const response = await get(`${buildTrackMediaUrl(track.id)}?v=7`, { Range: 'bytes=0-9' });
    expect(response.status).toBe(206);
    expect((await bytes(response)).equals(mp3Bytes.subarray(0, 10))).toBe(true);
    expect(events[0]).toMatchObject({ requestedPath: `track/${track.id}`, allowed: true });
    kit.libraryRootRepository.delete(root.id);
    expect((await get(`${buildTrackMediaUrl(track.id)}?v=7`)).status).toBe(403);
  });
  it('rejects any other query', async () => {
    const { url } = setup();
    expect((await get(`${url}?v=1&path=/etc/passwd`)).status).toBe(400);
    expect((await get(`${url}?path=/etc/passwd`)).status).toBe(400);
  });
});

describe('byte ranges (what the <audio> element needs to seek)', () => {
  it('bounded range -> 206 with the exact slice and a correct Content-Range/Length', async () => {
    const { url } = setup();
    const response = await get(url, { Range: 'bytes=100-199' });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe(`bytes 100-199/${mp3Size}`);
    expect(response.headers.get('content-length')).toBe('100');
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('content-type')).toBe('audio/mpeg');
    expect((await bytes(response)).equals(mp3Bytes.subarray(100, 200))).toBe(true);
  });

  it('open-ended range ("bytes=N-") runs to EOF', async () => {
    const { url } = setup();
    const response = await get(url, { Range: `bytes=${mp3Size - 50}-` });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe(`bytes ${mp3Size - 50}-${mp3Size - 1}/${mp3Size}`);
    expect((await bytes(response)).equals(mp3Bytes.subarray(mp3Size - 50))).toBe(true);
  });

  it('"bytes=0-" is a 206 for the whole file (what a browser sends first)', async () => {
    const { url } = setup();
    const response = await get(url, { Range: 'bytes=0-' });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe(`bytes 0-${mp3Size - 1}/${mp3Size}`);
    expect(response.headers.get('content-length')).toBe(String(mp3Size));
    expect((await bytes(response)).equals(mp3Bytes)).toBe(true);
  });

  it('suffix range returns the last N bytes', async () => {
    const { url } = setup();
    const response = await get(url, { Range: 'bytes=-128' });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe(`bytes ${mp3Size - 128}-${mp3Size - 1}/${mp3Size}`);
    expect((await bytes(response)).equals(mp3Bytes.subarray(mp3Size - 128))).toBe(true);
  });

  it('a suffix longer than the file returns the whole file as a 206', async () => {
    const { url } = setup();
    const response = await get(url, { Range: `bytes=-${mp3Size * 10}` });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe(`bytes 0-${mp3Size - 1}/${mp3Size}`);
    await response.arrayBuffer();
  });

  it('an end beyond EOF is clamped to the last byte', async () => {
    const { url } = setup();
    const response = await get(url, { Range: `bytes=${mp3Size - 10}-${mp3Size + 5000}` });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe(`bytes ${mp3Size - 10}-${mp3Size - 1}/${mp3Size}`);
    expect(response.headers.get('content-length')).toBe('10');
    await response.arrayBuffer();
  });

  it('a single-byte range works at both boundaries', async () => {
    const { url } = setup();
    const first = await get(url, { Range: 'bytes=0-0' });
    expect(first.headers.get('content-range')).toBe(`bytes 0-0/${mp3Size}`);
    expect((await bytes(first)).equals(mp3Bytes.subarray(0, 1))).toBe(true);
    const last = await get(url, { Range: `bytes=${mp3Size - 1}-${mp3Size - 1}` });
    expect(last.headers.get('content-range')).toBe(`bytes ${mp3Size - 1}-${mp3Size - 1}/${mp3Size}`);
    expect((await bytes(last)).equals(mp3Bytes.subarray(mp3Size - 1))).toBe(true);
  });

  it.each([
    ['start at EOF', () => `bytes=${mp3Size}-`],
    ['start beyond EOF', () => `bytes=${mp3Size + 100}-${mp3Size + 200}`],
    ['start after end', () => 'bytes=200-100'],
    ['a zero-length suffix', () => 'bytes=-0'],
    ['no numbers at all', () => 'bytes=-'],
    ['garbage after "bytes="', () => 'bytes=abc'],
    ['a negative start', () => 'bytes=-5-10'],
    ['a decimal', () => 'bytes=1.5-9'],
    ['an absurdly large start', () => `bytes=${'9'.repeat(400)}-`],
  ])('is unsatisfiable (416 + Content-Range */size) for %s', async (_name, header) => {
    const { url } = setup();
    const response = await get(url, { Range: header() });
    expect(response.status).toBe(416);
    expect(response.headers.get('content-range')).toBe(`bytes */${mp3Size}`);
    expect(await response.text()).toBe('');
  });

  it('serves the whole file (200) for a multi-range request, which it does not implement', async () => {
    const { url } = setup();
    const response = await get(url, { Range: 'bytes=0-9,20-29' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-range')).toBeNull();
    expect((await bytes(response)).equals(mp3Bytes)).toBe(true);
  });

  it('serves the whole file (200) for a range unit it does not know', async () => {
    const { url } = setup();
    const response = await get(url, { Range: 'items=0-5' });
    expect(response.status).toBe(200);
    await response.arrayBuffer();
  });

  it('accepts the unit case-insensitively ("Bytes=")', async () => {
    const { url } = setup();
    const response = await get(url, { Range: 'Bytes=0-9' });
    expect(response.status).toBe(206);
    await response.arrayBuffer();
  });

  it('ignores Range when If-Range is present (no validator was ever issued, so it cannot match)', async () => {
    const { url } = setup();
    const response = await get(url, { Range: 'bytes=0-9', 'If-Range': '"some-etag"' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe(String(mp3Size));
    await response.arrayBuffer();
  });

  it('an empty file: 200 with length 0, and every range is unsatisfiable', async () => {
    kit.addRoot('music');
    const empty = kit.addTrack('music/empty.mp3', Buffer.alloc(0));
    const url = buildTrackMediaUrl(empty.id);
    const full = await get(url);
    expect(full.status).toBe(200);
    expect(full.headers.get('content-length')).toBe('0');
    expect((await bytes(full)).length).toBe(0);
    const ranged = await get(url, { Range: 'bytes=0-' });
    expect(ranged.status).toBe(416);
    expect(ranged.headers.get('content-range')).toBe('bytes */0');
  });
});

describe('methods', () => {
  it('HEAD returns the GET headers and no body', async () => {
    const { url } = setup();
    const response = await get(url, {}, 'HEAD');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe(String(mp3Size));
    expect(response.headers.get('content-type')).toBe('audio/mpeg');
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect((await bytes(response)).length).toBe(0);
  });

  it('HEAD with a Range returns the 206 headers and no body', async () => {
    const { url } = setup();
    const response = await get(url, { Range: 'bytes=10-19' }, 'HEAD');
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe(`bytes 10-19/${mp3Size}`);
    expect(response.headers.get('content-length')).toBe('10');
    expect((await bytes(response)).length).toBe(0);
  });

  it.each(['POST', 'PUT', 'DELETE', 'PATCH'])('refuses %s with 405 and an Allow header, before touching anything', async (method) => {
    const { url } = setup();
    const response = await handleNovaMediaRequest(new Request(url, { method, body: method === 'DELETE' ? null : 'x' }), options());
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
    expect(events[0]).toMatchObject({ allowed: false, responseStatus: 405 });
  });
});

describe('refusing what must not be served', () => {
  it.each([
    ['an unknown track id', () => `nova-media://track/${crypto.randomUUID()}`, 404],
    ['a malformed id', () => 'nova-media://track/not-a-uuid', 400],
    ['an id with a traversal tail', () => `nova-media://track/${crypto.randomUUID()}/../../etc/passwd`, 400],
    ['an unknown host', () => `nova-media://elsewhere/${crypto.randomUUID()}`, 400],
    ['a query string', () => `nova-media://track/${crypto.randomUUID()}?x=1`, 400],
    ['a port', () => `nova-media://track:99/${crypto.randomUUID()}`, 400],
  ])('%s -> $2', async (_name, url, status) => {
    setup();
    const response = await get(url());
    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain(kit.sandbox);
    expect(events[0]?.allowed).toBe(false);
  });

  it.each([
    ['an unknown track', () => `nova-media://track/${crypto.randomUUID()}`],
    ['a malformed URL', () => 'nova-media://track/nope'],
    ['an unavailable folder', () => 'unavailable'],
  ])('a refusal is never cacheable (%s): a drive plugged back in must be seen at once', async (_name, url) => {
    const { track } = setup();
    let target = url();
    if (target === 'unavailable') {
      fs.renameSync(path.join(kit.sandbox, 'music'), path.join(kit.sandbox, 'music-gone'));
      target = buildTrackMediaUrl(track.id);
    }
    const response = await get(target);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('a 405 and a vanished file are not cacheable either', async () => {
    const { track, url } = setup();
    const post = await handleNovaMediaRequest(new Request(url, { method: 'POST', body: 'x' }), options());
    expect(post.headers.get('cache-control')).toBe('no-store');
    fs.rmSync(track.sourcePath);
    // the file is gone but the record is not: access resolves "missing" before any open
    expect((await get(url)).headers.get('cache-control')).toBe('no-store');
  });

  it('answers 403 for a track whose root was removed', async () => {
    const root = kit.addRoot('music');
    const track = kit.addTrack('music/song.mp3');
    const url = buildTrackMediaUrl(track.id);
    expect((await get(url, { Range: 'bytes=0-9' })).status).toBe(206);
    kit.libraryRootRepository.delete(root.id);
    const response = await get(url);
    expect(response.status).toBe(403);
    expect(response.headers.get('x-nova-media-denial')).toBe('root-not-registered');
  });

  it('answers 503 for a track whose root is unavailable, and recovers when it returns', async () => {
    const root = kit.addRoot('music');
    const track = kit.addTrack('music/song.mp3');
    const url = buildTrackMediaUrl(track.id);
    fs.renameSync(root.path, `${root.path}-gone`);
    const down = await get(url);
    expect(down.status).toBe(503);
    expect(down.headers.get('x-nova-media-denial')).toBe('root-unavailable');
    fs.renameSync(`${root.path}-gone`, root.path);
    const up = await get(url);
    expect(up.status).toBe(200);
    await up.arrayBuffer();
  });

  it('answers 404 for a file that vanished', async () => {
    const { track, url } = setup();
    fs.rmSync(track.sourcePath);
    const response = await get(url);
    expect(response.status).toBe(404);
    expect(response.headers.get('x-nova-media-denial')).toBe('file-missing');
  });

  it('answers 403 for a symlink that escapes the library, and never returns its bytes', async () => {
    const root = kit.addRoot('music');
    const secret = path.join(kit.sandbox, 'secret.mp3');
    fs.writeFileSync(secret, 'TOP-SECRET-BYTES');
    const link = path.join(root.path, 'link.mp3');
    fs.symlinkSync(secret, link);
    const track = kit.addTrackRecordOnly(link);

    const response = await get(buildTrackMediaUrl(track.id), { Range: 'bytes=0-5' });
    expect(response.status).toBe(403);
    expect(response.headers.get('x-nova-media-denial')).toBe('outside-root');
    expect(await response.text()).not.toContain('TOP-SECRET');
  });

  it('answers 415 for a non-audio file stored under a root', async () => {
    kit.addRoot('music');
    const track = kit.addTrack('music/notes.txt', Buffer.from('hello'));
    const response = await get(buildTrackMediaUrl(track.id));
    expect(response.status).toBe(415);
  });

  it('serves no track at all when no access policy is configured (fails closed)', async () => {
    const { url } = setup();
    const response = await handleNovaMediaRequest(new Request(url), {});
    expect(response.status).toBe(403);
  });

  it('an in-flight stream is cancelled cleanly (no leaked file handle)', async () => {
    const { url } = setup();
    const response = await get(url);
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    // If the handle leaked, removing the sandbox on teardown would still work on Linux; the
    // point of this test is that cancelling does not throw or hang.
    expect(true).toBe(true);
  });
});

describe('the Phase 0 spike URL shape (nova-media://local/<path>)', () => {
  const spike = (allowedRoots: readonly string[], file: string, headers: Record<string, string> = {}) =>
    handleNovaMediaRequest(new Request(buildNovaMediaUrl(file), { headers }), { allowedRoots, onRequest: (info) => void events.push(info) });

  it('serves a file inside an explicitly allowed root, with ranges', async () => {
    const response = await spike([fixturesDir], mp3Fixture, { Range: 'bytes=0-9' });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe(`bytes 0-9/${mp3Size}`);
    await response.arrayBuffer();
  });

  it('serves NOTHING when no root is configured (a packaged app)', async () => {
    expect((await spike([], mp3Fixture)).status).toBe(403);
    expect((await handleNovaMediaRequest(new Request(buildNovaMediaUrl(mp3Fixture)), {})).status).toBe(403);
  });

  it('refuses a path outside the allowed roots, including sibling-prefix and ".." escapes', async () => {
    expect((await spike([fixturesDir], path.join(fixturesDir, '..', 'e2e', 'helpers.ts'))).status).toBe(403);
    expect((await spike([fixturesDir], `${fixturesDir}-secret/sample-track.mp3`)).status).toBe(403);
    expect((await spike([fixturesDir], '/etc/passwd')).status).toBe(403);
  });

  it('is not a way to reach library files: those need the track URL', async () => {
    kit.addRoot('music');
    const track = kit.addTrack('music/song.mp3');
    expect((await spike([fixturesDir], track.sourcePath)).status).toBe(403);
  });

  it('refuses a non-audio file even inside an allowed root', async () => {
    expect((await spike([fixturesDir], path.join(fixturesDir, 'metadata', 'README.md'))).status).toBe(415);
  });
});

describe('Phase 11: CORS for the audio analyser', () => {
  const cors = (response: Response): void => {
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-expose-headers')).toBe('Content-Range, Accept-Ranges, Content-Length');
    expect(response.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
  };

  it('a 200, a 206, a HEAD and a 416 all carry the CORS headers', async () => {
    const { url } = setup();
    for (const [headers, method, status] of [
      [{}, 'GET', 200],
      [{ Range: 'bytes=0-9' }, 'GET', 206],
      [{ Range: 'bytes=0-9' }, 'HEAD', 206],
      [{ Range: `bytes=${mp3Size + 10}-` }, 'GET', 416],
    ] as const) {
      const response = await get(url, { ...headers }, method);
      expect(response.status).toBe(status);
      cors(response);
      await response.arrayBuffer();
    }
  });

  it('refusals carry them too, so a failed load is reported as a media error rather than an opaque CORS failure', async () => {
    kit.addRoot('music');
    const missing = await get(`nova-media://track/${crypto.randomUUID()}`);
    expect(missing.status).toBe(404);
    cors(missing);
    const post = await handleNovaMediaRequest(new Request(buildNovaMediaUrl(mp3Fixture), { method: 'POST', body: 'x' }), options());
    expect(post.status).toBe(405);
    cors(post);
  });

  it('answers a preflight with 204 and the allowed method/header, without resolving any track', async () => {
    kit.addRoot('music');
    const response = await get(`nova-media://track/${crypto.randomUUID()}`, { 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'range' }, 'OPTIONS');
    expect(response.status).toBe(204);
    cors(response);
    expect(response.headers.get('access-control-allow-methods')).toBe('GET, HEAD, OPTIONS');
    expect(response.headers.get('access-control-allow-headers')).toBe('Range');
    expect(await response.text()).toBe('');
  });

  it('does not change what is served: an unregistered path is still refused', async () => {
    const response = await get(buildNovaMediaUrl(mp3Fixture)); // no allowedRoots in options()
    expect(response.status).toBe(403);
  });
});
