import { HeartButton } from './parts.js';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useStore } from 'zustand';
import type { PlaybackContextDto, TrackDto, TrackSortDto, TrackSortFieldDto } from '@nova/shared';
import { formatDuration } from '../library/format.js';
import { Icon } from '../theme/Icon.js';
import { useActions, type TrackMenuOptions } from './actions.js';
import { Cover } from './Cover.js';
import { useScrollRef } from './scroll.js';
import { useServices } from './services.js';

const ROW_HEIGHT = 62;

export interface TrackListProps {
  readonly tracks: readonly TrackDto[];
  /** What playing a row continues in (the list the row is shown in). */
  readonly context?: PlaybackContextDto;
  /** Sorting UI for the column headers (title / artist / album / duration). */
  readonly sort?: { readonly value: TrackSortDto; readonly onChange: (sort: TrackSortDto) => void };
  /** A playlist's entry ids, parallel to `tracks`: enables "Remove from playlist" and drag-to-reorder. */
  readonly playlist?: { readonly id: string; readonly name: string; readonly entryIds: readonly string[]; readonly onMove: (entryId: string, toIndex: number) => void };
  /** Plays a row when double-clicked / activated. Defaults to `actions.playTrack(id, context)`. */
  readonly onPlayRow?: (track: TrackDto, index: number) => void;
  readonly label: string;
  readonly showHeader?: boolean;
}

const SORTABLE: ReadonlyArray<{ field: TrackSortFieldDto; label: string; className?: string }> = [
  { field: 'title', label: 'Title' },
  { field: 'album', label: 'Album', className: 'nx-col-album' },
  { field: 'duration', label: 'Time' },
];

interface RowProps {
  readonly track: TrackDto;
  readonly index: number;
  readonly count: number;
  readonly selected: boolean;
  readonly current: boolean;
  readonly playing: boolean;
  readonly favorite: boolean;
  readonly draggable: boolean;
  readonly dropEdge: 'before' | 'after' | undefined;
  readonly onClick: (index: number, event: MouseEvent) => void;
  readonly onPlay: (index: number) => void;
  readonly onMenu: (index: number, x: number, y: number) => void;
  readonly onFavorite: (trackId: string) => void;
  readonly onDragStart: (index: number) => void;
  readonly onDragOver: (index: number, event: React.DragEvent) => void;
  readonly onDrop: (index: number) => void;
  readonly onDragEnd: () => void;
}

/** Memoised: a play/pause or a heart re-renders only the rows whose own flags changed. */
const Row = memo(function Row(p: RowProps) {
  const { track } = p;
  return (
    <div
      role="row"
      aria-selected={p.selected}
      aria-rowindex={p.index + 1}
      aria-setsize={p.count}
      data-testid="track-row"
      data-track-id={track.id}
      data-row-index={p.index}
      data-current={p.current ? 'true' : 'false'}
      data-playing={p.playing ? 'true' : 'false'}
      className="nx-row"
      tabIndex={-1}
      draggable={p.draggable}
      style={p.dropEdge === undefined ? undefined : { boxShadow: p.dropEdge === 'before' ? 'inset 0 2px 0 var(--accent-primary)' : 'inset 0 -2px 0 var(--accent-primary)' }}
      onClick={(event) => p.onClick(p.index, event)}
      onContextMenu={(event) => {
        event.preventDefault();
        p.onMenu(p.index, event.clientX, event.clientY);
      }}
      onDragStart={() => p.onDragStart(p.index)}
      onDragOver={(event) => p.onDragOver(p.index, event)}
      onDrop={() => p.onDrop(p.index)}
      onDragEnd={p.onDragEnd}
    >
      <div className="nx-row-index">
        <span>
          {p.current ? (
            <span className="nx-eq-bars" data-paused={p.playing ? 'false' : 'true'} aria-label={p.playing ? 'Playing' : 'Paused'} role="img">
              <i /><i /><i />
            </span>
          ) : (
            p.index + 1
          )}
        </span>
        <button type="button" className="nx-row-play" aria-label={`Play ${track.title}`} data-testid="row-play" onClick={(event) => (event.stopPropagation(), p.onPlay(p.index))}>
          <Icon name="play" size={16} />
        </button>
      </div>
      <div className="nx-row-main">
        <Cover trackId={track.id} seed={track.album ?? track.title} size="sm" label="" className="" />
        <div className="nx-row-text">
          <span className="nx-row-title nx-ellipsis nx-text" dir="auto">{track.title}</span>
          <span className="nx-row-artist nx-ellipsis nx-text" dir="auto">{track.artist}</span>
        </div>
      </div>
      <span className="nx-row-album nx-ellipsis nx-text nx-col-album" dir="auto">{track.album ?? ''}</span>
      <span className="nx-row-time">{formatDuration(track.durationSeconds)}</span>
      <div className="nx-row-actions">
        <HeartButton className="nx-icon-btn--small" size={17} stop favorite={p.favorite} label={p.favorite ? `Remove ${track.title} from Favorites` : `Add ${track.title} to Favorites`} testId="row-heart" onToggle={() => p.onFavorite(track.id)} />
        <button
          type="button"
          className="nx-icon-btn nx-icon-btn--small"
          aria-label={`More actions for ${track.title}`}
          aria-haspopup="menu"
          data-testid="row-more"
          onClick={(event) => {
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            p.onMenu(p.index, rect.left, rect.bottom + 4);
          }}
        >
          <Icon name="more" size={18} />
        </button>
      </div>
    </div>
  );
});

