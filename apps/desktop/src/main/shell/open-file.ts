import path from 'node:path';

/**
 * "Open with Nova Player" (v0.11.3). Windows starts the app with the file's path as an argument (or hands it to the running
 * instance as a second launch); this turns that path into "play this track":
 *  1. the file must be a supported audio file that exists;
 *  2. if the library already has it, that track plays;
 *  3. otherwise its folder is added to the library (an explicit user action: they chose to open a file from there), scanned,
 *     and the track plays as soon as the scan has found it.
 * Electron-free (everything is injected), so the rules are unit-tested. The renderer never sees the path: it is only told which track to play.
 */

export interface OpenFileLibrary {
  listTracks(): readonly { readonly id: string; readonly sourcePath: string }[];
  listRoots(): Promise<readonly { readonly id: string; readonly path: string }[]>;
  addRoot(folderPath: string): Promise<{ readonly id: string; readonly path: string }>;
  startScan(request?: { readonly rootId?: string }): unknown;
  /** Whether a scan is running right now. */
  scanning(): boolean;
  /** Calls back once when the running (or next) scan finishes; returns the cancel function. */
  onceScanFinished(listener: () => void): () => void;
}

export type OpenOutcome = 'playing' | 'added-folder' | 'not-audio' | 'missing' | 'not-found' | 'failed';

export interface FileOpenerDependencies {
  readonly library: OpenFileLibrary;
  readonly isAudioFile: (fileName: string) => boolean;
  /** Real path of an existing FILE, or undefined (missing / a folder / unreadable). */
  readonly resolveFile: (filePath: string) => Promise<string | undefined>;
  /** Tell the player to play this track. Returns whether it was delivered. */
  readonly play: (trackId: string) => boolean;
  /** Bring the window forward. */
  readonly show: () => void;
  readonly caseInsensitive: boolean;
  readonly scanTimeoutMs?: number;
  readonly log: (message: string, error: unknown) => void;
}

/** The first command-line argument that names an audio file (flags and the program itself are skipped). */
export function audioPathFromArgs(args: readonly string[], isAudioFile: (fileName: string) => boolean): string | undefined {
  return args.find((arg) => typeof arg === 'string' && arg.length > 0 && !arg.startsWith('-') && !arg.startsWith('--') && isAudioFile(arg) && path.isAbsolute(arg));
}

export function createFileOpener(dependencies: FileOpenerDependencies): { open(rawPath: string): Promise<OpenOutcome> } {
  const { library, isAudioFile, resolveFile, play, show, caseInsensitive, log } = dependencies;
  const scanTimeoutMs = dependencies.scanTimeoutMs ?? 120_000;
  const norm = (value: string): string => (caseInsensitive ? path.resolve(value).toLowerCase() : path.resolve(value));
  const find = (real: string): string | undefined => {
    const wanted = norm(real);
    return library.listTracks().find((track) => norm(track.sourcePath) === wanted)?.id;
  };
  const waitForScan = (): Promise<void> =>
    new Promise((resolve) => {
      const cancel = library.onceScanFinished(() => {
        clearTimeout(timer);
        resolve();
      });
      const timer = setTimeout(() => {
        cancel();
        resolve();
      }, scanTimeoutMs);
    });
  const inside = (folder: string, file: string): boolean => {
    const rel = path.relative(norm(folder), norm(file));
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  };

  return {
    async open(rawPath) {
      try {
        if (!isAudioFile(rawPath)) return 'not-audio';
        const real = await resolveFile(rawPath);
        if (real === undefined) return 'missing';
        show();
        const known = find(real);
        if (known !== undefined) return play(known) ? 'playing' : 'failed';

        // Not in the library yet: its folder joins it (or, if the folder is already a library folder, it is rescanned), then it plays.
        const roots = await library.listRoots();
        const covering = roots.find((root) => inside(root.path, real));
        if (library.scanning()) await waitForScan();
        const again = find(real);
        if (again !== undefined) return play(again) ? 'playing' : 'failed';
        const root = covering ?? (await library.addRoot(path.dirname(real)));
        const finished = waitForScan();
        library.startScan({ rootId: root.id });
        await finished;
        const added = find(real);
        if (added === undefined) return 'not-found';
        return play(added) ? (covering === undefined ? 'added-folder' : 'playing') : 'failed';
      } catch (error) {
        log('[nova] could not open the file:', error);
        return 'failed';
      }
    },
  };
}
