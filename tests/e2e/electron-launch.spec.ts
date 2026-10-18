import { test, expect } from '@playwright/test';
import { launchApp } from './helpers.js';

test('launches the packaged Electron app and evaluates code in the main process', async () => {
  const { app, window } = await launchApp();

  // evaluate() runs in the MAIN process (this is the whole point of this
  // smoke test per validation item F - confirming _electron.launch() and
  // .evaluate() actually work against our exact Electron version).
  const isPackaged = await app.evaluate(({ app: electronApp }) => electronApp.isPackaged);
  expect(typeof isPackaged).toBe('boolean');

  const title = await window.title();
  expect(title).toBe('Nova Player');

  await app.close();
});
