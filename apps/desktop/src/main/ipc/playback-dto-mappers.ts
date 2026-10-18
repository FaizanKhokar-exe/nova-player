import type { MediaDenial, PlaybackCommandResult, PlaybackStateView } from '@nova/infrastructure';
import type { MediaProblemDto, PlaybackCommandResultDto, PlaybackStateDto } from '@nova/shared';
import { toTrackDto } from './dto-mappers.js';

/**
 * The playback side of the renderer boundary. Built field by field - never by
 * spreading a view - so a field added to an internal type does not silently
 * start crossing IPC. The current track becomes a path-free `TrackDto`, plus
 * the opaque `mediaUrl`; nothing else about where the file lives is sent.
 */
export function toPlaybackStateDto(state: PlaybackStateView): PlaybackStateDto {
  return {
    revision: state.revision,
    ...(state.current !== undefined && { current: { track: toTrackDto(state.current.track), mediaUrl: state.current.mediaUrl } }),
    positionMs: state.positionMs,
    repeatMode: state.repeatMode,
    shuffle: state.shuffle,
    queueLength: state.queueLength,
    ...(state.queueIndex !== undefined && { queueIndex: state.queueIndex }),
    canNext: state.canNext,
  };
}

export function toPlaybackCommandResultDto(result: PlaybackCommandResult): PlaybackCommandResultDto {
  return { outcome: result.outcome, state: toPlaybackStateDto(result.state) };
}

/** What the user is told. Several internal denials (an escape attempt, a swapped
 *  folder) deliberately collapse into the plain "cannot be opened". */
export function toMediaProblemDto(denial: MediaDenial): MediaProblemDto {
  switch (denial) {
    case 'invalid-id':
      return 'invalid-source';
    case 'track-not-found':
    case 'root-not-registered':
      return 'not-in-library';
    case 'root-unavailable':
      return 'folder-unavailable';
    case 'file-missing':
    case 'not-a-file':
      return 'file-missing';
    case 'unsupported-format':
      return 'unsupported-format';
    case 'root-changed':
    case 'outside-root':
    case 'file-inaccessible':
      return 'file-inaccessible';
  }
}
