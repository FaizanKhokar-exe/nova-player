import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { LyricLineDto } from '@nova/shared';
import { activeLyricIndex, lyricSeekMs } from '../nowplaying/lyric-sync.js';
import { useNowPlaying, useNowPlayingStoreApi } from '../nowplaying/NowPlayingStoreProvider.js';
import { usePlaybackPositionSelector, usePlaybackStore } from '../playback/PlaybackStoreProvider.js';
import { Icon } from '../theme/Icon.js';
import { usePrefs, useServices } from './services.js';

/** How much each line fades, blurs and shrinks with its distance from the line being sung (Apple-style depth). */
const OPACITY = [1, 0.62, 0.46, 0.34, 0.26, 0.2];
const BLUR = [0, 1.1, 2.2, 3.2, 4.2, 5];

/** Estimated time to sing a line (ms): long enough to look like a sweep, never longer than the gap to the next line. */
export function singDurationMs(text: string, gapMs: number): number {
  const estimate = Math.max(900, text.length * 85);
  return Math.max(400, Math.min(estimate, gapMs * 0.94));
}

const Line = memo(function Line({ line, index, distance, active, depthBlur, singMs, onSeek }: { line: LyricLineDto; index: number; distance: number; active: boolean; depthBlur: boolean; singMs: number; onSeek: (line: LyricLineDto) => void }) {
  const step = Math.min(Math.abs(distance), OPACITY.length - 1);
  return (
    <button
      type="button"
      className="nx-lyric"
      data-testid="lyric-line"
      data-index={index}
      data-active={active ? 'true' : 'false'}
      data-state={active ? 'current' : distance < 0 ? 'past' : 'future'}
      data-time-ms={line.timeMs}
      data-sing-ms={Math.round(singMs)}
      aria-current={active ? 'true' : undefined}
      title="Play from here"
      onClick={() => onSeek(line)}
      style={{
        ['--lyric-opacity' as string]: active ? 1 : OPACITY[step],
        ['--lyric-blur' as string]: `${active || !depthBlur ? 0 : BLUR[step]}px`,
        ['--lyric-scale' as string]: active ? 1 : 0.96,
      }}
    >
      {line.text === '' ? <span aria-label="Instrumental break">♪ ♪ ♪</span> : <span className={active ? 'nx-lyric-fill nx-text' : 'nx-text'} dir="auto">{line.text}</span>}
    </button>
  );
});

/**
 * The lyrics: left-aligned, bold, the line being sung bright with a smooth left-to-right fill that follows the
 * music (interpolated between position reports so it moves fluidly), the others dimmed and softly blurred by distance.
 * The list scrolls to keep the sung line at the visual centre; scrolling by hand pauses that until "Jump to now".
 */
