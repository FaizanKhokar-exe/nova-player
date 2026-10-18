import { useState } from 'react';
import type { QueueItemDto } from '@nova/shared';
import { formatDuration, plural } from '../library/format.js';
import { usePlaybackStore } from '../playback/PlaybackStoreProvider.js';
import { Icon } from '../theme/Icon.js';
import { Cover } from './Cover.js';
import { useServices } from './services.js';

/** The play queue as a side drawer: what already played (dimmed), what is playing, what is next. Drag to reorder. */
export function QueueDrawer() {
  const { playback } = useServices();
  const open = usePlaybackStore((s) => s.queue.open);
  const queue = usePlaybackStore((s) => s.queue);
  const session = usePlaybackStore((s) => s.session);
  const playing = usePlaybackStore((s) => s.engine.playing);
  const [dragFrom, setDragFrom] = useState<QueueItemDto | undefined>(undefined);
  const act = playback.getState();

  const queueWindow = queue.window;
  const total = session?.queueLength ?? queueWindow?.total ?? 0;
  const currentIndex = session?.queueIndex;
  const items = queueWindow?.items ?? [];
  const earlier = items.filter((item) => currentIndex !== undefined && item.position < currentIndex);
  const current = items.find((item) => item.position === currentIndex);
  const upcoming = items.filter((item) => currentIndex !== undefined && item.position > currentIndex);
  const hiddenBefore = queueWindow?.offset ?? 0;
  const hiddenAfter = queueWindow === undefined ? 0 : Math.max(0, queueWindow.total - (queueWindow.offset + queueWindow.items.length));

  const row = (item: QueueItemDto, kind: 'earlier' | 'current' | 'upcoming') => (
    <div
      key={`${item.position}-${item.track.id}`}
      className="nx-qrow"
      data-testid={kind === 'current' ? 'queue-current' : 'queue-item'}
      data-position={item.position}
      data-track-id={item.track.id}
      data-kind={kind}
      data-current={kind === 'current' ? 'true' : undefined}
      data-past={kind === 'earlier' ? 'true' : undefined}
      aria-current={kind === 'current' ? 'true' : undefined}
      draggable
      onDragStart={() => setDragFrom(item)}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        const from = dragFrom;
        setDragFrom(undefined);
        if (from !== undefined && from.position !== item.position) void act.moveQueueItem(from.position, from.track.id, item.position);
      }}
      onDragEnd={() => setDragFrom(undefined)}
    >
      <Cover trackId={item.track.id} seed={item.track.album ?? item.track.title} size="sm" label="" className="" />
      <button type="button" data-testid="queue-play" aria-label={`Play ${item.track.title} from the queue`} onClick={() => void act.playQueueItem(item.position, item.track.id)} style={{ all: 'unset', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
        <span className="nx-ellipsis nx-text" dir="auto" style={{ fontWeight: 600, color: kind === 'current' ? 'var(--accent-primary)' : undefined }} data-testid="queue-title">{item.track.title}</span>
        <span className="nx-ellipsis nx-text nx-muted" dir="auto" style={{ fontSize: 12.5 }}>{item.track.artist} · {formatDuration(item.track.durationSeconds)}</span>
      </button>
      <span className="nx-qrow-actions">
        <button type="button" className="nx-icon-btn nx-icon-btn--small" data-testid="queue-up" aria-label={`Move ${item.track.title} up`} disabled={item.position === 0} onClick={() => void act.moveQueueItem(item.position, item.track.id, item.position - 1)}><Icon name="chevronUp" size={16} /></button>
        <button type="button" className="nx-icon-btn nx-icon-btn--small" data-testid="queue-down" aria-label={`Move ${item.track.title} down`} disabled={item.position >= total - 1} onClick={() => void act.moveQueueItem(item.position, item.track.id, item.position + 1)}><Icon name="chevronDown" size={16} /></button>
        <button type="button" className="nx-icon-btn nx-icon-btn--small" data-testid="queue-remove" aria-label={`Remove ${item.track.title} from the queue`} onClick={() => void act.removeFromQueue(item.position, item.track.id)}><Icon name="close" size={16} /></button>
      </span>
    </div>
  );

  let body: React.ReactNode = null;
  if (open) {
    if (queue.status === 'error' && queueWindow === undefined) {
      body = <div className="nx-banner" role="alert"><span>{queue.error ?? 'The queue could not be loaded.'}</span><button type="button" className="nx-btn nx-btn--small" onClick={() => act.retryQueue()}>Try again</button></div>;
    } else if (total === 0) {
      body = <div className="nx-empty" data-testid="queue-empty"><div className="nx-empty-icon"><Icon name="queue" size={30} /></div><span>The queue is empty. Play a song, album or playlist and what comes next shows up here.</span></div>;
    } else if (queueWindow === undefined) {
      body = <div className="nx-faint" data-testid="queue-loading" style={{ padding: 20 }}>Loading the queue…</div>;
    } else {
      body = (
        <>
          {hiddenBefore > 0 && <span className="nx-faint" style={{ padding: '4px 8px', fontSize: 12.5 }} data-testid="queue-earlier-count">{plural(hiddenBefore, 'earlier song')} not shown</span>}
          {earlier.map((item) => row(item, 'earlier'))}
          {current !== undefined && row(current, 'current')}
          <div className="nx-nav-label" style={{ paddingLeft: 8 }}>Up next</div>
          {upcoming.length === 0 ? <span className="nx-faint" data-testid="queue-nothing-next" style={{ padding: '4px 8px' }}>Nothing after this song.</span> : upcoming.map((item) => row(item, 'upcoming'))}
          {hiddenAfter > 0 && (
            <button type="button" className="nx-btn nx-btn--small" style={{ alignSelf: 'center', margin: '10px 0' }} data-testid="queue-more" onClick={() => act.loadMoreQueue()}>Show more ({plural(hiddenAfter, 'song')})</button>
          )}
        </>
      );
    }
  }

  return (
    <aside className="nx-queue" data-open={open ? 'true' : 'false'} aria-label="Queue" aria-hidden={!open} data-testid="queue-panel">
      <div className="nx-queue-head">
        <div>
          <h2 className="nx-h2">Queue</h2>
          <span className="nx-muted" style={{ fontSize: 12.5 }}>{plural(total, 'song')}{current === undefined ? '' : playing ? ' · playing' : ' · paused'}</span>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          <button type="button" className="nx-btn nx-btn--small nx-btn--ghost" data-testid="queue-clear" disabled={total <= 1} onClick={() => void act.clearQueue()}>Clear</button>
          <button type="button" className="nx-icon-btn" aria-label="Close queue" data-testid="queue-close" onClick={() => act.setQueueOpen(false)}><Icon name="close" size={20} /></button>
        </div>
      </div>
      <div className="nx-queue-list">{body}</div>
    </aside>
  );
}
