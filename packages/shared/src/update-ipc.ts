/** v0.15.2: app updates from GitHub Releases. The window only ever sees this small status; main does the checking and downloading. */
export interface UpdateStatusDto {
  /**
   * `unsupported`: a development run or a portable copy, where updating itself makes no sense.
   * `none`: you already have the newest version. `ready`: downloaded, installs when you restart.
   */
  readonly state: 'unsupported' | 'idle' | 'checking' | 'none' | 'available' | 'downloading' | 'ready' | 'error';
  readonly currentVersion: string;
  /** The newer version, once one is found. */
  readonly version?: string;
  /** 0..100 while downloading. */
  readonly percent?: number;
  /** A short, human sentence for `error`. */
  readonly message?: string;
}
