import { HeartButton } from './parts.js';
import { useRef } from 'react';
import { useStore } from 'zustand';
import { usePlaybackStore } from '../playback/PlaybackStoreProvider.js';
import { Icon } from '../theme/Icon.js';
import { Spectrum } from '../visuals/Spectrum.js';
import { LyricsBadge } from './Lyrics.js';
import { Cover } from './Cover.js';
import { SeekBar } from './SeekBar.js';
import { useAudioControls, usePrefs, useServices, useUi } from './services.js';

/** The player bar. Opaque (never see-through over the content), always the same height, every control a real button. */
export function Dock() {
  const { playback, collections, ui, audioControls } = useServices();
  const current = usePlaybackStore((s) => s.session?.current);
  const repeat = usePlaybackStore((s) => s.session?.repeatMode ?? 'off');
  const shuffle = usePlaybackStore((s) => s.session?.shuffle ?? false);
  const canNext = usePlaybackStore((s) => s.session?.canNext ?? false);
  const playing = usePlaybackStore((s) => s.engine.playing);
  const volume = usePlaybackStore((s) => s.engine.volume);
  const muted = usePlaybackStore((s) => s.engine.muted);
  const queueOpen = usePlaybackStore((s) => s.queue.open);
  const error = usePlaybackStore((s) => s.error);
  const favorite = useStore(collections, (s) => (current === undefined ? false : s.favoriteIds.has(current.track.id)));
  const speed = usePrefs((s) => s.speed);
  const dockSpectrum = usePrefs((s) => s.dockSpectrum);
  const visualizer = usePrefs((s) => s.visualizer);
  const sleep = useAudioControls((s) => s.sleep);
  const npOpen = useUi((s) => s.nowPlayingOpen);
  const speedButton = useRef<HTMLButtonElement | null>(null);
  const sleepButton = useRef<HTMLButtonElement | null>(null);

  const track = current?.track;
  const act = playback.getState();
  const anchorOf = (button: HTMLButtonElement | null) => {
    const rect = button?.getBoundingClientRect();
    return { left: rect?.left ?? 0, top: rect?.top ?? 0, width: rect?.width ?? 0, height: rect?.height ?? 0 };
  };

  return (
    <footer className="nx-dock" aria-label="Player" data-testid="player-bar" data-state={error !== undefined ? 'error' : track === undefined ? 'empty' : playing ? 'playing' : 'paused'} data-expandable={track !== undefined} onClick={(event) => {
      // Clicking the bar itself (not one of its controls) opens Now Playing.
      if (track === undefined || (event.target as HTMLElement).closest('button, input, a, [role="slider"], .nx-dock-error') !== null) return;
      audioControls.getState().activateEngine();
      ui.getState().openNowPlaying('full');
    }}>
      {error !== undefined && (
        <div className="nx-dock-error" role="alert" data-testid="player-error">
          <Icon name="close" size={16} />
          <span className="nx-ellipsis nx-text">{error.message}</span>
          {error.retryable && <button type="button" className="nx-btn nx-btn--small" onClick={() => act.togglePlay()}>Try again</button>}
          <button type="button" className="nx-btn nx-btn--small nx-btn--ghost" aria-label="Dismiss error" onClick={() => act.dismissError()}>Dismiss</button>
        </div>
      )}
      <div className="nx-dock-track">
        {track === undefined ? (
          <div className="nx-dock-meta"><span className="nx-dock-title nx-muted" data-testid="player-title">Nothing playing</span><span className="nx-dock-artist nx-faint">Pick a song to start</span></div>
        ) : (
          <>
            <button type="button" className="nx-icon-btn" style={{ width: 58, height: 58, borderRadius: 12, padding: 0 }} aria-label="Open Now Playing" onClick={() => ui.getState().openNowPlaying('full')}>
              <Cover trackId={track.id} seed={track.album ?? track.title} size="sm" label="" className="" />
            </button>
            <div className="nx-dock-meta">
              <span className="nx-dock-title nx-ellipsis nx-text" dir="auto" data-testid="player-title">{track.title}</span>
              <span className="nx-dock-artist nx-ellipsis nx-text" dir="auto" data-testid="player-artist">{track.artist}</span>
            </div>
            <HeartButton className="nx-icon-btn--small" favorite={favorite} label={favorite ? 'Remove from Favorites' : 'Add to Favorites'} testId="player-heart" onToggle={() => void collections.getState().toggleFavorite(track.id)} />
          </>
        )}
      </div>

      <div className="nx-dock-center">
        <div className="nx-dock-controls">
          <button type="button" className="nx-icon-btn" aria-label="Shuffle" data-keys="S" aria-pressed={shuffle} data-testid="player-shuffle" onClick={() => void act.setShuffle(!shuffle)}>
            <Icon name="shuffle" size={19} />
          </button>
          <button type="button" className="nx-icon-btn" aria-label="Previous" data-keys="Ctrl+←" data-testid="player-previous" disabled={track === undefined} onClick={() => void act.previous()}>
            <Icon name="prev" size={22} />
          </button>
          <button type="button" className="nx-play" aria-label={playing ? 'Pause' : 'Play'} data-keys="Space" data-testid="player-play" disabled={track === undefined} onClick={() => act.togglePlay()}>
            <Icon name={playing ? 'pause' : 'play'} size={22} />
          </button>
          <button type="button" className="nx-icon-btn" aria-label="Next" data-keys="Ctrl+→" data-testid="player-next" disabled={track === undefined || !canNext} onClick={() => void act.next()}>
            <Icon name="next" size={22} />
          </button>
          <button type="button" className="nx-icon-btn" aria-label={`Repeat: ${repeat}`} data-keys="R" aria-pressed={repeat !== 'off'} data-testid="player-repeat" onClick={() => void act.cycleRepeatMode()}>
            <Icon name={repeat === 'one' ? 'repeatOne' : 'repeat'} size={19} />
          </button>
        </div>
        <SeekBar />
      </div>

      <div className="nx-dock-right">
        {dockSpectrum && !npOpen && (
          <div className="nx-dock-spectrum" data-testid="dock-spectrum">
            <Spectrum style={visualizer === 'ring' ? 'bars' : visualizer} bars={16} />
          </div>
        )}
        <LyricsBadge />
        <button type="button" className="nx-icon-btn" aria-label="Lyrics" data-keys="L" data-testid="player-lyrics" disabled={track === undefined} onClick={() => ui.getState().openNowPlaying('lyrics')}>
          <Icon name="lyrics" size={19} />
        </button>
        <button ref={speedButton} type="button" className="nx-icon-btn" aria-label={`Playback speed ${speed}×`} data-active={speed !== 1} data-testid="player-speed" onClick={() => ui.getState().openPopover({ kind: 'speed', anchor: anchorOf(speedButton.current) })}>
          <Icon name="speed" size={19} />
        </button>
        <button ref={sleepButton} type="button" className="nx-icon-btn" aria-label="Sleep timer" data-active={sleep.mode !== 'off'} data-testid="player-sleep" onClick={() => ui.getState().openPopover({ kind: 'sleep', anchor: anchorOf(sleepButton.current) })}>
          <Icon name="timer" size={19} />
        </button>
        <button type="button" className="nx-icon-btn" aria-label="Queue" data-keys="Q" aria-pressed={queueOpen} data-testid="player-queue" onClick={() => act.setQueueOpen(!queueOpen)}>
          <Icon name="queue" size={19} />
        </button>
        <button type="button" className="nx-icon-btn" aria-label={muted ? 'Unmute' : 'Mute'} data-keys="M" aria-pressed={muted} data-testid="player-mute" onClick={() => act.toggleMute()}>
          <Icon name={muted || volume === 0 ? 'mute' : 'volume'} size={19} />
        </button>
        <input
          type="range"
          className="nx-range nx-volume"
          aria-label="Volume" data-keys="↑ / ↓"
          data-testid="player-volume"
          min={0}
          max={100}
          value={Math.round((muted ? 0 : volume) * 100)}
          style={{ ['--fill' as string]: `${Math.round((muted ? 0 : volume) * 100)}%` }}
          onChange={(event) => act.setVolume(Number(event.currentTarget.value) / 100)}
        />
        <button type="button" className="nx-icon-btn" aria-label="Open Now Playing" disabled={track === undefined} onClick={() => { audioControls.getState().activateEngine(); ui.getState().openNowPlaying('full'); }}>
          <Icon name="expand" size={18} />
        </button>
      </div>
    </footer>
  );
}
