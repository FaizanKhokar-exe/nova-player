import { useEffect, useState } from 'react';
import { Icon, type IconName } from '../theme/Icon.js';
import { useServices } from './services.js';

/** What the on-screen display is showing right now. `seq` restarts the CSS animation on every change. */
export type HudState =
  | { readonly kind: 'volume'; readonly seq: number; readonly level: number; readonly muted: boolean; readonly delta: number }
  | { readonly kind: 'action'; readonly seq: number; readonly icon: IconName; readonly label: string; readonly on: boolean };

const SHOW_MS = 1500;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Three arcs: more of them light up as the volume rises, so the speaker itself says how loud it is. */
function Speaker({ level, muted }: { level: number; muted: boolean }) {
  const waves = muted || level === 0 ? 0 : level < 0.34 ? 1 : level < 0.67 ? 2 : 3;
  return (
    <svg className="nx-hud-speaker" width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11 5 6 9H2v6h4l5 4V5z" fill="currentColor" fillOpacity="0.9" />
      {waves === 0 ? <path className="nx-hud-x" d="M16 9.500l5 5m0-5-5 5" /> : null}
      <path className="nx-hud-wave" data-on={waves >= 1} d="M15 9.500a3.500 3.500 0 0 1 0 5" />
      <path className="nx-hud-wave" data-on={waves >= 2} d="M17.500 7a7 7 0 0 1 0 10" />
      <path className="nx-hud-wave" data-on={waves >= 3} d="M20 4.500a10.500 10.500 0 0 1 0 15" />
    </svg>
  );
}

/**
 * The on-screen display: a small glass pill above the player bar that confirms what a key press (or any control) just
 * did - the volume as a live bar with a speaker whose waves follow the level, and play / pause / mute / shuffle / repeat /
 * speed as an icon that pops. It only LISTENS to the stores, so it needs no wiring in the controls, and it stays out of
 * the way: it ignores the volume slider while you are dragging it (the slider already shows the value).
 */
export function Hud() {
  const { playback, prefs } = useServices();
  const [hud, setHud] = useState<HudState | undefined>(undefined);

  useEffect(() => {
    let seq = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const show = (next: DistributiveOmit<HudState, 'seq'>): void => {
      seq += 1;
      setHud({ ...next, seq } as HudState);
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => setHud(undefined), SHOW_MS);
    };
    let last = playback.getState();
    let lastSpeed = prefs.getState().speed;
    const offPlayback = playback.subscribe((state) => {
      const before = last;
      last = state;
      const e = state.engine;
      const b = before.engine;
      const draggingSlider = document.activeElement instanceof HTMLElement && document.activeElement.classList.contains('nx-volume');
      if (e.volume !== b.volume && !draggingSlider) show({ kind: 'volume', level: e.volume, muted: e.muted, delta: e.volume - b.volume });
      else if (e.muted !== b.muted) show({ kind: 'volume', level: e.volume, muted: e.muted, delta: 0 });
      else if (e.playing !== b.playing && e.loaded && b.loaded) show({ kind: 'action', icon: e.playing ? 'play' : 'pause', label: e.playing ? 'Play' : 'Pause', on: e.playing });
      const s = state.session;
      const o = before.session;
      if (s !== undefined && o !== undefined) {
        if (s.shuffle !== o.shuffle) show({ kind: 'action', icon: 'shuffle', label: s.shuffle ? 'Shuffle on' : 'Shuffle off', on: s.shuffle });
        else if (s.repeatMode !== o.repeatMode) show({ kind: 'action', icon: s.repeatMode === 'one' ? 'repeatOne' : 'repeat', label: s.repeatMode === 'off' ? 'Repeat off' : s.repeatMode === 'one' ? 'Repeat this song' : 'Repeat all', on: s.repeatMode !== 'off' });
      }
    });
    const offPrefs = prefs.subscribe((state) => {
      if (state.speed !== lastSpeed) {
        lastSpeed = state.speed;
        show({ kind: 'action', icon: 'speed', label: `Speed ${state.speed}×`, on: state.speed !== 1 });
      }
    });
    return () => {
      offPlayback();
      offPrefs();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [playback, prefs]);

  if (hud === undefined) return <div className="nx-hud-live nx-sr-only" role="status" aria-live="polite" />;
  const percent = hud.kind === 'volume' ? Math.round((hud.muted ? 0 : hud.level) * 100) : 0;
  return (
    <>
      <div className="nx-hud-live nx-sr-only" role="status" aria-live="polite">{hud.kind === 'volume' ? (hud.muted ? 'Muted' : `Volume ${percent}%`) : hud.label}</div>
      {hud.kind === 'volume' ? (
        <div className="nx-hud" data-kind="volume" data-testid="hud-volume" key={hud.seq} data-dir={hud.delta > 0 ? 'up' : hud.delta < 0 ? 'down' : 'none'} style={{ ['--hud-level' as string]: `${percent}%` }} aria-hidden="true">
          <Speaker level={hud.level} muted={hud.muted} />
          <div className="nx-hud-bar"><div className="nx-hud-fill" /><div className="nx-hud-knob" /></div>
          <span className="nx-hud-num">{hud.muted ? 'Muted' : `${percent}`}</span>
        </div>
      ) : (
        <div className="nx-hud" data-kind="action" data-on={hud.on} data-testid="hud-action" key={hud.seq} aria-hidden="true">
          <span className="nx-hud-icon"><Icon name={hud.icon} size={26} /></span>
          <span className="nx-hud-label">{hud.label}</span>
        </div>
      )}
    </>
  );
}
