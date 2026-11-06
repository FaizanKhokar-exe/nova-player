import { HeartButton } from './parts.js';
import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { useNowPlaying } from '../nowplaying/NowPlayingStoreProvider.js';
import { Artwork } from '../nowplaying/Artwork.js';
import { usePlaybackStore } from '../playback/PlaybackStoreProvider.js';
import { Icon, type IconName } from '../theme/Icon.js';
import { ParticleField } from '../visuals/ParticleField.js';
import { Spectrum } from '../visuals/Spectrum.js';
import { Lyrics } from './Lyrics.js';
import { SeekBar } from './SeekBar.js';
import { usePrefs, useServices, useUi } from './services.js';
import type { NowPlayingLayout } from './ui-store.js';

const MODES: ReadonlyArray<{ id: NowPlayingLayout; label: string; icon: IconName }> = [
  { id: 'full', label: 'Now Playing', icon: 'nowplaying' },
  { id: 'lyrics', label: 'Lyrics Mode', icon: 'sparkles' },
  { id: 'art', label: 'Visualizer', icon: 'bars' },
];

/**
 * The full-screen player. Three layouts:
 *  - Now Playing: cover, controls and a live spectrum on the left, the lyrics beside them.
 *  - Lyrics Mode: a distinct, immersive layout - big lyrics over a backdrop that MOVES WITH THE BEAT
 *    (particles by default; aurora glow or still in Settings).
 *  - Visualizer: the cover and a large spectrum.
 * The backdrop is the cover art itself, blurred, so every song gets its own colours.
 */
/** How long the closing animation runs before the screen is removed (matches `nx-np-out` in the stylesheet; instant under Reduce motion). */
const EXIT_MS = 260;

export function NowPlayingScreen() {
  const open = useUi((s) => s.nowPlayingOpen);
  const { theme } = useServices();
  const reduceMotion = useStore(theme, (s) => s.reduceMotion);
  // The screen stays mounted while it animates away, so closing glides down instead of vanishing.
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  useEffect(() => {
    if (open || !mounted) return;
    const timer = setTimeout(() => setMounted(false), reduceMotion ? 0 : EXIT_MS);
    return () => clearTimeout(timer);
  }, [open, mounted, reduceMotion]);
  if (!open && !mounted) return null;
  return <NowPlayingLayer closing={!open} />;
}

