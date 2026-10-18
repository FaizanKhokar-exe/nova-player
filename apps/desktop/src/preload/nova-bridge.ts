import {
  IPC_EVENT_CHANNELS,
  IPC_INVOKE_CHANNELS,
  type IpcChannel,
  type IpcEventChannel,
  type IpcEventPayload,
  type IpcRequest,
  type IpcResponse,
  type NovaBridge,
} from '@nova/shared';

/** The slice of Electron's `ipcRenderer` the bridge uses. Injected so the
 *  bridge can be tested without Electron, and so the real `ipcRenderer` object
 *  itself is never reachable from the bridge's return value. */
export interface IpcRendererLike {
  invoke(channel: string, request: unknown): Promise<unknown>;
  on(channel: string, listener: (event: unknown, payload: unknown) => void): void;
  removeListener(channel: string, listener: (event: unknown, payload: unknown) => void): void;
}

const invokeChannels: ReadonlySet<string> = new Set(IPC_INVOKE_CHANNELS);
const eventChannels: ReadonlySet<string> = new Set(IPC_EVENT_CHANNELS);

/**
 * Builds the object exposed as `window.nova`. It is exactly two functions,
 * both locked to the channels declared in `@nova/shared` - an unknown channel
 * name is refused here, before anything reaches `ipcRenderer` - and the
 * listener a renderer passes to `subscribe` is only ever called with the
 * payload, never with Electron's event object (which carries `sender`).
 */
export function createNovaBridge(ipc: IpcRendererLike): NovaBridge {
  return {
    invoke<K extends IpcChannel>(channel: K, request: IpcRequest<K>): Promise<IpcResponse<K>> {
      if (!invokeChannels.has(channel)) return Promise.reject(new Error(`Unknown IPC channel: ${String(channel)}`));
      return ipc.invoke(channel, request) as Promise<IpcResponse<K>>;
    },

    subscribe<E extends IpcEventChannel>(event: E, listener: (payload: IpcEventPayload<E>) => void): () => void {
      if (!eventChannels.has(event)) throw new Error(`Unknown IPC event: ${String(event)}`);
      if (typeof listener !== 'function') throw new TypeError('listener must be a function');
      const wrapped = (_event: unknown, payload: unknown): void => listener(payload as IpcEventPayload<E>);
      ipc.on(event, wrapped);
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        ipc.removeListener(event, wrapped);
      };
    },
  };
}
