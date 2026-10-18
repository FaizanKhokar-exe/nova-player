import { createTrack, createTrackId, searchTracks, type Track } from '@nova/domain';
import type { ScanJobProgress, ScanJobResult, ScanState, WatcherStatusView } from '@nova/infrastructure';
import { describe, expect, it } from 'vitest';
import {
  toRootDto,
  toScanProgressDto,
  toScanResultDto,
  toScanStateDto,
  toSearchResultDto,
  toTrackDto,
  toWatcherStatusDto,
} from './dto-mappers.js';

const track = (raw: Parameters<typeof createTrack>[0]['raw'], sourcePath = '/Secret/Music/song.mp3'): Track =>
  createTrack({ id: createTrackId(), sourcePath, raw });

/** Walks a value and reports anything that is not plain JSON-able data. */
function nonPlainFindings(value: unknown, at = '$'): string[] {
  if (value === undefined) return [`${at}: undefined value`];
  if (value === null) return [`${at}: null value`];
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return [];
  if (type === 'number') return Number.isFinite(value as number) ? [] : [`${at}: non-finite number`];
  if (Array.isArray(value)) return value.flatMap((v, i) => nonPlainFindings(v, `${at}[${i}]`));
  if (type === 'object') {
    const proto = Object.getPrototypeOf(value);
    const out = proto === Object.prototype ? [] : [`${at}: class instance`];
    return out.concat(Object.entries(value as object).flatMap(([k, v]) => nonPlainFindings(v, `${at}.${k}`)));
  }
  return [`${at}: ${type}`];
}
function expectPlain(dto: unknown): void {
  expect(nonPlainFindings(dto)).toEqual([]);
  expect(structuredClone(dto)).toEqual(dto);
  expect(JSON.parse(JSON.stringify(dto))).toEqual(dto);
}

describe('toTrackDto', () => {
  const full = track({
    title: 'Song', artist: 'Artist', album: 'Album', albumArtist: 'AA', genre: 'Rock',
    trackNumber: 3, discNumber: 2, year: 1999, durationSeconds: 215.5, hasEmbeddedArtwork: true,
  });

  it('carries exactly the renderer-facing fields', () => {
    expect(toTrackDto(full)).toEqual({
      id: full.id, title: 'Song', artist: 'Artist', album: 'Album', albumArtist: 'AA', genre: 'Rock',
      trackNumber: 3, discNumber: 2, year: 1999, durationSeconds: 215.5, artwork: 'embedded',
    });
  });

  it('never exposes the file path, field provenance, or an external artwork path', () => {
    const external = track({ title: 'T', artist: 'A', externalArtworkPath: '/Secret/Music/cover.jpg' });
    const dto = toTrackDto(external);
    expect(dto.artwork).toBe('external');
    const text = JSON.stringify([toTrackDto(full), dto]);
    expect(text).not.toContain('Secret');
    expect(text).not.toContain('sourcePath');
    expect(text).not.toContain('titleSource');
    expect(Object.keys(toTrackDto(full)).sort()).toEqual(
      ['album', 'albumArtist', 'artist', 'artwork', 'discNumber', 'durationSeconds', 'genre', 'id', 'title', 'trackNumber', 'year'],
    );
  });

  it('absent optional fields are absent keys, not undefined or null', () => {
    const minimal = toTrackDto(track({ title: 'T', artist: 'A' }));
    expect(Object.keys(minimal).sort()).toEqual(['artist', 'artwork', 'id', 'title']);
    expect(minimal.artwork).toBe('none');
    expectPlain(minimal);
  });

  it('keeps a zero duration and Unicode', () => {
    const dto = toTrackDto(track({ title: '夜に駆ける 🎵', artist: 'YOASOBI', durationSeconds: 0 }));
    expect(dto).toMatchObject({ title: '夜に駆ける 🎵', durationSeconds: 0 });
  });

  it('is plain, serializable data', () => expectPlain(toTrackDto(full)));
});

describe('toSearchResultDto', () => {
  it('maps the domain match descriptions without leaking the track', () => {
    const tracks = [track({ title: 'Hello World', artist: 'Band' }), track({ title: 'Other', artist: 'Hello Band' })];
    const results = searchTracks(tracks, 'hello').map(toSearchResultDto);
    expect(results[0]).toMatchObject({ track: { title: 'Hello World' }, match: { kind: 'field', field: 'title', quality: 'prefix' } });
    expect(results.every((r) => !('sourcePath' in r.track))).toBe(true);
    results.forEach(expectPlain);
  });

  it('maps a multi-word match', () => {
    const result = searchTracks([track({ title: 'After Hours', artist: 'The Weeknd', album: 'After Hours' })], 'weeknd hours')[0];
    expect(toSearchResultDto(result!).match).toEqual({ kind: 'words' });
  });
});

