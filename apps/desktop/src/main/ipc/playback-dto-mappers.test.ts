import type { PlaybackStateView } from '@nova/infrastructure';
import { describe, expect, it } from 'vitest';
import { makeTrack } from '../../../../../packages/infrastructure/src/repositories/test-tracks.js';
import { toMediaProblemDto, toPlaybackCommandResultDto, toPlaybackStateDto } from './playback-dto-mappers.js';

const SECRET_PATH = 'C:\\Users\\Someone\\Private Music\\secret song.mp3';

function view(overrides: Partial<PlaybackStateView> = {}): PlaybackStateView {
  const track = makeTrack({ sourcePath: SECRET_PATH, title: 'A Song', artist: 'An Artist' });
  return {
    revision: 3,
    current: { track, mediaUrl: `nova-media://track/${track.id}` },
    positionMs: 1234,
    repeatMode: 'all',
    shuffle: true,
    queueLength: 9,
    queueIndex: 4,
    canNext: true,
    ...overrides,
  };
}

describe('toPlaybackStateDto', () => {
  it('maps every field and gives the current track as a path-free TrackDto plus the opaque URL', () => {
    const state = view();
    const dto = toPlaybackStateDto(state);
    expect(dto).toEqual({
      revision: 3,
      current: { track: expect.objectContaining({ id: state.current!.track.id, title: 'A Song', artist: 'An Artist', artwork: 'none' }), mediaUrl: `nova-media://track/${state.current!.track.id}` },
      positionMs: 1234,
      repeatMode: 'all',
      shuffle: true,
      queueLength: 9,
      queueIndex: 4,
      canNext: true,
    });
  });

  it('never lets a file path, or anything path-like, cross the boundary', () => {
    const json = JSON.stringify(toPlaybackStateDto(view()));
    for (const leak of ['Private Music', 'secret song', 'Someone', 'sourcePath', 'C:\\', '.mp3']) expect(json).not.toContain(leak);
    expect(JSON.stringify(toPlaybackCommandResultDto({ outcome: 'started', state: view() }))).not.toContain('Private Music');
  });

  it('uses ABSENT keys, not null/undefined values, when nothing is queued', () => {
    const dto = toPlaybackStateDto(view({ current: undefined, queueIndex: undefined, queueLength: 0, canNext: false, positionMs: 0 }));
    expect('current' in dto).toBe(false);
    expect('queueIndex' in dto).toBe(false);
    expect(Object.values(dto)).not.toContain(undefined);
    expect(Object.values(dto)).not.toContain(null);
  });

  it('copies field by field: a field added to the internal view does not silently start crossing IPC', () => {
    const dto = toPlaybackStateDto({ ...view(), internalOnly: 'secret' } as PlaybackStateView);
    expect(Object.keys(dto).sort()).toEqual(['canNext', 'current', 'positionMs', 'queueIndex', 'queueLength', 'repeatMode', 'revision', 'shuffle']);
  });
});

describe('toPlaybackCommandResultDto', () => {
  it.each(['started', 'restart', 'stop', 'none'] as const)('keeps the outcome %s', (outcome) => {
    expect(toPlaybackCommandResultDto({ outcome, state: view() }).outcome).toBe(outcome);
  });
});

describe('toMediaProblemDto: the user-facing wording of a denial', () => {
  it.each([
    ['invalid-id', 'invalid-source'],
    ['track-not-found', 'not-in-library'],
    ['root-not-registered', 'not-in-library'],
    ['root-unavailable', 'folder-unavailable'],
    ['file-missing', 'file-missing'],
    ['not-a-file', 'file-missing'],
    ['unsupported-format', 'unsupported-format'],
    // Escape attempts and swapped folders are not explained to the renderer in detail.
    ['outside-root', 'file-inaccessible'],
    ['root-changed', 'file-inaccessible'],
    ['file-inaccessible', 'file-inaccessible'],
  ] as const)('%s -> %s', (denial, problem) => {
    expect(toMediaProblemDto(denial)).toBe(problem);
  });
});
