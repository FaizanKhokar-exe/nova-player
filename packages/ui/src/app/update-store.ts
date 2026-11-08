import { createStore, type StoreApi } from 'zustand/vanilla';
import type { IpcResult, NovaBridge, UpdateStatusDto } from '@nova/shared';

export interface UpdateState {
  readonly status: UpdateStatusDto;
  /** Set once when the startup check finds a version, so the toast shows a single time. */
  readonly announced: string | undefined;
}
export interface UpdateActions {
  refresh(): Promise<void>;
  check(): Promise<void>;
  download(): Promise<void>;
  install(): Promise<void>;
  /** Startup check: silent when nothing is new. */
  checkQuietly(): Promise<void>;
}
export type UpdateStoreApi = StoreApi<UpdateState & UpdateActions>;

const UNKNOWN: UpdateStatusDto = { state: 'unsupported', currentVersion: '' };

export function createUpdateStore(bridge: NovaBridge): UpdateStoreApi {
  return createStore<UpdateState & UpdateActions>((set, get) => {
    const call = async (channel: 'update:getStatus' | 'update:check' | 'update:download' | 'update:install'): Promise<void> => {
      try {
        const result = (await bridge.invoke(channel, undefined)) as IpcResult<UpdateStatusDto>;
        if (result.ok) set({ status: result.value });
      } catch {
        /* a failed call leaves the last known status */
      }
    };
    return {
      status: UNKNOWN,
      announced: undefined,
      refresh: () => call('update:getStatus'),
      check: () => call('update:check'),
      download: () => call('update:download'),
      install: () => call('update:install'),
      checkQuietly: async () => {
        await call('update:check');
        const s = get().status;
        if (s.state === 'available' && s.version !== undefined && get().announced !== s.version) set({ announced: s.version });
      },
    };
  });
}