export function Lyrics() {
  const { playback } = useServices();
  const trackId = useNowPlaying((s) => s.trackId);
  const lyrics = useNowPlaying((s) => s.lyrics);
  const action = useNowPlaying((s) => s.lyricsAction);
  const nowPlaying = useNowPlayingStoreApi();
  const hasTrack = usePlaybackStore((s) => s.session?.current !== undefined);
  const playing = usePlaybackStore((s) => s.engine.playing);
  const seekMs = usePlaybackStore((s) => s.seekMs);
  const depthBlur = usePrefs((s) => s.lyricsDepthBlur);
  const speed = usePrefs((s) => s.speed);
  const lines = lyrics.lines;
  const activeIndex = usePlaybackPositionSelector((positionMs) => activeLyricIndex(lines, positionMs) ?? -1);

  const scroller = useRef<HTMLDivElement | null>(null);
  const [detachedFor, setDetachedFor] = useState<string | undefined>(undefined);
  const detachTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const detached = detachedFor !== undefined && detachedFor === trackId;

  const centre = useCallback((index: number, behavior: ScrollBehavior) => {
    const container = scroller.current;
    if (container === null || index < 0) return;
    const row = container.querySelector<HTMLElement>(`[data-index="${index}"]`);
    if (row === null || typeof container.scrollTo !== 'function') return;
    container.scrollTo({ top: row.offsetTop - container.clientHeight * 0.38 + row.offsetHeight / 2, behavior });
  }, []);

  useEffect(() => {
    if (!detached) centre(activeIndex, activeIndex <= 0 ? 'auto' : 'smooth');
  }, [activeIndex, detached, trackId, lines, centre]);

  // The sweep: --p (0..100%) on the sung line, advanced every frame between the ~4 Hz position reports.
  useEffect(() => {
    if (activeIndex < 0 || document.documentElement.dataset['reduceMotion'] === 'true') return;
    const line = lines[activeIndex];
    const next = lines[activeIndex + 1];
    const element = scroller.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"] .nx-lyric-fill`);
    if (line === undefined || element === null || element === undefined) return;
    const sing = singDurationMs(line.text, (next?.timeMs ?? line.timeMs + 6_000) - line.timeMs);
    const positions = playback.getState().positionStore;
    let base = { positionMs: positions.getState().positionMs, at: performance.now() };
    const stop = positions.subscribe((s) => (base = { positionMs: s.positionMs, at: performance.now() }));
    let frame = 0;
    const draw = (): void => {
      const now = playback.getState().engine.playing ? base.positionMs + (performance.now() - base.at) * speed : base.positionMs;
      element.style.setProperty('--p', `${Math.max(0, Math.min(100, ((now - line.timeMs) / sing) * 100)).toFixed(1)}%`);
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      stop();
    };
  }, [activeIndex, lines, playback, speed, playing]);

  const detach = useCallback(() => {
    setDetachedFor(trackId);
    if (detachTimer.current !== undefined) clearTimeout(detachTimer.current);
    detachTimer.current = setTimeout(() => setDetachedFor(undefined), 6_000); // drifts back by itself
  }, [trackId]);
  useEffect(
    () => () => {
      if (detachTimer.current !== undefined) clearTimeout(detachTimer.current);
    },
    [],
  );

  const onSeek = useCallback((line: LyricLineDto) => seekMs(lyricSeekMs(line)), [seekMs]);
  const attach = (
    <button type="button" className="nx-btn" style={{ background: 'rgba(255,255,255,.16)', color: '#fff', borderColor: 'transparent' }} disabled={action.busy} data-testid="attach-lyrics" onClick={() => void nowPlaying?.getState().attachLyrics()}>
      <Icon name="upload" size={16} /> Attach a .lrc file…
    </button>
  );

  let body: React.ReactNode;
  if (!hasTrack) body = <div className="nx-lyrics-empty" data-testid="lyrics-idle"><span>Play something and its lyrics will show up here.</span></div>;
  else if (lyrics.status === 'idle' || lyrics.status === 'loading') body = <div className="nx-lyrics-empty" data-testid="lyrics-loading"><span>Loading lyrics…</span></div>;
  else if (lyrics.status === 'error') body = <div className="nx-lyrics-empty" data-testid="lyrics-error"><span>Lyrics couldn’t be loaded right now.</span><button type="button" className="nx-btn" onClick={() => nowPlaying?.getState().retryLyrics()}>Try again</button></div>;
  else if (lyrics.availability === 'none') body = <div className="nx-lyrics-empty" data-testid="lyrics-none"><Icon name="lyrics" size={34} /><span>No lyrics for this song yet. Put a .lrc file with the same name next to it, or attach one yourself.</span>{attach}</div>;
  else if (lyrics.availability === 'empty') body = <div className="nx-lyrics-empty" data-testid="lyrics-empty"><span>This lyrics file has no timed lines.</span>{attach}</div>;
  else if (lyrics.availability === 'unavailable') body = <div className="nx-lyrics-empty" data-testid="lyrics-unavailable"><span>Lyrics aren’t available right now - the song’s folder can’t be reached.</span></div>;
  else if (lyrics.availability === 'unreadable') body = <div className="nx-lyrics-empty" data-testid="lyrics-unreadable"><span>This lyrics file couldn’t be read.</span>{attach}</div>;
  else {
    body = (
      <div key={trackId} ref={scroller} className="nx-lyrics" role="list" aria-label="Lyrics" data-testid="lyrics-list" onWheel={detach} onTouchMove={detach}>
        {lines.map((line, index) => (
          <Line key={`${index}-${line.timeMs}`} line={line} index={index} distance={activeIndex < 0 ? index + 1 : index - activeIndex} active={index === activeIndex} depthBlur={depthBlur} singMs={singDurationMs(line.text, (lines[index + 1]?.timeMs ?? line.timeMs + 6_000) - line.timeMs)} onSeek={onSeek} />
        ))}
      </div>
    );
  }

  const found = lyrics.status === 'ready' && lyrics.availability === 'found';
  return (
    <section className="nx-np-right" aria-label="Lyrics" data-testid="lyrics-panel" data-playing={playing ? 'true' : 'false'} data-status={lyrics.status === 'ready' ? (lyrics.availability ?? 'ready') : lyrics.status}>
      {body}
      {detached && found && (
        <button type="button" className="nx-btn nx-lyrics-jump" style={{ background: 'rgba(255,255,255,.2)', color: '#fff', borderColor: 'transparent', backdropFilter: 'blur(10px)' }} data-testid="lyrics-jump" onClick={() => { setDetachedFor(undefined); centre(activeIndex, 'smooth'); }}>
          <Icon name="down" size={15} /> Jump to now
        </button>
      )}
      {(action.message !== undefined || (found && hasTrack)) && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, padding: '6px 0 0', minHeight: 40, flexWrap: 'wrap' }} data-testid="lyrics-actions">
          {action.message !== undefined && (
            <span role="status" data-testid="lyrics-action-message" style={{ color: 'var(--np-muted)', fontSize: 13 }}>
              {action.message} <button type="button" className="nx-icon-btn nx-icon-btn--small" aria-label="Dismiss message" onClick={() => nowPlaying?.getState().dismissLyricsMessage()}><Icon name="close" size={14} /></button>
            </span>
          )}
          {found && !lyrics.attached && <button type="button" className="nx-pill" style={{ background: 'rgba(255,255,255,.14)', color: '#fff', borderColor: 'transparent' }} disabled={action.busy} onClick={() => void nowPlaying?.getState().attachLyrics()}>Use a different .lrc…</button>}
          {found && lyrics.attached && (
            <>
              <span style={{ color: 'var(--np-muted)', fontSize: 13 }} data-testid="lyrics-attached-note">Using the .lrc you attached</span>
              <button type="button" className="nx-pill" style={{ background: 'rgba(255,255,255,.14)', color: '#fff', borderColor: 'transparent' }} aria-label="Remove attached lyrics" disabled={action.busy} onClick={() => void nowPlaying?.getState().detachLyrics()}>Remove</button>
            </>
          )}
        </div>
      )}
    </section>
  );
}

