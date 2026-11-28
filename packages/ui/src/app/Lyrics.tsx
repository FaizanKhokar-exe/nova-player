import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { LyricLineDto } from '@nova/shared';
import { activeLyricIndex, lyricSeekMs } from '../nowplaying/lyric-sync.js';
import { useNowPlaying, useNowPlayingStoreApi } from '../nowplaying/NowPlayingStoreProvider.js';
import { usePlaybackPositionSelector, usePlaybackStore } from '../playback/PlaybackStoreProvider.js';
import { Icon } from '../theme/Icon.js';
import { usePrefs, useServices } from './services.js';
import { isRtlText } from './rtl.js';
import type { SungLines } from '../prefs/prefs-store.js';

/** How much each line fades, blurs and shrinks with its distance from the line being sung (Apple-style depth). */
const OPACITY = [1, 0.62, 0.46, 0.34, 0.26, 0.2];
const BLUR = [0, 1.1, 2.2, 3.2, 4.2, 5];

/** Estimated time to sing a line (ms): long enough to look like a sweep, never longer than the gap to the next line. */
export function singDurationMs(text: string, gapMs: number): number {
  const estimate = Math.max(900, text.length * 85);
  return Math.max(400, Math.min(estimate, gapMs * 0.94));
}

const Line = memo(function Line({ line, index, distance, active, depthBlur, singMs, sung, reveal, onSeek }: { line: LyricLineDto; index: number; distance: number; active: boolean; depthBlur: boolean; singMs: number; sung: SungLines; reveal: boolean; onSeek: (line: LyricLineDto) => void }) {
  const step = Math.min(Math.abs(distance), OPACITY.length - 1);
  // Lines already sung: dim (normal), fade away over two lines, or vanish. While the listener scrolls by hand (`reveal`) everything shows.
  const rtl = isRtlText(line.text);
  const gone = !reveal && distance < 0 && (sung === 'hide' || (sung === 'fade' && distance < -2));
  const fading = !reveal && distance < 0 && sung === 'fade' && distance >= -2;
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
      data-gone={gone ? 'true' : undefined}
      dir={rtl ? 'rtl' : 'ltr'}
      data-rtl={rtl ? 'true' : undefined}
      tabIndex={gone ? -1 : undefined}
      title="Play from here"
      onClick={() => onSeek(line)}
      style={{
        ['--lyric-opacity' as string]: active ? 1 : gone ? 0 : fading ? (distance === -1 ? 0.2 : 0.07) : OPACITY[step],
        ['--lyric-blur' as string]: `${active || !depthBlur ? 0 : BLUR[step]}px`,
        ['--lyric-scale' as string]: active ? 1 : 0.96,
      }}
    >
      {line.text === '' ? <span aria-label="Instrumental break">♪ ♪ ♪</span> : <span className={active ? 'nx-lyric-fill nx-text' : 'nx-text'} dir="auto" lang={rtl ? 'ur' : undefined}>{line.text}</span>}
    </button>
  );
});

/**
 * The lyrics: left-aligned, bold, the line being sung bright with a smooth left-to-right fill that follows the
 * music (interpolated between position reports so it moves fluidly), the others dimmed and softly blurred by distance.
 * The list scrolls to keep the sung line at the visual centre; scrolling by hand pauses that until "Jump to now".
 */
