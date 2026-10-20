import { useState, type ReactNode, type MouseEvent } from 'react';
import { Icon, type IconName } from '../theme/Icon.js';

/** Small presentational pieces shared by the views. */

export function Tile({ cover, title, subtitle, onOpen, onPlay, onMenu, playLabel, testId }: { cover: ReactNode; title: string; subtitle?: string | undefined; onOpen: () => void; onPlay?: () => void; onMenu?: (event: MouseEvent) => void; playLabel?: string; testId?: string }) {
  return (
    <div className="nx-tile-wrap">
      <button type="button" className="nx-tile" data-testid={testId ?? 'tile'} onClick={onOpen} onContextMenu={onMenu === undefined ? undefined : (event) => (event.preventDefault(), onMenu(event))}>
        <div className="nx-tile-cover">{cover}</div>
        <div className="nx-tile-text">
          <span className="nx-tile-title nx-ellipsis nx-text" dir="auto">{title}</span>
          {subtitle !== undefined && subtitle !== '' && <span className="nx-tile-sub nx-ellipsis nx-text" dir="auto">{subtitle}</span>}
        </div>
      </button>
      {onPlay !== undefined && (
        <div className="nx-tile-overlay">
          <button type="button" className="nx-tile-play" aria-label={playLabel ?? `Play ${title}`} data-testid="tile-play" onClick={onPlay}>
            <Icon name="play" size={20} />
          </button>
        </div>
      )}
    </div>
  );
}

export function Empty({ icon, title, body, children }: { icon: IconName; title: string; body?: string; children?: ReactNode }) {
  return (
    <div className="nx-empty" data-testid="empty-state">
      <div className="nx-empty-icon"><Icon name={icon} size={34} /></div>
      <h2 className="nx-h2" style={{ color: 'var(--text)' }}>{title}</h2>
      {body !== undefined && <p style={{ margin: 0, maxWidth: 420 }}>{body}</p>}
      {children}
    </div>
  );
}

export function SectionHead({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="nx-section-head">
      <h2 className="nx-h2">{title}</h2>
      {action}
    </div>
  );
}

export function PlayButtons({ onPlay, onShuffle, disabled, label }: { onPlay: () => void; onShuffle: () => void; disabled?: boolean; label: string }) {
  return (
    <>
      <button type="button" className="nx-btn nx-btn--primary" disabled={disabled} data-testid="hero-play" aria-label={`Play ${label}`} onClick={onPlay}>
        <Icon name="play" size={17} /> Play
      </button>
      <button type="button" className="nx-btn" disabled={disabled} data-testid="hero-shuffle" aria-label={`Shuffle ${label}`} onClick={onShuffle}>
        <Icon name="shuffle" size={17} /> Shuffle
      </button>
    </>
  );
}

export function Hero({ cover, kicker, title, subtitle, children, round = false }: { cover: ReactNode; kicker: string; title: string; subtitle?: string; children?: ReactNode; round?: boolean }) {
  return (
    <section className="nx-hero" data-testid="hero">
      <div style={{ width: 'clamp(130px, 18vw, 220px)', flex: 'none', boxShadow: 'var(--shadow-lg)', borderRadius: round ? '50%' : 'var(--r-lg)', overflow: 'hidden' }}>{cover}</div>
      <div className="nx-hero-meta">
        <span className="nx-hero-kicker">{kicker}</span>
        <h1 className="nx-h1 nx-clamp-2 nx-text" dir="auto" data-testid="hero-title">{title}</h1>
        {subtitle !== undefined && <span className="nx-hero-sub nx-text" dir="auto">{subtitle}</span>}
        <div className="nx-hero-actions">{children}</div>
      </div>
    </section>
  );
}

export function Loading({ rows = 8 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading" data-testid="loading" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {Array.from({ length: rows }, (_, i) => <div key={i} className="nx-skeleton nx-row-skel" />)}
    </div>
  );
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="nx-banner" role="alert" data-testid="error-banner">
      <span>{message}</span>
      {onRetry !== undefined && <button type="button" className="nx-btn nx-btn--small" onClick={onRetry}>Try again</button>}
    </div>
  );
}

const BURST = [0, 1, 2, 3, 4, 5, 6, 7];

/**
 * The heart button. Whenever it BECOMES a favourite while on screen (a click, the H key, a menu), the heart pops and a ring of
 * small hearts and sparks bursts out. A row that merely scrolls into view already favourited does not animate.
 */
export function HeartButton({ favorite, label, onToggle, className = '', size = 18, testId, stop = false }: { favorite: boolean; label: string; onToggle: () => void; className?: string; size?: number; testId?: string; stop?: boolean }) {
  const [seen, setSeen] = useState(favorite);
  const [burst, setBurst] = useState(0);
  if (seen !== favorite) {
    setSeen(favorite);
    if (favorite) setBurst((n) => n + 1);
  }
  return (
    <button type="button" className={`nx-icon-btn nx-heart ${className}`} aria-pressed={favorite} aria-label={label} data-testid={testId} data-burst={burst > 0 ? burst : undefined} onClick={(event) => { if (stop) event.stopPropagation(); onToggle(); }}>
      <Icon name="heart" size={size} />
      {burst > 0 && (
        <span key={burst} className="nx-burst" aria-hidden="true" data-testid="heart-burst">
          <i className="nx-burst-ring" />
          {BURST.map((n) => <i key={n} className="nx-burst-dot" style={{ ['--a' as string]: `${n * 45}deg`, ['--d' as string]: n % 2 === 0 ? '26px' : '20px' }} />)}
        </span>
      )}
    </button>
  );
}
