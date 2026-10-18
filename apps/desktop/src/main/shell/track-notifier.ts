import type { PlaybackApplicationEvent } from '@nova/infrastructure';

export interface NotificationContent {
  readonly title: string;
  readonly body: string;
}

/** The slice of Electron's `Notification` the notifier uses. */
export interface NotificationPort {
  isSupported(): boolean;
  /** Shows one notification (replacing any earlier one). Throws if the OS refuses. */
  show(content: NotificationContent, onClick: () => void): void;
}

export interface NotifiedRecord {
  readonly content: NotificationContent;
  readonly outcome: 'shown' | 'failed';
}

export interface TrackNotifier {
  /** Subscribes to the playback application's events, once. Idempotent. */
  start(): void;
  /** Unsubscribes. Idempotent. */
  dispose(): void;
  /** The last few notifications handed to the OS (for tests and diagnostics; at most 20). */
  history(): readonly NotifiedRecord[];
}

const MAX_TITLE = 100;
const MAX_BODY = 200;
const UNKNOWN_TITLE = 'Unknown title';

/** Tag text is untrusted: no control characters or line breaks, bounded length. */
function clean(value: string | undefined, max: number): string {
  const text = (value ?? '').replace(/\p{Cc}+/gu, ' ').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** What a notification says about a track: its title, and "artist — album". Never a path, never an id. */
export function describeTrack(track: { readonly title?: string | undefined; readonly artist?: string | undefined; readonly album?: string | undefined }): NotificationContent {
  const title = clean(track.title, MAX_TITLE) || UNKNOWN_TITLE;
  const body = clean([clean(track.artist, MAX_BODY), clean(track.album, MAX_BODY)].filter((part) => part !== '').join(' — '), MAX_BODY);
  return { title, body };
}

/**
 * Phase 7: tells the user which track just started - useful when the window is hidden or in the
 * tray. It listens to the ONE playback event source (`PlaybackApplication.subscribe`) for
 * `track-started`, which main emits only when a command starts a different track: not for
 * a restart of the same track, a restored session, or a library change. On top of that:
 *  - the same track is never announced twice in a row (repeated events, a one-track repeat-all loop);
 *  - nothing is shown while the window has focus (the user is looking at the player);
 *  - a platform without notifications, or a notification the OS refuses, is contained and logged.
 */
export function createTrackNotifier(options: {
  readonly subscribe: (listener: (event: PlaybackApplicationEvent) => void) => () => void;
  readonly port: NotificationPort;
  /** False while the window has focus. */
  readonly shouldNotify: () => boolean;
  /** The user clicked the notification: bring the window forward. */
  readonly onClick: () => void;
  readonly log: (message: string, error: unknown) => void;
}): TrackNotifier {
  const { subscribe, port, shouldNotify, onClick, log } = options;
  let unsubscribe: (() => void) | undefined;
  let disposed = false;
  let lastNotifiedTrackId: string | undefined;
  const records: NotifiedRecord[] = [];

  function remember(record: NotifiedRecord): void {
    records.push(record);
    if (records.length > 20) records.shift();
  }

  function handle(event: PlaybackApplicationEvent): void {
    if (disposed || event.type !== 'track-started') return;
    const track = event.state.current?.track;
    if (track === undefined) return;
    if (track.id === lastNotifiedTrackId) return;
    try {
      if (!shouldNotify() || !port.isSupported()) return;
    } catch (error) {
      log('[nova] could not decide whether to show a track notification:', error);
      return;
    }
    const content = describeTrack(track);
    try {
      port.show(content, onClick);
      lastNotifiedTrackId = track.id;
      remember({ content, outcome: 'shown' });
    } catch (error) {
      remember({ content, outcome: 'failed' });
      log('[nova] the track notification could not be shown:', error);
    }
  }

  return {
    start() {
      if (disposed || unsubscribe !== undefined) return;
      unsubscribe = subscribe(handle);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const release = unsubscribe;
      unsubscribe = undefined;
      release?.();
    },
    history: () => [...records],
  };
}
