import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PlaybackStoreProvider } from './PlaybackStoreProvider.js';
import type { PlaybackStoreApi } from './playback-store.js';

function fakeStore() {
  const disconnect = vi.fn();
  const flushPosition = vi.fn();
  const connect = vi.fn(() => disconnect);
  return { store: { getState: () => ({ connect, flushPosition }) } as unknown as PlaybackStoreApi, connect, disconnect, flushPosition };
}

describe('PlaybackStoreProvider page lifecycle', () => {
  it('saves the position when the page is hidden for good (pagehide), and only while mounted', () => {
    const { store, flushPosition, disconnect, connect } = fakeStore();
    const view = render(<PlaybackStoreProvider store={store}>x</PlaybackStoreProvider>);
    expect(connect).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event('pagehide'));
    expect(flushPosition).toHaveBeenCalledTimes(1);

    view.unmount();
    expect(disconnect).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event('pagehide'));
    expect(flushPosition).toHaveBeenCalledTimes(1); // the listener was removed with the component
  });
});
