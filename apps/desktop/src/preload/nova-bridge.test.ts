import { IPC_EVENT_CHANNELS, IPC_INVOKE_CHANNELS } from '@nova/shared';
import { describe, expect, it, vi } from 'vitest';
import { createNovaBridge, type IpcRendererLike } from './nova-bridge.js';

function fakeIpc() {
  const listeners = new Map<string, Set<(event: unknown, payload: unknown) => void>>();
  const ipc: IpcRendererLike & { invoke: ReturnType<typeof vi.fn> } = {
    invoke: vi.fn((channel: string, request: unknown) => Promise.resolve({ echoed: { channel, request } })),
    on: (channel, listener) => {
      const set = listeners.get(channel) ?? new Set();
      set.add(listener);
      listeners.set(channel, set);
    },
    removeListener: (channel, listener) => void listeners.get(channel)?.delete(listener),
  };
  const emit = (channel: string, payload: unknown): void => {
    // Electron passes an event object carrying `sender` as the first argument.
    for (const l of [...(listeners.get(channel) ?? [])]) l({ sender: 'SECRET-WEBCONTENTS' }, payload);
  };
  return { ipc, emit, count: (channel: string): number => listeners.get(channel)?.size ?? 0 };
}

describe('the exposed bridge is exactly the intended narrow API', () => {
  const { ipc } = fakeIpc();
  const bridge = createNovaBridge(ipc);

  it('has exactly two members: invoke and subscribe', () => {
    expect(Object.keys(bridge).sort()).toEqual(['invoke', 'subscribe']);
    expect(Object.getOwnPropertyNames(bridge).sort()).toEqual(['invoke', 'subscribe']);
    expect(typeof bridge.invoke).toBe('function');
    expect(typeof bridge.subscribe).toBe('function');
  });

  it('does not expose ipcRenderer or any generic send/on/removeListener/require', () => {
    const anyBridge = bridge as unknown as Record<string, unknown>;
    for (const forbidden of ['ipcRenderer', 'send', 'sendSync', 'on', 'once', 'off', 'removeListener', 'removeAllListeners', 'postMessage', 'require', 'process', 'electron']) {
      expect(anyBridge[forbidden], forbidden).toBeUndefined();
    }
  });
});

describe('invoke', () => {
  it('forwards every contract channel to ipc.invoke with the request', async () => {
    const { ipc } = fakeIpc();
    const bridge = createNovaBridge(ipc);
    for (const channel of IPC_INVOKE_CHANNELS) {
      const response = (await bridge.invoke(channel as never, { n: 1 } as never)) as unknown as { echoed: { channel: string; request: unknown } };
      expect(response.echoed).toEqual({ channel, request: { n: 1 } });
    }
    expect(ipc.invoke).toHaveBeenCalledTimes(IPC_INVOKE_CHANNELS.length);
  });

  it.each(['app:evil', 'library:deleteEverything', 'electron:openExternal', '', '__proto__', 'constructor', 'toString'])(
    'refuses the unknown channel %j without touching ipcRenderer',
    async (channel) => {
      const { ipc } = fakeIpc();
      await expect(createNovaBridge(ipc).invoke(channel as never, undefined as never)).rejects.toThrow(/Unknown IPC channel/);
      expect(ipc.invoke).not.toHaveBeenCalled();
    },
  );

  it('the contract channel list has no duplicates and includes the Phase 0 and library channels', () => {
    expect(new Set(IPC_INVOKE_CHANNELS).size).toBe(IPC_INVOKE_CHANNELS.length);
    expect(IPC_INVOKE_CHANNELS).toEqual(expect.arrayContaining(['app:ping', 'diagnostics:checkDatabase', 'diagnostics:getSeekSpikeMediaUrl', 'library:listRoots', 'library:search']));
  });
});

describe('subscribe', () => {
  it('delivers ONLY the payload to the listener, never Electron\'s event object', () => {
    const { ipc, emit } = fakeIpc();
    const received: unknown[][] = [];
    createNovaBridge(ipc).subscribe('library:changed', (...args: unknown[]) => received.push(args));
    emit('library:changed', { reason: 'scan' });
    expect(received).toEqual([[{ reason: 'scan' }]]);
    expect(JSON.stringify(received)).not.toContain('SECRET-WEBCONTENTS');
  });

  it('returns an unsubscribe function that stops delivery (and is safe to call twice)', () => {
    const { ipc, emit, count } = fakeIpc();
    const listener = vi.fn();
    const off = createNovaBridge(ipc).subscribe('library:scanProgress', listener);
    expect(count('library:scanProgress')).toBe(1);
    emit('library:scanProgress', { a: 1 });
    off();
    off();
    emit('library:scanProgress', { a: 2 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(count('library:scanProgress')).toBe(0);
  });

  it('several subscribers are independent', () => {
    const { ipc, emit } = fakeIpc();
    const bridge = createNovaBridge(ipc);
    const a = vi.fn();
    const b = vi.fn();
    const offA = bridge.subscribe('library:changed', a);
    bridge.subscribe('library:changed', b);
    offA();
    emit('library:changed', { reason: 'watcher' });
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it.each(['library:scanProgress:evil', 'app:ping', 'library:listRoots', '', 'electron-event'])('refuses the non-event channel %j', (channel) => {
    const { ipc, count } = fakeIpc();
    expect(() => createNovaBridge(ipc).subscribe(channel as never, vi.fn())).toThrow(/Unknown IPC event/);
    expect(count(channel)).toBe(0);
  });

  it('rejects a non-function listener', () => {
    const { ipc } = fakeIpc();
    expect(() => createNovaBridge(ipc).subscribe('library:changed', 'nope' as never)).toThrow(TypeError);
  });

  it('every event channel can be subscribed', () => {
    const { ipc, count } = fakeIpc();
    const bridge = createNovaBridge(ipc);
    for (const channel of IPC_EVENT_CHANNELS) bridge.subscribe(channel, vi.fn());
    for (const channel of IPC_EVENT_CHANNELS) expect(count(channel)).toBe(1);
    expect(new Set(IPC_EVENT_CHANNELS).size).toBe(IPC_EVENT_CHANNELS.length);
  });
});
