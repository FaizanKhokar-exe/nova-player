import type { QueueState } from './queue.js';

/**
 * What should happen next, as a domain decision - never an instruction to
 * actually play audio. Infrastructure/application code (a later phase)
 * decides HOW to carry this out (load a file, seek, restart an <audio>
 * element, ...); this module only ever decides WHAT should happen.
 */
export type PlaybackDecision =
  | { readonly kind: 'playIndex'; readonly index: number }
  | { readonly kind: 'restartCurrent' }
  | { readonly kind: 'noNextTrack' }
  | { readonly kind: 'noPreviousTrack' }
  | { readonly kind: 'queueEmpty' };

/**
 * The reference product's rule, carried forward exactly rather than
 * reinvented: pressing "previous" restarts the current track instead of
 * moving to the previous one once playback is far enough into the track
 * that jumping backward a whole track would almost certainly not be what
 * the user meant. Kept as an explicit, testable, named constant rather than
 * a magic number inline.
 *
 * In milliseconds, not seconds (Phase 1E consistency fix: this constant and
 * `decideOnPreviousPressed`'s parameter were originally in seconds, the
 * only place in the domain that used seconds for a playback position -
 * Phase 1D's lyrics domain uses milliseconds throughout via `timeMs`.
 * Standardizing on milliseconds as the one domain-wide playback-position
 * unit means a future integration layer never has to convert between the
 * two, or risk passing raw seconds into a milliseconds-expecting function).
 */
export const PREVIOUS_RESTART_THRESHOLD_MS = 3000;

function decideAdvance(state: QueueState): PlaybackDecision {
  if (state.tracks.length === 0 || state.currentIndex === undefined) {
    return { kind: 'queueEmpty' };
  }

  const nextIndex = state.currentIndex + 1;
  if (nextIndex < state.tracks.length) {
    return { kind: 'playIndex', index: nextIndex };
  }

  if (state.repeatMode === 'all') {
    return { kind: 'playIndex', index: 0 };
  }

  return { kind: 'noNextTrack' };
}

/**
 * What should happen when the current track finishes playing on its own
 * (not because the user pressed Next - see `decideOnNextPressed` for that).
 *
 * Repeat ONE only applies here: a track that finishes naturally while
 * repeat-one is active restarts itself. This is the standard music-player
 * convention - repeat-one governs what happens when a track ends, it does
 * not trap you in place if you explicitly ask to skip past it (see
 * `decideOnNextPressed`).
 */
export function decideOnTrackFinished(state: QueueState): PlaybackDecision {
  if (state.tracks.length === 0 || state.currentIndex === undefined) {
    return { kind: 'queueEmpty' };
  }
  if (state.repeatMode === 'one') {
    return { kind: 'restartCurrent' };
  }
  return decideAdvance(state);
}

/**
 * What should happen when the user explicitly presses Next. Always
 * advances (or wraps, under repeat ALL, or reports no next track, under
 * repeat OFF) regardless of repeat ONE - an explicit skip is never trapped
 * by repeat-one.
 */
export function decideOnNextPressed(state: QueueState): PlaybackDecision {
  return decideAdvance(state);
}

/**
 * What should happen when the user presses Previous, given how far into
 * the current track playback has progressed.
 *
 * - At or past the restart threshold: always restart the current track,
 *   regardless of queue position - carried forward exactly from the
 *   reference product's behavior.
 * - Below the threshold, with an earlier track available: move to it.
 * - Below the threshold, already at the first track: wrap to the last
 *   track under repeat ALL, otherwise report there is no previous track.
 *   (Repeat ONE does not affect this - it only governs natural track-end
 *   behavior, see `decideOnTrackFinished`.)
 */
export function decideOnPreviousPressed(
  state: QueueState,
  currentPositionMs: number,
): PlaybackDecision {
  if (state.tracks.length === 0 || state.currentIndex === undefined) {
    return { kind: 'queueEmpty' };
  }

  if (currentPositionMs >= PREVIOUS_RESTART_THRESHOLD_MS) {
    return { kind: 'restartCurrent' };
  }

  const previousIndex = state.currentIndex - 1;
  if (previousIndex >= 0) {
    return { kind: 'playIndex', index: previousIndex };
  }

  if (state.repeatMode === 'all') {
    return { kind: 'playIndex', index: state.tracks.length - 1 };
  }

  return { kind: 'noPreviousTrack' };
}
