import { describe, expect, it, vi } from 'vitest';
import type { NovaBridge } from '@nova/shared';
import { createUpdateStore } from './update-store.js';

const bridgeReturning = (value: unknown): NovaBridge => ({ invoke: vi.fn(async () => value), subscribe: vi.fn(() => () => undefined) }) as unknown as NovaBridge;

describe('update store', () => {
  it('keeps the status the main process reports', async () => {
    const store = createUpdateStore(bridgeReturning({ ok: true, value: { state: 'none', currentVersion: '1.0.0' } }));
    await store.getState().check();
    expect(store.getState().status.state).toBe('none');
  });
  it('announces an available version once, quietly', async () => {
    const store = createUpdateStore(bridgeReturning({ ok: true, value: { state: 'available', currentVersion: '1.0.0', version: '1.1.0' } }));
    await store.getState().checkQuietly();
    expect(store.getState().announced).toBe('1.1.0');
  });
  it('survives a failing bridge', async () => {
    const bridge = { invoke: vi.fn(async () => { throw new Error('x'); }) } as unknown as NovaBridge;
    const store = createUpdateStore(bridge);
    await store.getState().check();
    expect(store.getState().status.state).toBe('unsupported');
  });
});
