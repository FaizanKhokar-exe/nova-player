import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { QueueItemDto } from '@nova/shared';
import { track } from '../library/test-support.js';
import type { ThumbnailCache, ThumbnailState } from '../media/thumbnail-cache.js';
import { PlaybackStoreProvider } from '../playback/PlaybackStoreProvider.js';
import type { PlaybackStoreApi } from '../playback/playback-store.js';
import { Cover } from './Cover.js';
import { Hud } from './Hud.js';
import { createPrefsStore } from '../prefs/prefs-store.js';
import { QueueDrawer } from './QueueDrawer.js';
import { ServicesProvider, type AppServices } from './services.js';
import { singDurationMs } from './Lyrics.js';

afterEach(cleanup);

/** Components against stand-in services: nothing here talks to a bridge or an audio element. */

function thumbnails(answer: ThumbnailState | undefined): ThumbnailCache & { want: ReturnType<typeof vi.fn> } {
  const want = vi.fn((_id: string, _size: string, onResult: (state: ThumbnailState) => void) => {
    if (answer !== undefined) onResult(answer);
    return () => undefined;
  });
  return { peek: () => undefined, want, clear: () => undefined, revision: () => 0, subscribe: () => () => undefined } as ThumbnailCache & { want: ReturnType<typeof vi.fn> };
}

const withServices = (services: Partial<AppServices>, ui: React.ReactNode) => <ServicesProvider services={services as AppServices}>{ui}</ServicesProvider>;

describe('Cover', () => {
  it('shows the picture when there is one', () => {
    render(withServices({ thumbnails: thumbnails({ status: 'found', url: 'data:image/jpeg;base64,AAAA' }) }, <Cover trackId="t1" seed="Album" />));
    expect(screen.getByTestId('cover')).toHaveAttribute('data-state', 'image');
    expect(document.querySelector('img')).toHaveAttribute('src', 'data:image/jpeg;base64,AAAA');
  });

  it('shows a generated cover - never an empty box - when the song has no artwork', () => {
    render(withServices({ thumbnails: thumbnails({ status: 'none' }) }, <Cover trackId="t1" seed="Album" />));
    expect(screen.getByTestId('cover')).toHaveAttribute('data-state', 'fallback');
    expect(screen.getByTestId('cover').querySelector('svg')).not.toBeNull();
  });

  it('falls back to the generated cover when the picture fails to decode', () => {
    render(withServices({ thumbnails: thumbnails({ status: 'found', url: 'data:image/jpeg;base64,BAD' }) }, <Cover trackId="t1" seed="Album" />));
    fireEvent.error(document.querySelector('img') as HTMLImageElement);
    expect(screen.getByTestId('cover')).toHaveAttribute('data-state', 'fallback');
  });

  it('asks for nothing when there is no track (a placeholder album)', () => {
    const cache = thumbnails(undefined);
    render(withServices({ thumbnails: cache }, <Cover trackId={undefined} seed="Album" />));
    expect(cache.want).not.toHaveBeenCalled();
    expect(screen.getByTestId('cover')).toHaveAttribute('data-state', 'fallback');
  });
});