export function TrackList({ tracks, context, sort, playlist, onPlayRow, label, showHeader = true }: TrackListProps) {
  const services = useServices();
  const actions = useActions();
  const scrollRef = useScrollRef();
  const listRef = useRef<HTMLDivElement | null>(null);
  const [margin, setMargin] = useState(0);
  const [selection, setSelection] = useState<ReadonlySet<number>>(new Set());
  const anchor = useRef(0);
  const [drag, setDrag] = useState<{ from: number; over: number | undefined } | undefined>(undefined);

  const currentId = useStore(services.playback, (s) => s.session?.current?.track.id);
  const playing = useStore(services.playback, (s) => s.engine.playing);
  const favoriteIds = useStore(services.collections, (s) => s.favoriteIds);

  useLayoutEffect(() => {
    const measure = (): void => {
      const list = listRef.current;
      const scroller = scrollRef.current;
      if (list === null || scroller === null) return;
      setMargin(Math.round(list.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop));
    };
    measure();
    window.addEventListener('resize', measure);
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    if (scrollRef.current !== null) observer?.observe(scrollRef.current);
    return () => {
      window.removeEventListener('resize', measure);
      observer?.disconnect();
    };
  }, [scrollRef, tracks.length]);

  // eslint-disable-next-line react-hooks/incompatible-library -- the documented single virtualizer call site pattern (see VirtualRows history); rows are memoised
  const virtualizer = useVirtualizer({ count: tracks.length, getScrollElement: () => scrollRef.current, estimateSize: () => ROW_HEIGHT, overscan: 10, scrollMargin: margin });

  useEffect(() => setSelection(new Set()), [tracks]);

  const play = useCallback(
    (index: number) => {
      const track = tracks[index];
      if (track === undefined) return;
      if (onPlayRow !== undefined) onPlayRow(track, index);
      else actions.playTrack(track.id, context);
    },
    [tracks, onPlayRow, actions, context],
  );

  const menuOptions = useCallback(
    (index: number): TrackMenuOptions => ({
      ...(context !== undefined && { context }),
      ...(playlist !== undefined && playlist.entryIds[index] !== undefined && { playlist: { id: playlist.id, name: playlist.name, entryId: playlist.entryIds[index] as string } }),
    }),
    [context, playlist],
  );

  const showMenu = useCallback(
    (index: number, x: number, y: number) => {
      const track = tracks[index];
      if (track === undefined) return;
      const chosen = selection.has(index) && selection.size > 1 ? tracks.flatMap((_, i) => (selection.has(i) ? [i] : [])) : [index];
      if (!selection.has(index)) {
        setSelection(new Set([index]));
        anchor.current = index;
      }
      if (chosen.length === 1) return actions.showMenuAt(x, y, actions.trackMenu(track, menuOptions(index)));
      const picked = chosen.map((i) => tracks[i]).filter((t): t is TrackDto => t !== undefined);
      const ids = picked.map((t) => t.id);
      actions.showMenuAt(x, y, [
        { kind: 'title', label: `${picked.length} songs selected` },
        { kind: 'item', id: 'next', label: 'Play next', icon: 'nextUp', run: () => [...ids].reverse().forEach((id) => actions.playNext(id, `${picked.length} songs`)) },
        { kind: 'item', id: 'queue', label: 'Add to queue', icon: 'addQueue', run: () => ids.forEach((id) => actions.addToQueue(id, `${picked.length} songs`)) },
        { kind: 'item', id: 'fav', label: 'Add to Favorites', icon: 'heart', run: () => ids.filter((id) => !favoriteIds.has(id)).forEach((id) => void services.collections.getState().toggleFavorite(id)) },
        { kind: 'item', id: 'playlist', label: 'Add to playlist…', icon: 'playlist', run: () => actions.askAddToPlaylist(ids) },
        ...(playlist === undefined ? [] : ([{ kind: 'item', id: 'remove', label: 'Remove from this playlist', icon: 'trash', danger: true, run: () => void services.collections.getState().removeEntries(playlist.id, chosen.map((i) => playlist.entryIds[i]).filter((e): e is string => e !== undefined)) }] as const)),
      ]);
    },
    [tracks, selection, actions, menuOptions, favoriteIds, services.collections, playlist],
  );

  const click = useCallback(
    (index: number, event: MouseEvent) => {
      if (event.shiftKey) {
        const [from, to] = [Math.min(anchor.current, index), Math.max(anchor.current, index)];
        setSelection(new Set(Array.from({ length: to - from + 1 }, (_, i) => from + i)));
      } else if (event.ctrlKey || event.metaKey) {
        setSelection((previous) => {
          const next = new Set(previous);
          if (next.has(index)) next.delete(index);
          else next.add(index);
          return next;
        });
        anchor.current = index;
      } else {
        setSelection(new Set([index]));
        anchor.current = index;
        play(index);
      }
    },
    [play],
  );

  const toggleFavorite = useCallback((trackId: string) => void services.collections.getState().toggleFavorite(trackId), [services.collections]);

  const focusRow = (index: number): void => {
    virtualizer.scrollToIndex(index, { align: 'auto' });
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-row-index="${index}"]`)?.focus());
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    const focused = Number((document.activeElement as HTMLElement | null)?.dataset['rowIndex'] ?? (selection.size > 0 ? Math.max(...selection) : -1));
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = Math.min(tracks.length - 1, Math.max(0, focused + (event.key === 'ArrowDown' ? 1 : -1)));
      if (event.shiftKey) {
        const [from, to] = [Math.min(anchor.current, next), Math.max(anchor.current, next)];
        setSelection(new Set(Array.from({ length: to - from + 1 }, (_, i) => from + i)));
      } else {
        setSelection(new Set([next]));
        anchor.current = next;
      }
      focusRow(next);
    } else if (event.key === 'Enter' && focused >= 0) {
      event.preventDefault();
      play(focused);
    } else if ((event.key === 'a' || event.key === 'A') && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      setSelection(new Set(tracks.map((_, i) => i)));
    } else if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      event.preventDefault();
      const element = listRef.current?.querySelector<HTMLElement>(`[data-row-index="${focused}"]`);
      const rect = element?.getBoundingClientRect();
      if (focused >= 0) showMenu(focused, (rect?.left ?? 200) + 60, (rect?.bottom ?? 200) - 8);
    }
  };

  const items = virtualizer.getVirtualItems();
  const reorderable = playlist !== undefined && sort === undefined;
  const ids = useMemo(() => tracks.map((t) => t.id), [tracks]);
  void ids;

  const header = useMemo(() => {
    if (!showHeader) return null;
    return (
      <div className="nx-tracks-head" role="row">
        <span style={{ textAlign: 'center' }}>#</span>
        {SORTABLE.slice(0, 1).map((column) => <SortHead key={column.field} column={column} sort={sort} />)}
        <SortHead column={SORTABLE[1] as (typeof SORTABLE)[number]} sort={sort} />
        <span style={{ textAlign: 'right' }}>
          {sort === undefined ? 'Time' : <SortHead column={SORTABLE[2] as (typeof SORTABLE)[number]} sort={sort} />}
        </span>
        <span />
      </div>
    );
  }, [showHeader, sort]);

  return (
    <div className="nx-tracks" role="grid" aria-label={label} aria-rowcount={tracks.length} data-testid="track-list" onKeyDown={onKeyDown}>
      {header}
      <div ref={listRef} style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {items.map((item) => {
          const track = tracks[item.index];
          if (track === undefined) return null;
          const over = drag?.over;
          const edge = drag !== undefined && over === item.index && drag.from !== item.index ? (drag.from < item.index ? 'after' : 'before') : undefined;
          return (
            <div key={`${track.id}:${item.index}`} style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: item.size, transform: `translateY(${item.start - virtualizer.options.scrollMargin}px)` }}>
              <Row
                track={track}
                index={item.index}
                count={tracks.length}
                selected={selection.has(item.index)}
                current={currentId === track.id}
                playing={currentId === track.id && playing}
                favorite={favoriteIds.has(track.id)}
                draggable={reorderable}
                dropEdge={edge}
                onClick={click}
                onPlay={play}
                onMenu={showMenu}
                onFavorite={toggleFavorite}
                onDragStart={(index) => setDrag({ from: index, over: undefined })}
                onDragOver={(index, event) => {
                  if (!reorderable) return;
                  event.preventDefault();
                  setDrag((d) => (d === undefined || d.over === index ? d : { ...d, over: index }));
                }}
                onDrop={(index) => {
                  if (drag !== undefined && playlist !== undefined && drag.from !== index) {
                    const entryId = playlist.entryIds[drag.from];
                    if (entryId !== undefined) playlist.onMove(entryId, index);
                  }
                  setDrag(undefined);
                }}
                onDragEnd={() => setDrag(undefined)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SortHead({ column, sort }: { column: (typeof SORTABLE)[number]; sort: TrackListProps['sort'] }) {
  if (sort === undefined) return <span className={column.className}>{column.label}</span>;
  const active = sort.value.field === column.field;
  return (
    <span className={column.className}>
      <button
        type="button"
        data-testid={`sort-${column.field}`}
        aria-label={`Sort by ${column.label}`}
        onClick={() => sort.onChange({ field: column.field, direction: active && sort.value.direction === 'asc' ? 'desc' : 'asc' })}
        style={{ color: active ? 'var(--text)' : undefined }}
      >
        {column.label}
        {active && <Icon name={sort.value.direction === 'asc' ? 'chevronUp' : 'chevronDown'} size={13} />}
      </button>
    </span>
  );
}
