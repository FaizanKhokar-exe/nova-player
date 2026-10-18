import { test, expect } from '@playwright/test';
import { launchApp } from './helpers.js';

test('renderer -> preload -> main -> preload -> renderer IPC round trip works', async () => {
  const { app, window } = await launchApp();

  const response = await window.evaluate(async () => {
    // window.nova is the ENTIRE preload surface - see preload/index.ts.
    // If contextIsolation/contextBridge were misconfigured, this would be
    // undefined here.
    return window.nova.invoke('app:ping', { nonce: 'e2e-test-nonce' });
  });

  expect(response.nonce).toBe('e2e-test-nonce');
  expect(response.pong).toBe(true);
  expect(typeof response.receivedAtMs).toBe('number');

  // Also confirm no raw Node/ipcRenderer leaked into the renderer.
  const leakedGlobals = await window.evaluate(() => ({
    hasRequire: typeof (window as unknown as { require?: unknown }).require !== 'undefined',
    hasIpcRenderer: typeof (window as unknown as { ipcRenderer?: unknown }).ipcRenderer !== 'undefined',
    hasProcess: typeof (window as unknown as { process?: unknown }).process !== 'undefined',
  }));
  expect(leakedGlobals.hasRequire).toBe(false);
  expect(leakedGlobals.hasIpcRenderer).toBe(false);
  expect(leakedGlobals.hasProcess).toBe(false);

  await app.close();
});
