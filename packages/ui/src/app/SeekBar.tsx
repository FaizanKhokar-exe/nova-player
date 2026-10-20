import { useEffect, useMemo, useState } from 'react';
import { useNowPlaying } from '../nowplaying/NowPlayingStoreProvider.js';
import { SeekPreview } from './SeekPreview.js';
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
  const [hover, setHover] = useState<number | undefined>(undefined);
  const [profileFor, setProfileFor] = useState<{ trackId: string; profile: readonly number[] | undefined } | undefined>(undefined);
  const trackId = usePlaybackStore((s) => s.session?.current?.track.id);
  const energyProfile = usePlaybackStore((s) => s.energyProfile);
  const lyrics = useNowPlaying((s) => s.lyrics);
  const lineTimes = useMemo(() => (lyrics.status === 'ready' && lyrics.availability === 'found' ? lyrics.lines.map((line) => line.timeMs) : []), [lyrics]);
  // The profile is read the first time the pointer visits the bar for a song, not before (decoding costs a little).
  const wantProfile = hover !== undefined && trackId !== undefined && profileFor?.trackId !== trackId;
  useEffect(() => {
    if (!wantProfile || trackId === undefined) return;
    let live = true;
    void energyProfile().then((profile) => { if (live) setProfileFor({ trackId, profile }); });
    return () => { live = false; };
  }, [wantProfile, trackId, energyProfile]);
  const profile = profileFor?.trackId === trackId ? profileFor?.profile : undefined;

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
    <div className="nx-seek-wrap">
    {hover !== undefined && seekable && <SeekPreview fraction={hover} profile={profile} lineTimesMs={lineTimes} durationMs={max} analysing={profileFor?.trackId !== trackId} />}
    <input
      type="range"
      aria-label="Seek"
      data-no-tip="true" /* the hover preview is the seek bar's own tooltip */
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
      onPointerMove={(event) => { const r = event.currentTarget.getBoundingClientRect(); if (r.width > 0) setHover((event.clientX - r.left) / r.width); }}
      onPointerLeave={() => setHover(undefined)}
      onPointerUp={(event) => {
        if (dragging) commit(Number(event.currentTarget.value));
      }}
      onChange={(event) => {
        const value = Number(event.currentTarget.value);
        if (dragging) setDragMs(value);
        else commit(value); // keyboard: every step is deliberate
      }}
    />
    </div>
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
