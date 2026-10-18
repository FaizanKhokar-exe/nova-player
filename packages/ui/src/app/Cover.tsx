import { useEffect, useRef, useState } from 'react';
import type { ThumbnailSizeDto } from '@nova/shared';
import { GeneratedCover } from '../theme/GeneratedCover.js';
import type { ThumbnailState } from '../media/thumbnail-cache.js';
import { useServices } from './services.js';

/**
 * A cover for a track (album / artist / playlist covers are the cover of one of their tracks). The picture is fetched
 * only when the element is about to scroll into view and shared through the thumbnail cache; until it arrives - or when
 * the track has none, or the image fails to decode - a deterministic generated cover fills the space, so a grid never
 * shows empty boxes. `seed` keeps that fallback stable per album / artist.
 */
type CoverProps = { trackId: string | undefined; seed: string; size?: ThumbnailSizeDto; round?: boolean; className?: string; label?: string };

export function Cover(props: CoverProps) {
  // Keyed by what is shown, so a recycled row starts fresh instead of resetting state inside an effect.
  return <CoverInner key={`${props.trackId ?? ''}|${props.size ?? 'sm'}`} {...props} />;
}

function CoverInner({ trackId, seed, size = 'sm', round = false, className, label }: CoverProps) {
  const { thumbnails } = useServices();
  const host = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<ThumbnailState | undefined>(() => (trackId === undefined ? { status: 'none' } : thumbnails.peek(trackId, size)));
  const [broken, setBroken] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (trackId === undefined || thumbnails.peek(trackId, size) !== undefined) return;
    const element = host.current;
    let stop: (() => void) | undefined;
    const start = (): void => {
      stop ??= thumbnails.want(trackId, size, (result) => setState(result));
    };
    if (element === null || typeof IntersectionObserver === 'undefined') {
      start();
      return () => stop?.();
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          start();
          observer.disconnect();
        }
      },
      { rootMargin: '240px' },
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
      stop?.();
    };
  }, [thumbnails, trackId, size]);

  const url = state?.status === 'found' && state.url !== broken ? state.url : undefined;
  return (
    <div ref={host} className={`nx-cover${round ? ' nx-cover--round' : ''}${className === undefined ? '' : ` ${className}`}`} data-testid="cover" data-state={url === undefined ? (state === undefined ? 'loading' : 'fallback') : 'image'}>
      {url === undefined ? <GeneratedCover seed={seed} rounded={0} /> : <img key={url} src={url} alt={label ?? ''} draggable={false} decoding="async" onError={() => setBroken(url)} />}
    </div>
  );
}

/** Up to four covers in a 2x2 mosaic (a playlist's cover); one cover when only one distinct picture exists. */
export function MosaicCover({ trackIds, seed, size = 'sm' }: { trackIds: readonly string[]; seed: string; size?: ThumbnailSizeDto }) {
  const ids = trackIds.slice(0, 4);
  if (ids.length < 4) {
    return <Cover trackId={ids[0]} seed={seed} size={size} />;
  }
  return (
    <div className="nx-cover nx-mosaic" data-testid="mosaic-cover">
      {ids.map((id, index) => (
        <Cover key={`${id}-${index}`} trackId={id} seed={`${seed}${index}`} size="sm" className="nx-mosaic-cell" />
      ))}
    </div>
  );
}