describe('QueueDrawer', () => {
  const item = (position: number, name: string): QueueItemDto => ({ position, track: track(position + 1, { title: name }) });
  function setup(open = true) {
    const actions = { playQueueItem: vi.fn(), removeFromQueue: vi.fn(), moveQueueItem: vi.fn(), clearQueue: vi.fn(), setQueueOpen: vi.fn(), loadMoreQueue: vi.fn(), retryQueue: vi.fn(), connect: () => () => undefined, flushPosition: () => undefined };
    const store = createStore(() => ({
      ...actions,
      session: { queueIndex: 1, queueLength: 4 },
      engine: { playing: true },
      queue: { open, status: 'ready', error: undefined, upcomingLimit: 200, window: { offset: 0, total: 4, items: [item(0, 'Alpha'), item(1, 'Bravo'), item(2, 'Charlie'), item(3, 'Delta')] } },
    })) as unknown as PlaybackStoreApi;
    render(withServices({ playback: store, thumbnails: thumbnails({ status: 'none' }) }, <PlaybackStoreProvider store={store}><QueueDrawer /></PlaybackStoreProvider>));
    return actions;
  }

  it('lists what played, what plays now and what is next, in order', () => {
    setup();
    expect(screen.getAllByTestId('queue-title').map((e) => e.textContent)).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta']);
    expect(screen.getByTestId('queue-current')).toHaveTextContent('Bravo');
    expect(screen.getByTestId('queue-panel')).toHaveAttribute('data-open', 'true');
  });

  it('plays, moves, removes and clears through the store (it never edits the queue itself)', () => {
    const actions = setup();
    fireEvent.click(screen.getAllByTestId('queue-play')[3] as HTMLElement);
    expect(actions.playQueueItem).toHaveBeenCalledWith(3, expect.any(String));
    fireEvent.click(screen.getAllByTestId('queue-down')[2] as HTMLElement);
    expect(actions.moveQueueItem).toHaveBeenCalledWith(2, expect.any(String), 3);
    fireEvent.click(screen.getAllByTestId('queue-remove')[2] as HTMLElement);
    expect(actions.removeFromQueue).toHaveBeenCalledWith(2, expect.any(String));
    act(() => fireEvent.click(screen.getByTestId('queue-clear')));
    expect(actions.clearQueue).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('queue-close'));
    expect(actions.setQueueOpen).toHaveBeenCalledWith(false);
  });

  it('is closed and hidden from assistive tech when not open', () => {
    setup(false);
    expect(screen.getByTestId('queue-panel')).toHaveAttribute('data-open', 'false');
    expect(screen.getByTestId('queue-panel')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryAllByTestId('queue-title')).toHaveLength(0);
  });
});

describe('singDurationMs (the left-to-right fill of the line being sung)', () => {
  it('follows the length of the line, never longer than the gap to the next line, never instant', () => {
    expect(singDurationMs('Hello', 10_000)).toBe(900); // short lines still take a moment
    expect(singDurationMs('a'.repeat(40), 10_000)).toBe(3400); // 85 ms per character
    expect(singDurationMs('a'.repeat(40), 2000)).toBe(1880); // capped by the gap (94 %)
    expect(singDurationMs('x', 100)).toBe(400); // and never below 400 ms
  });
});


describe('Hud', () => {
  it('shows the volume with the right number, and a speaker whose waves follow the level', () => {
    const store = createStore(() => ({ engine: { volume: 0.5, muted: false, playing: false, loaded: false }, session: undefined })) as unknown as PlaybackStoreApi;
    render(withServices({ playback: store, prefs: createPrefsStore({ getItem: () => null, setItem: () => undefined }) }, <Hud />));
    expect(screen.queryByTestId('hud-volume')).toBeNull();
    act(() => store.setState({ engine: { volume: 0.8, muted: false, playing: false, loaded: false } } as never));
    expect(screen.getByTestId('hud-volume')).toHaveTextContent('80');
    expect(screen.getByTestId('hud-volume').querySelectorAll('[data-on="true"]')).toHaveLength(3);
    act(() => store.setState({ engine: { volume: 0.2, muted: false, playing: false, loaded: false } } as never));
    expect(screen.getByTestId('hud-volume')).toHaveAttribute('data-dir', 'down');
    expect(screen.getByTestId('hud-volume').querySelectorAll('[data-on="true"]')).toHaveLength(1);
    act(() => store.setState({ engine: { volume: 0.2, muted: true, playing: false, loaded: false } } as never));
    expect(screen.getByTestId('hud-volume')).toHaveTextContent('Muted');
  });
  it('confirms play / pause and shuffle', () => {
    const store = createStore(() => ({ engine: { volume: 1, muted: false, playing: true, loaded: true }, session: { shuffle: false, repeatMode: 'off' } })) as unknown as PlaybackStoreApi;
    render(withServices({ playback: store, prefs: createPrefsStore({ getItem: () => null, setItem: () => undefined }) }, <Hud />));
    act(() => store.setState({ engine: { volume: 1, muted: false, playing: false, loaded: true } } as never));
    expect(screen.getByTestId('hud-action')).toHaveTextContent('Pause');
    act(() => store.setState({ session: { shuffle: true, repeatMode: 'off' } } as never));
    expect(screen.getByTestId('hud-action')).toHaveTextContent('Shuffle on');
    act(() => store.setState({ session: { shuffle: true, repeatMode: 'one' } } as never));
    expect(screen.getByTestId('hud-action')).toHaveTextContent('Repeat this song');
  });
});