function NowPlayingLayer({ closing }: { closing: boolean }) {
  const { ui, playback, collections, theme, visuals, audioControls, prefs } = useServices();
  const layout = useUi((s) => s.nowPlayingLayout);
  const root = useRef<HTMLDivElement | null>(null);
  const track = usePlaybackStore((s) => s.session?.current?.track);
  const repeat = usePlaybackStore((s) => s.session?.repeatMode ?? 'off');
  const shuffle = usePlaybackStore((s) => s.session?.shuffle ?? false);
  const canNext = usePlaybackStore((s) => s.session?.canNext ?? false);
  const playing = usePlaybackStore((s) => s.engine.playing);
  const queueOpen = usePlaybackStore((s) => s.queue.open);
  const artwork = useNowPlaying((s) => s.artwork);
  const favorite = useStore(collections, (s) => (track === undefined ? false : s.favoriteIds.has(track.id)));
  const reduceMotion = useStore(theme, (s) => s.reduceMotion);
  const backdrop = usePrefs((s) => s.lyricsBackdrop);
  const visualizer = usePrefs((s) => s.visualizer);
  const beatIntensity = usePrefs((s) => s.beatIntensity);
  const act = playback.getState();

  // Make sure the audio graph exists while a visual is on screen.
  useEffect(() => audioControls.getState().activateEngine(), [audioControls]);

  // The beat pulse: driven by the shared visual bus. The variable is set ONLY on the two elements that use it (the cover and the glow),
  // not on the whole screen: a custom property changed on the root makes the browser re-resolve the style of every lyric line, every frame.
  useEffect(() => {
    const element = root.current;
    if (element === null || reduceMotion || beatIntensity === 'off') return;
    const gain = { off: 0, subtle: 0.5, normal: 1, strong: 1.5 }[beatIntensity];
    const targets = Array.from(element.querySelectorAll<HTMLElement>('.nx-np-cover, .nx-np-pulse'));
    const off = visuals.subscribe((frame) => {
      const value = Math.min(1, frame.levels.pulse * gain).toFixed(3);
      for (const target of targets) target.style.setProperty('--beat', value);
    });
    return () => {
      off();
      for (const target of targets) target.style.setProperty('--beat', '0');
    };
  }, [visuals, reduceMotion, layout, backdrop, beatIntensity]);

  const showLyrics = layout !== 'art';
  const particles = layout === 'lyrics' && backdrop === 'particles';
  const aurora = layout === 'lyrics' && backdrop !== 'plain';

  return (
    <div ref={root} className="nx-np" data-layout={layout} data-closing={closing ? 'true' : undefined} inert={closing || undefined} data-testid="now-playing" role="dialog" aria-modal="true" aria-label="Now Playing">
      <div className="nx-np-bg" aria-hidden="true">
        {artwork.status === 'found' && artwork.dataUrl !== undefined ? (
          <div key={artwork.dataUrl} className="nx-np-art" data-testid="np-backdrop" style={{ backgroundImage: `url("${artwork.dataUrl}")`, animation: 'nx-fade 700ms var(--ease-out)' }} />
        ) : (
          <div className="nx-np-art nx-np-art--fallback" data-testid="np-backdrop" />
        )}
        <div className="nx-np-vignette" />
        {aurora && <div className="nx-np-pulse" />}
        {particles && <ParticleField reduceMotion={reduceMotion} />}
      </div>

      <div className="nx-np-top">
        <button type="button" className="nx-icon-btn" aria-label="Close Now Playing" data-testid="np-close" onClick={() => ui.getState().closeNowPlaying()}>
          <Icon name="chevronDown" size={26} />
        </button>
        <div className="nx-np-modes" role="group" aria-label="View">
          {MODES.map((mode) => (
            <button key={mode.id} type="button" aria-pressed={layout === mode.id} data-testid={`np-mode-${mode.id}`} onClick={() => ui.getState().setNowPlayingLayout(mode.id)}>
              <Icon name={mode.icon} size={16} /> <span>{mode.label}</span>
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {layout !== 'lyrics' && (
            <button type="button" className="nx-icon-btn" aria-label={`Spectrum style: ${visualizer}`} data-testid="np-spectrum-style" onClick={() => prefs.getState().setVisualizer(visualizer === 'bars' ? 'wave' : visualizer === 'wave' ? 'ring' : 'bars')}>
              <Icon name="bars" size={20} />
            </button>
          )}
          <button type="button" className="nx-icon-btn" aria-label="Queue" aria-pressed={queueOpen} onClick={() => { act.setQueueOpen(!queueOpen); ui.getState().closeNowPlaying(); }}>
            <Icon name="queue" size={20} />
          </button>
        </div>
      </div>

      <div className="nx-np-stage">
        <div className="nx-np-left">
          <div className="nx-np-cover" data-testid="np-cover">
            <Artwork size="100%" title={track?.title} seed={track?.album ?? track?.title} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, minWidth: 0 }}>
            <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span className="nx-np-title nx-clamp-2 nx-text" dir="auto" data-testid="np-title">{track?.title ?? 'Nothing playing'}</span>
              <span className="nx-np-artist nx-ellipsis nx-text" dir="auto" data-testid="np-artist">{track?.artist ?? ''}</span>
            </div>
            {track !== undefined && (
              <button type="button" className="nx-icon-btn" aria-label="Edit song info" data-testid="np-edit-info" onClick={() => ui.getState().openModal({ kind: 'edit-info', track })}><Icon name="edit" size={20} /></button>
            )}
            {track !== undefined && (
              <HeartButton size={22} favorite={favorite} label={favorite ? 'Remove from Favorites' : 'Add to Favorites'} testId="np-heart" onToggle={() => void collections.getState().toggleFavorite(track.id)} />
            )}
          </div>
          <SeekBar stacked />
          <div className="nx-np-controls">
            <button type="button" className="nx-icon-btn" aria-label="Shuffle" aria-pressed={shuffle} disabled={track === undefined} onClick={() => void act.setShuffle(!shuffle)}><Icon name="shuffle" size={21} /></button>
            <button type="button" className="nx-icon-btn" aria-label="Previous" disabled={track === undefined} onClick={() => void act.previous()}><Icon name="prev" size={26} /></button>
            <button type="button" className="nx-play nx-play--big" aria-label={playing ? 'Pause' : 'Play'} data-testid="np-play" disabled={track === undefined} onClick={() => act.togglePlay()}><Icon name={playing ? 'pause' : 'play'} size={28} /></button>
            <button type="button" className="nx-icon-btn" aria-label="Next" disabled={track === undefined || !canNext} onClick={() => void act.next()}><Icon name="next" size={26} /></button>
            <button type="button" className="nx-icon-btn" aria-label={`Repeat: ${repeat}`} aria-pressed={repeat !== 'off'} disabled={track === undefined} onClick={() => void act.cycleRepeatMode()}><Icon name={repeat === 'one' ? 'repeatOne' : 'repeat'} size={21} /></button>
          </div>
          {layout !== 'lyrics' && (
            <div className="nx-np-spectrum" data-testid="np-spectrum">
              <Spectrum style={visualizer} bars={layout === 'art' ? 72 : 44} mirror={visualizer === 'bars' && layout === 'art'} />
            </div>
          )}
        </div>
        {showLyrics && <Lyrics />}
      </div>
    </div>
  );
}
