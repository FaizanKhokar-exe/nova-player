import { contextBridge, ipcRenderer } from 'electron';
import { createNovaBridge } from './nova-bridge.js';

/**
 * This is the ENTIRE surface the renderer gets: `window.nova.invoke` and
 * `window.nova.subscribe`, both locked to the channel lists in @nova/shared.
 * No ipcRenderer object, no Node globals, no filesystem, no require.
 */
contextBridge.exposeInMainWorld(
  'nova',
  createNovaBridge({
    invoke: (channel, request) => ipcRenderer.invoke(channel, request),
    on: (channel, listener) => {
      ipcRenderer.on(channel, listener);
    },
    removeListener: (channel, listener) => {
      ipcRenderer.removeListener(channel, listener);
    },
  }),
);
