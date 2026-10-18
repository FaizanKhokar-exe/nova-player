import type { LibraryGroup } from '@nova/domain';
import type { LibrarySummary, QueueView } from '@nova/infrastructure';
import type { GroupDto, LibrarySummaryDto, QueueDto } from '@nova/shared';
import { toTrackDto } from './dto-mappers.js';

/** The browse/queue side of the renderer boundary: field by field, absent keys instead of undefined, no paths. */
export function toGroupDto(group: LibraryGroup): GroupDto {
  return {
    kind: group.kind,
    key: group.key,
    name: group.name,
    unknown: group.unknown,
    trackCount: group.trackCount,
    ...(group.durationSeconds !== undefined && { durationSeconds: group.durationSeconds }),
    ...(group.artist !== undefined && { artist: group.artist }),
    ...(group.year !== undefined && { year: group.year }),
    ...(group.albumCount !== undefined && { albumCount: group.albumCount }),
    ...(group.coverTrackId !== undefined && { coverTrackId: group.coverTrackId }),
  };
}

export function toLibrarySummaryDto(summary: LibrarySummary): LibrarySummaryDto {
  return { trackCount: summary.trackCount, albumCount: summary.albumCount, artistCount: summary.artistCount, genreCount: summary.genreCount };
}

export function toQueueDto(queue: QueueView): QueueDto {
  return {
    revision: queue.revision,
    total: queue.total,
    ...(queue.currentIndex !== undefined && { currentIndex: queue.currentIndex }),
    offset: queue.offset,
    items: queue.items.map((item) => ({ position: item.position, track: toTrackDto(item.track) })),
  };
}
