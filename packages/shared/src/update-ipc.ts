/** v0.15.2: app updates from GitHub Releases. The window only ever sees this small status; main does the checking and downloading. */
export interface UpdateStatusDto {
  /**
   * `unsupported`: a development run or a portable copy, where updating itself makes no sense.
   * `none`: you already have the newest version. `ready`: downloaded, installs when you restart.
   * `installing`: the app is about to close and restart into the new version.
   */
  readonly state: 'unsupported' | 'idle' | 'checking' | 'none' | 'available' | 'downloading' | 'ready' | 'installing' | 'error';
  readonly currentVersion: string;
  /** The newer version, once one is found. */
  readonly version?: string;
  /**
   * Bytes: before the download this is the size of the whole installer (an upper bound - Nova Player downloads only the changed
   * parts when it can); once the download runs it is the real amount that will be fetched for this update.
   */
  readonly totalBytes?: number;
  /** `full`: the whole installer, an upper bound. `update`: just this update's real download. */
  readonly sizeKind?: 'full' | 'update';
  readonly downloadedBytes?: number;
  readonly bytesPerSecond?: number;
  /** 0..100 while downloading. */
  readonly percent?: number;
  /** A short, human sentence for `error`. */
  readonly message?: string;
}