export function Lyrics() {
  const { playback, studio } = useServices();
  const trackId = useNowPlaying((s) => s.trackId);
  const lyrics = useNowPlaying((s) => s.lyrics);
  const action = useNowPlaying((s) => s.lyricsAction);
  const nowPlaying = useNowPlayingStoreApi();
  const hasTrack = usePlaybackStore((s) => s.session?.current !== undefined);
  const playing = usePlaybackStore((s) => s.engine.playing);
  const seekMs = usePlaybackStore((s) => s.seekMs);
  const depthBlur = usePrefs((s) => s.lyricsDepthBlur);
  const animation = usePrefs((s) => s.lyricsAnimation);
  const sung = usePrefs((s) => s.sungLines);
  const align = usePrefs((s) => s.lyricsAlign);
  const textCase = usePrefs((s) => s.lyricsCase);
  const font = usePrefs((s) => s.lyricsFont);
  const speed = usePrefs((s) => s.speed);
  const lines = lyrics.lines;
  const activeIndex = usePlaybackPositionSelector((positionMs) => activeLyricIndex(lines, positionMs) ?? -1);

  const scroller = useRef<HTMLDivElement | null>(null);

  // --- Following the sung line -------------------------------------------------------------------------------------------
  // The list glides to each new line with its own easing (the browser's built-in smooth scroll restarts, and stutters, every time
  // a new line arrives while the last glide is still running). It stops the moment the listener takes over.
  const glide = useRef<{ frame: number; target: number }>({ frame: 0, target: 0 });
  const stopGlide = useCallback(() => {
    cancelAnimationFrame(glide.current.frame);
    glide.current.frame = 0;
  }, []);
  const scrollToTop = useCallback((wanted: number, instant: boolean) => {
    const container = scroller.current;
    if (container === null) return;
    const target = Math.max(0, Math.min(wanted, container.scrollHeight - container.clientHeight));
    glide.current.target = target;
    if (instant || document.documentElement.dataset['reduceMotion'] === 'true') {
      stopGlide();
      container.scrollTop = target;
      return;
    }
    if (glide.current.frame !== 0) return; // already gliding: it simply has a new target
    let last = performance.now();
    const step = (now: number): void => {
      const dt = Math.min(64, now - last);
      last = now;
      const diff = glide.current.target - container.scrollTop;
      if (Math.abs(diff) < 1.2) {
        container.scrollTop = glide.current.target;
        glide.current.frame = 0;
        return;
      }
      container.scrollTop += diff * (1 - Math.exp(-dt / 150));
      glide.current.frame = requestAnimationFrame(step);
    };
    glide.current.frame = requestAnimationFrame(step);
  }, [stopGlide]);
  useEffect(() => stopGlide, [stopGlide]);

  const [detachedFor, setDetachedFor] = useState<string | undefined>(undefined);
  const [away, setAway] = useState<'above' | 'below' | undefined>(undefined);
  const detachTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const detached = detachedFor !== undefined && detachedFor === trackId;

  const rowTop = useCallback((index: number): number | undefined => {
    const container = scroller.current;
    const row = container?.querySelector<HTMLElement>(`[data-index="${index}"]`);
    if (container === null || container === undefined || row === null || row === undefined) return undefined;
    return row.offsetTop - container.clientHeight * 0.38 + row.offsetHeight / 2;
  }, []);
  const centre = useCallback((index: number, instant: boolean) => {
    if (index < 0) return;
    const top = rowTop(index);
    if (top !== undefined) scrollToTop(top, instant);
  }, [rowTop, scrollToTop]);

  useEffect(() => {
    if (!detached) centre(activeIndex, activeIndex <= 0);
  }, [activeIndex, detached, trackId, lines, centre]);

  // "Jump to now" is shown exactly while the sung line is out of the comfortable middle of the view, and says which way it is.
  const measure = useCallback(() => {
    const container = scroller.current;
    const top = activeIndex < 0 ? undefined : rowTop(activeIndex);
    if (container === null || top === undefined) return setAway(undefined);
    const delta = top - container.scrollTop;
    setAway(Math.abs(delta) > container.clientHeight * 0.3 ? (delta < 0 ? 'above' : 'below') : undefined);
  }, [activeIndex, rowTop]);
  useEffect(() => { if (detached) measure(); }, [detached, measure, lines]);
  const shownAway = detached ? away : undefined;
  const measureFrame = useRef(0);
  const onScroll = useCallback(() => {
    if (!detached || measureFrame.current !== 0) return;
    measureFrame.current = requestAnimationFrame(() => { measureFrame.current = 0; measure(); });
  }, [detached, measure]);
  useEffect(() => () => cancelAnimationFrame(measureFrame.current), []);

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

  /** The listener scrolls by hand (wheel, touch, keys): stop following, and drift back by itself after a quiet while. */
  const detach = useCallback(() => {
    stopGlide();
    setDetachedFor(trackId);
    if (detachTimer.current !== undefined) clearTimeout(detachTimer.current);
    detachTimer.current = setTimeout(() => setDetachedFor(undefined), 8_000);
  }, [trackId, stopGlide]);
  const rejoin = useCallback(() => {
    if (detachTimer.current !== undefined) clearTimeout(detachTimer.current);
    setDetachedFor(undefined);
  }, []);
  const onKeyScroll = useCallback((event: React.KeyboardEvent) => {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) detach();
  }, [detach]);
  useEffect(
    () => () => {
      if (detachTimer.current !== undefined) clearTimeout(detachTimer.current);
    },
    [],
  );

  const onSeek = useCallback((line: LyricLineDto) => { rejoin(); seekMs(lyricSeekMs(line)); }, [seekMs, rejoin]);
  const create = (
    <button type="button" className="nx-btn nx-btn--primary" disabled={action.busy} data-testid="create-lyrics" onClick={() => studio.getState().openStudio()}>
      <Icon name="sparkles" size={16} /> Create synced lyrics…
    </button>
  );
  const attach = (
    <button type="button" className="nx-btn" style={{ background: 'rgba(255,255,255,.16)', color: '#fff', borderColor: 'transparent' }} disabled={action.busy} data-testid="attach-lyrics" onClick={() => void nowPlaying?.getState().attachLyrics()}>
      <Icon name="upload" size={16} /> Attach a .lrc file…
    </button>
  );

  let body: React.ReactNode;
  if (!hasTrack) body = <div className="nx-lyrics-empty" data-testid="lyrics-idle"><span>Play something and its lyrics will show up here.</span></div>;
  else if (lyrics.status === 'idle' || lyrics.status === 'loading') body = <div className="nx-lyrics-empty" data-testid="lyrics-loading"><span>Loading lyrics…</span></div>;
  else if (lyrics.status === 'error') body = <div className="nx-lyrics-empty" data-testid="lyrics-error"><span>Lyrics couldn’t be loaded right now.</span><button type="button" className="nx-btn" onClick={() => nowPlaying?.getState().retryLyrics()}>Try again</button></div>;
  else if (lyrics.availability === 'none') body = <div className="nx-lyrics-empty" data-testid="lyrics-none"><Icon name="lyrics" size={34} /><span>No lyrics for this song yet. Put a .lrc file with the same name next to it, or attach one yourself - or let Nova Player help you make one.</span>{create}{attach}</div>;
  else if (lyrics.availability === 'empty') body = <div className="nx-lyrics-empty" data-testid="lyrics-empty"><span>This lyrics file has no timed lines.</span>{attach}</div>;
  else if (lyrics.availability === 'unavailable') body = <div className="nx-lyrics-empty" data-testid="lyrics-unavailable"><span>Lyrics aren’t available right now - the song’s folder can’t be reached.</span></div>;
  else if (lyrics.availability === 'unreadable') body = <div className="nx-lyrics-empty" data-testid="lyrics-unreadable"><span>This lyrics file couldn’t be read.</span>{attach}</div>;
  else {
    body = (
      <div key={trackId} ref={scroller} className="nx-lyrics" role="list" aria-label="Lyrics" data-testid="lyrics-list" onWheel={detach} onTouchMove={detach} onKeyDown={onKeyScroll} onScroll={onScroll}>
        {lines.map((line, index) => (
          <Line key={`${index}-${line.timeMs}`} line={line} index={index} distance={activeIndex < 0 ? index + 1 : index - activeIndex} active={index === activeIndex} depthBlur={depthBlur} sung={sung} reveal={detached} singMs={singDurationMs(line.text, (lines[index + 1]?.timeMs ?? line.timeMs + 6_000) - line.timeMs)} onSeek={onSeek} />
        ))}
      </div>
    );
  }

  const found = lyrics.status === 'ready' && lyrics.availability === 'found';
  return (
    <section className="nx-np-right" aria-label="Lyrics" data-testid="lyrics-panel" data-anim={animation} data-align={align} data-case={textCase} data-font={font} data-playing={playing ? 'true' : 'false'} data-status={lyrics.status === 'ready' ? (lyrics.availability ?? 'ready') : lyrics.status}>
      {body}
      {found && (
        <button type="button" className="nx-btn nx-lyrics-jump" data-show={detached && away !== undefined ? 'true' : 'false'} data-away={shownAway} tabIndex={detached && away !== undefined ? 0 : -1} aria-hidden={detached && away !== undefined ? undefined : true} data-testid="lyrics-jump" onClick={() => { rejoin(); centre(activeIndex, false); }}>
          <Icon name={shownAway === 'above' ? 'chevronUp' : 'down'} size={15} /> Jump to now
        </button>
      )}
    </section>
  );
}


