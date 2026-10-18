import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The media layer is Electron-free by design so its security rules can be
 * tested without an app; only `nova-media-protocol.ts` (one level up) touches
 * Electron's `protocol`. And the one thing allowed to hand the renderer a
 * media address is built from an opaque id, never a path.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const files = fs.readdirSync(here).filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts') && n !== 'media-test-kit.ts');

describe('media layer boundary', () => {
  it('found the media sources (sanity check on the test itself)', () => {
    expect(files).toEqual(expect.arrayContaining(['media-access.ts', 'media-url.ts', 'serve-media-file.ts', 'handle-media-request.ts', 'byte-range.ts']));
  });

  it.each(files)('%s does not import electron or react', (file) => {
    const source = fs.readFileSync(path.join(here, file), 'utf8');
    expect(source).not.toMatch(/from\s+['"](electron|react)/);
  });

  it('the track media URL builder takes only a TrackId (and a numeric cache key), never a path', () => {
    const source = fs.readFileSync(path.join(here, 'media-url.ts'), 'utf8');
    expect(source).toMatch(/export function buildTrackMediaUrl\(trackId: TrackId, version = 0\): string/);
  });

  it('media authorization is evaluated per request: media-access.ts keeps no cache or memo of grants', () => {
    const source = fs.readFileSync(path.join(here, 'media-access.ts'), 'utf8');
    expect(source).not.toMatch(/new Map\(|new Set\(|WeakMap|cache\s*=|memo/i);
  });

  it('the protocol serves only through the authorization step (no direct path serving of a track URL)', () => {
    const source = fs.readFileSync(path.join(here, 'handle-media-request.ts'), 'utf8');
    // the library branch must call mediaAccess.resolveTrack before serveMediaFile
    const trackBranch = source.slice(source.indexOf("parsed.kind === 'track'"), source.indexOf('// `local/<path>`'));
    expect(trackBranch.indexOf('resolveTrack')).toBeGreaterThan(-1);
    expect(trackBranch.indexOf('resolveTrack')).toBeLessThan(trackBranch.indexOf('serveMediaFile'));
  });
});
