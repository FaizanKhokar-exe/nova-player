import type { TrackSummary } from '@nova/shared';

/**
 * Phase 0 smoke-test component only - proves the @nova/ui package can hold
 * a real React component that imports a shared type and renders correctly
 * under React Testing Library. Real presentational components (track rows
 * backed by the virtualized list, queue items, EQ sliders, ...) start in
 * Phase 5/6 per the accepted roadmap.
 */
export function TrackTitle({ track }: { track: TrackSummary }) {
  return <span data-testid="track-title">{track.title}</span>;
}
