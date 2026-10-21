import { describe, expect, it, vi } from 'vitest';
import { audioPathFromArgs, createFileOpener, type OpenFileLibrary } from './open-file.js';

const isAudio = (name: string) => /\.(mp3|flac|wav)$/i.test(name);

function setup(options: { tracks?: { id: string; sourcePath: string }[]; roots?: { id: string; path: string }[]; scanFindsFile?: string; resolve?: string | undefined; scanning?: boolean } = {}) {
  const tracks = options.tracks ?? [];
  const roots = options.roots ?? [];
  let listener: (() => void) | undefined;
  const library: OpenFileLibrary = {
    listTracks: () => tracks,
    listRoots: async () => roots,
    addRoot: vi.fn(async (folder: string) => { const root = { id: 'root-new', path: folder }; roots.push(root); return root; }),
    startScan: vi.fn(() => {
      queueMicrotask(() => {
        if (options.scanFindsFile !== undefined) tracks.push({ id: 'found-id', sourcePath: options.scanFindsFile });
        listener?.();
      });
    }),
    scanning: () => options.scanning === true,
    onceScanFinished: (l) => { listener = l; return () => { listener = undefined; }; },
  };
  const play = vi.fn(() => true);
  const show = vi.fn();
  const opener = createFileOpener({ library, isAudioFile: isAudio, resolveFile: async (p) => ('resolve' in options ? options.resolve : p), play, show, caseInsensitive: false, log: () => undefined, scanTimeoutMs: 500 });
  return { opener, library, play, show };
}

describe('audioPathFromArgs', () => {
  it('finds the audio file among flags and the program path', () => {
    expect(audioPathFromArgs(['/app/nova', '--flag', '/music/a.mp3'], isAudio)).toBe('/music/a.mp3');
    expect(audioPathFromArgs(['/app/nova', 'relative.mp3', '--x=1'], isAudio)).toBeUndefined();
    expect(audioPathFromArgs([], isAudio)).toBeUndefined();
  });
});

describe('file opener', () => {
  it('plays a track the library already has, without touching the library', async () => {
    const s = setup({ tracks: [{ id: 't1', sourcePath: '/music/a.mp3' }] });
    expect(await s.opener.open('/music/a.mp3')).toBe('playing');
    expect(s.play).toHaveBeenCalledWith('t1');
    expect(s.library.addRoot).not.toHaveBeenCalled();
    expect(s.show).toHaveBeenCalled();
  });
  it('adds the folder, scans, then plays a file the library did not have', async () => {
    const s = setup({ scanFindsFile: '/dl/new.mp3' });
    expect(await s.opener.open('/dl/new.mp3')).toBe('added-folder');
    expect(s.library.addRoot).toHaveBeenCalledWith('/dl');
    expect(s.play).toHaveBeenCalledWith('found-id');
  });
  it('rescans (does not add a second folder) when the file sits in an existing library folder', async () => {
    const s = setup({ roots: [{ id: 'r1', path: '/music' }], scanFindsFile: '/music/sub/x.mp3' });
    expect(await s.opener.open('/music/sub/x.mp3')).toBe('playing');
    expect(s.library.addRoot).not.toHaveBeenCalled();
    expect(s.library.startScan).toHaveBeenCalledWith({ rootId: 'r1' });
  });
  it('refuses non-audio and missing files, and reports a file the scan could not read', async () => {
    expect(await setup().opener.open('/x/readme.txt')).toBe('not-audio');
    expect(await setup({ resolve: undefined }).opener.open('/x/gone.mp3')).toBe('missing');
    expect(await setup().opener.open('/x/broken.mp3')).toBe('not-found');
  });
});
