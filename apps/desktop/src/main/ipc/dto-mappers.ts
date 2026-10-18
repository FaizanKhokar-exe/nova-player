import type { SearchResult, Track } from '@nova/domain';
import type {
  RootView,
  ScanJobProgress,
  ScanJobResult,
  ScanRootOutcome,
  ScanState,
  WatcherStatusView,
  ScanCounts,
} from '@nova/infrastructure';
import type {
  ScanCountsDto,
  ScanProgressDto,
  ScanResultDto,
  ScanRootResultDto,
  ScanStateDto,
  RootDto,
  SearchResultDto,
  TrackDto,
  WatcherStatusDto,
} from '@nova/shared';

/**
 * The renderer boundary. Each function builds a DTO field by field - never by
 * spreading or serializing a domain/infrastructure object - so a field added
 * to an internal type does not silently start crossing IPC, and nothing
 * internal (file paths of tracks, id provenance, driver data) can leak.
 * Absent values become absent keys.
 */

export function toTrackDto(track: Track): TrackDto {
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    ...(track.album !== undefined && { album: track.album }),
    ...(track.albumArtist !== undefined && { albumArtist: track.albumArtist }),
    ...(track.genre !== undefined && { genre: track.genre }),
    ...(track.trackNumber !== undefined && { trackNumber: track.trackNumber }),
    ...(track.discNumber !== undefined && { discNumber: track.discNumber }),
    ...(track.year !== undefined && { year: track.year }),
    ...(track.durationSeconds !== undefined && { durationSeconds: track.durationSeconds }),
    artwork: track.artwork.kind,
  };
}

export function toSearchResultDto(result: SearchResult): SearchResultDto {
  const { match } = result;
  return {
    track: toTrackDto(result.track),
    match:
      match.kind === 'field'
        ? { kind: 'field', field: match.field, quality: match.quality }
        : { kind: 'words' },
  };
}

export function toRootDto(root: RootView): RootDto {
  return {
    id: root.id,
    path: root.path,
    addedAtMs: root.addedAtMs,
    available: root.available,
    trackCount: root.trackCount,
    watched: root.watched,
  };
}

export function toCountsDto(counts: ScanCounts): ScanCountsDto {
  return {
    discovered: counts.discovered,
    skipped: counts.skipped,
    added: counts.added,
    updated: counts.updated,
    removed: counts.removed,
    failed: counts.failed,
    possibleDuplicates: counts.possibleDuplicates,
  };
}

export function toScanProgressDto(job: ScanJobProgress): ScanProgressDto {
  const { progress } = job;
  return {
    ...toCountsDto(progress),
    scanId: job.scanId,
    rootId: job.rootId,
    rootIndex: job.rootIndex,
    rootCount: job.rootCount,
    phase: progress.phase,
    processed: progress.processed,
    ...(progress.total !== undefined && { total: progress.total }),
    ...(progress.currentPath !== undefined && { currentPath: progress.currentPath }),
  };
}

function toRootResultDto(outcome: ScanRootOutcome): ScanRootResultDto {
  return {
    rootId: outcome.rootId,
    rootPath: outcome.rootPath,
    status: outcome.status,
    counts: toCountsDto(outcome.counts),
    failures: outcome.failures.map((failure) => ({ path: failure.path, kind: failure.kind, message: failure.message })),
    failureCount: outcome.failureCount,
    ...(outcome.removalWithheld !== undefined && { removalWithheld: outcome.removalWithheld }),
    ...(outcome.error !== undefined && { error: { code: outcome.error.code, message: outcome.error.message } }),
  };
}

export function toScanResultDto(result: ScanJobResult): ScanResultDto {
  return {
    scanId: result.scanId,
    status: result.status,
    startedAtMs: result.startedAtMs,
    finishedAtMs: result.finishedAtMs,
    roots: result.roots.map(toRootResultDto),
  };
}

export function toScanStateDto(state: ScanState): ScanStateDto {
  return {
    ...(state.active !== undefined && {
      active: {
        scanId: state.active.scanId,
        startedAtMs: state.active.startedAtMs,
        ...(state.active.progress !== undefined && { progress: toScanProgressDto(state.active.progress) }),
      },
    }),
    ...(state.last !== undefined && { last: toScanResultDto(state.last) }),
  };
}

export function toWatcherStatusDto(status: WatcherStatusView): WatcherStatusDto {
  return {
    running: status.running,
    roots: status.roots.map((root) => ({ rootId: root.rootId, path: root.path, state: root.state })),
    ...(status.lastReconcile !== undefined && {
      lastReconcile: {
        atMs: status.lastReconcile.atMs,
        ...(status.lastReconcile.rootId !== undefined && { rootId: status.lastReconcile.rootId }),
        counts: toCountsDto(status.lastReconcile.counts),
        status: status.lastReconcile.status,
      },
    }),
    ...(status.lastError !== undefined && {
      lastError: {
        atMs: status.lastError.atMs,
        ...(status.lastError.rootId !== undefined && { rootId: status.lastError.rootId }),
        message: status.lastError.message,
      },
    }),
  };
}
