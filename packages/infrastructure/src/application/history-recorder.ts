import type { PlaybackApplication } from './playback-application.js';

/** A track counts as played once this much of it has been heard (reported position), or it finishes. */
export const HISTORY_MIN_PLAYED_MS = 5_000;

export interface HistoryRecorderDependencies {
  readonly playback: Pick<PlaybackApplication, 'subscribeActivity'>;
  /** Records one play of a track. Failures are contained (see `onError`). */
  readonly record: (trackId: string) => void;
  readonly onError?: (error: unknown) => void;
  readonly minPlayedMs?: number;
}

/**
 * Records "recently played" in the main process, with no IPC channel of its own.
 *
 * The hook: the playback application already receives everything needed from the renderer's normal traffic and
 * re-publishes it as activity events (`subscribeActivity`) - `track-started` (a command made a track current), `position-reported` (the renderer's
 * periodic `playback:reportPosition`, only for the current track) and `track-finished` (`playback:trackFinished`).
 *
 * Rule: each PLAY of a track is recorded once, as soon as either its reported position reaches the threshold
 * (5 s) or it finishes - whichever comes first. A play begins when a command starts the track, or when it finishes
 * (so repeat-one and replaying a finished track count again). Seeking back and forward inside one play, or
 * pausing and resuming, does not record twice. A track that resumes from a restored session (no `track-started`)
 * is treated as a play of its own as soon as it reports a position past the threshold.
 */
export function createHistoryRecorder(dependencies: HistoryRecorderDependencies): () => void {
  const { playback, record, onError } = dependencies;
  const threshold = dependencies.minPlayedMs ?? HISTORY_MIN_PLAYED_MS;
  let armed: { readonly trackId: string; recorded: boolean } | undefined;

  const recordOnce = (): void => {
    if (armed === undefined || armed.recorded) return;
    armed.recorded = true;
    try {
      record(armed.trackId);
    } catch (error) {
      try {
        onError?.(error);
      } catch {
        // nothing sensible is left to do
      }
    }
  };

  return playback.subscribeActivity((event) => {
    switch (event.type) {
      case 'track-started':
        armed = { trackId: event.trackId, recorded: false };
        break;
      case 'position-reported':
        if (armed?.trackId !== event.trackId) armed = { trackId: event.trackId, recorded: false };
        if (event.positionMs >= threshold) recordOnce();
        break;
      case 'track-finished':
        if (armed?.trackId !== event.trackId) armed = { trackId: event.trackId, recorded: false };
        recordOnce();
        armed = { trackId: event.trackId, recorded: false }; // the next play of it (repeat one, replay) starts here
        break;
      default:
        break;
    }
  });
}
