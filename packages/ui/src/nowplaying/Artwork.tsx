import { useState } from 'react';
import { GeneratedCover } from '../theme/GeneratedCover.js';
import { useNowPlaying } from './NowPlayingStoreProvider.js';

/**
 * The current track's cover. Shows the artwork main returned for THIS track; while it loads, or when
 * the track has none, or if the image fails to decode, a deterministic generated cover is shown instead
 * (seeded by the title, so a track always gets the same picture). The `<img>` is keyed by the image
 * itself, so a new track can never keep the previous cover. `size` is a px number or any CSS length.
 */
export function Artwork({ size, title, seed, round = false }: { size: number | string; title: string | undefined; seed?: string | undefined; round?: boolean }) {
  const status = useNowPlaying((s) => s.artwork.status);
  const dataUrl = useNowPlaying((s) => s.artwork.dataUrl);
  const [failedUrl, setFailedUrl] = useState<string | undefined>(undefined);

  const showImage = status === 'found' && dataUrl !== undefined && dataUrl !== failedUrl;
  const px = typeof size === 'number' ? size : undefined;
  return (
    <div
      data-testid="artwork"
      data-state={showImage ? 'image' : status === 'loading' ? 'loading' : 'fallback'}
      style={{
        width: size,
        height: size,
        aspectRatio: '1',
        flex: px === undefined ? '0 0 auto' : `0 0 ${px}px`,
        borderRadius: round ? '50%' : px === undefined ? 20 : Math.max(8, Math.round(px / 8)),
        overflow: 'hidden',
        background: 'var(--surface-strong)',
        boxShadow: 'var(--shadow-sm)',
      }}
    >
      {showImage ? (
        <img
          key={dataUrl}
          src={dataUrl}
          alt={title === undefined ? 'Album artwork' : `Album artwork for ${title}`}
          data-testid="artwork-image"
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          onError={() => setFailedUrl(dataUrl)}
        />
      ) : (
        <span aria-hidden="true" data-testid="artwork-fallback" style={{ display: 'block', width: '100%', height: '100%' }}>
          <GeneratedCover seed={seed ?? title ?? 'nova'} rounded={0} />
        </span>
      )}
    </div>
  );
}
