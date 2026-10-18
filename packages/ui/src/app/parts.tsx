import type { ReactNode, MouseEvent } from 'react';
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