describe('scan and watcher DTOs', () => {
  const counts = { discovered: 5, skipped: 1, added: 2, updated: 1, removed: 0, failed: 1, possibleDuplicates: 1 };
  const progress: ScanJobProgress = {
    scanId: 's', rootId: 'r', rootPath: '/m', rootIndex: 0, rootCount: 2,
    progress: { ...counts, phase: 'reading', processed: 4, total: 5, currentPath: '/m/a.mp3' },
  };

  it('toScanProgressDto flattens counts and drops absent values', () => {
    expect(toScanProgressDto(progress)).toEqual({
      ...counts, scanId: 's', rootId: 'r', rootIndex: 0, rootCount: 2, phase: 'reading', processed: 4, total: 5, currentPath: '/m/a.mp3',
    });
    const discovering = toScanProgressDto({ ...progress, progress: { ...progress.progress, phase: 'discovering', total: undefined, currentPath: undefined } });
    expect('total' in discovering).toBe(false);
    expect('currentPath' in discovering).toBe(false);
    expectPlain(discovering);
    expectPlain(toScanProgressDto(progress));
  });

  const result: ScanJobResult = {
    scanId: 's', status: 'completed', startedAtMs: 1, finishedAtMs: 2,
    roots: [
      { rootId: 'r', rootPath: '/m', status: 'completed', counts, failures: [{ path: '/m/b.mp3', kind: 'unreadable-media', message: 'bad' }], failureCount: 1, removalWithheld: 'root-appears-empty', error: undefined },
      { rootId: 'q', rootPath: '/n', status: 'failed', counts, failures: [], failureCount: 0, removalWithheld: undefined, error: { code: 'root-unavailable', message: 'gone' } },
    ],
  };

  it('toScanResultDto keeps per-root outcomes and only present optional fields', () => {
    const dto = toScanResultDto(result);
    expect(dto.roots[0]).toMatchObject({ removalWithheld: 'root-appears-empty', failureCount: 1, failures: [{ kind: 'unreadable-media' }] });
    expect('error' in dto.roots[0]!).toBe(false);
    expect(dto.roots[1]).toMatchObject({ error: { code: 'root-unavailable' } });
    expect('removalWithheld' in dto.roots[1]!).toBe(false);
    expectPlain(dto);
  });

  it('toScanStateDto handles idle, running and finished states', () => {
    expect(toScanStateDto({ active: undefined, last: undefined })).toEqual({});
    const running: ScanState = { active: { scanId: 's', startedAtMs: 1, progress: undefined }, last: result };
    const dto = toScanStateDto(running);
    expect(dto.active).toEqual({ scanId: 's', startedAtMs: 1 });
    expect(dto.last?.scanId).toBe('s');
    expectPlain(dto);
    expectPlain(toScanStateDto({ active: { scanId: 's', startedAtMs: 1, progress }, last: undefined }));
  });

  it('toWatcherStatusDto', () => {
    const status: WatcherStatusView = {
      running: true,
      roots: [{ rootId: 'r', path: '/m', state: 'watching' }, { rootId: 'q', path: '/n', state: 'unavailable' }],
      lastReconcile: { atMs: 5, rootId: undefined, counts, status: 'completed' },
      lastError: { atMs: 6, rootId: 'q', message: 'ENOENT' },
    };
    const dto = toWatcherStatusDto(status);
    expect(dto.lastReconcile && 'rootId' in dto.lastReconcile).toBe(false);
    expect(dto.lastError).toEqual({ atMs: 6, rootId: 'q', message: 'ENOENT' });
    expectPlain(dto);
    expect(toWatcherStatusDto({ running: false, roots: [], lastReconcile: undefined, lastError: undefined })).toEqual({ running: false, roots: [] });
  });

  it('toRootDto copies exactly the root fields', () => {
    expect(toRootDto({ id: 'i', path: '/m', addedAtMs: 3, available: true, trackCount: 9, watched: false })).toEqual({
      id: 'i', path: '/m', addedAtMs: 3, available: true, trackCount: 9, watched: false,
    });
  });

  it('does not spread: an extra internal field on the source never crosses', () => {
    const polluted = { ...progress, secret: 'x', progress: { ...progress.progress, secret: 'y' } } as unknown as ScanJobProgress;
    expect(JSON.stringify(toScanProgressDto(polluted))).not.toMatch(/secret/);
  });
});
