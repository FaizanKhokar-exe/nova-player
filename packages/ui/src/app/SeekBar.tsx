import { useState } from 'react';
import { formatClock } from '../library/format.js';
import { usePlaybackPositionMs, usePlaybackStore } from '../playback/PlaybackStoreProvider.js';

/**
 * The seek slider with elapsed / total time. The only part of a screen that subscribes to the playback position, so
 * the several-times-a-second updates re-render just this. While dragging, the bar shows the dragged value and the audio is
 * sought ONCE on release (a drag must not flood the media protocol with range requests).
 */
export function SeekBar({ showTimes = true, className = 'nx-seek', stacked = false }: { showTimes?: boolean; className?: string; stacked?: boolean }) {
  const positionMs = usePlaybackPositionMs();
  const durationMs = usePlaybackStore((s) => s.engine.durationMs);
  const loaded = usePlaybackStore((s) => s.engine.loaded);
  const hasTrack = usePlaybackStore((s) => s.session?.current !== undefined);
  const seekMs = usePlaybackStore((s) => s.seekMs);
  const [dragMs, setDragMs] = useState<number | undefined>(undefined);
  const [dragging, setDragging] = useState(false);

  const max = durationMs ?? 0;
  const shown = Math.min(dragMs ?? positionMs, max > 0 ? max : (dragMs ?? positionMs));
  const seekable = hasTrack && loaded && max > 0;
  const fill = seekable ? `${Math.min(100, (shown / max) * 100)}%` : '0%';

  const commit = (value: number): void => {
    setDragMs(undefined);
    setDragging(false);
    seekMs(value);
  };

  const slider = (
    <input
      type="range"
      aria-label="Seek"
      data-testid="player-seek"
      data-dragging={dragging ? 'true' : undefined}
      min={0}
      max={max}
      step={1000}
      value={seekable ? shown : 0}
      disabled={!seekable}
      aria-valuetext={`${formatClock(shown)} of ${durationMs === undefined ? 'unknown' : formatClock(durationMs)}`}
      className="nx-range"
      style={{ flex: 1, ['--fill' as string]: fill }}
      onPointerDown={() => setDragging(true)}
      onPointerUp={(event) => {
        if (dragging) commit(Number(event.currentTarget.value));
      }}
      onChange={(event) => {
        const value = Number(event.currentTarget.value);
        if (dragging) setDragMs(value);
        else commit(value); // keyboard: every step is deliberate
      }}
    />
  );
  const start = <span data-testid="player-position" className="nx-time nx-time--start">{formatClock(shown)}</span>;
  const end = <span data-testid="player-duration" className="nx-time nx-time--end">{durationMs === undefined ? '–:––' : formatClock(durationMs)}</span>;

  if (!showTimes) return <div className={className}>{slider}</div>;
  if (stacked) {
    return (
      <div className="nx-np-seek">
        {slider}
        <div className="nx-np-seek-times">
          {start}
          {end}
        </div>
      </div>
    );
  }
  return (
    <div className={className}>
      {start}
      {slider}
      {end}
    </div>
  );
}