/** A small control in the player bar (the only place for it): which .lrc is in use, with one click to swap or remove it. Shows only when the playing song has lyrics. */
export function LyricsBadge() {
  const lyrics = useNowPlaying((s) => s.lyrics);
  const action = useNowPlaying((s) => s.lyricsAction);
  const nowPlaying = useNowPlayingStoreApi();
  const { studio } = useServices();
  const found = lyrics.status === 'ready' && lyrics.availability === 'found';
  const none = lyrics.status === 'ready' && lyrics.availability === 'none';
  if (!found && !none && action.message === undefined) return null;
  const attached = found && lyrics.attached;
  const label = attached ? 'Using the .lrc you attached – click to remove it' : 'Use a different .lrc file…';
  return (
    <div className="nx-lrc-badge" data-testid="lyrics-actions">
      {action.message !== undefined && (
        <button type="button" className="nx-lrc-msg" role="status" data-testid="lyrics-action-message" aria-label={`${action.message} (dismiss)`} onClick={() => nowPlaying?.getState().dismissLyricsMessage()}>{action.message}</button>
      )}
      {none && (
        <button type="button" className="nx-lrc-btn" aria-label="Create synced lyrics for this song" data-tip="Create synced lyrics…" data-testid="lyrics-create" onClick={() => studio.getState().openStudio()}>
          <Icon name="sparkles" size={15} />
        </button>
      )}
      {found && (
        <button type="button" className="nx-lrc-btn" aria-label="Fix or redo the timing in Lyric Studio" data-tip="Fix / redo timing in Lyric Studio…" data-testid="lyrics-retime" onClick={() => studio.getState().openStudio()}>
          <Icon name="sparkles" size={15} />
        </button>
      )}
      {found && (
        <button type="button" className="nx-lrc-btn" data-active={attached} aria-label={label} data-tip={label} disabled={action.busy} data-testid={attached ? 'lyrics-attached-note' : 'lyrics-attach-other'} onClick={() => void (attached ? nowPlaying?.getState().detachLyrics() : nowPlaying?.getState().attachLyrics())}>
          <Icon name={attached ? 'close' : 'upload'} size={15} />
        </button>
      )}
    </div>
  );
}
