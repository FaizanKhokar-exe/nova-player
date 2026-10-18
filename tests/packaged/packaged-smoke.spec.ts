import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { test, expect } from '@playwright/test';
import { FIXTURE, makeSandbox, count, audioOf, waitPlaying, type Sandbox } from '../e2e/library-fixture.js';
import { pickFolders } from '../e2e/helpers.js';

/**
 * Phase 9: the packaged app (app.asar + app.asar.unpacked + extraResources), launched exactly as a
 * user's machine would launch it - no `NOVA_*` test hooks, the real startup sync, and a real
 * library folder added through the UI. It proves what a source-tree E2E run cannot: that the
 * asar contains everything the app needs, that better-sqlite3 loads from app.asar.unpacked, and
 * that the page URL / trusted-sender checks hold inside app.asar.
 *
 * It exercises the LINUX unpacked build (the only one this environment can produce). It says
 * nothing about the Windows NSIS installer - that needs a real Windows machine (see RELEASING.md).
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, '../../apps/desktop');
const executable = process.env.NOVA_PACKAGED_EXECUTABLE ?? path.join(desktopRoot, 'dist-installer/linux-unpacked/@novadesktop');

let box: Sandbox;
test.beforeAll(() => {
  if (!fs.existsSync(executable)) throw new Error(`No packaged app at ${executable}. Run: pnpm --filter @nova/desktop run build:unpack`);
});
test.beforeEach(() => {
  box = makeSandbox();
});
test.afterEach(() => {
  fs.rmSync(box.sandbox, { recursive: true, force: true });
});

async function launchPackaged(): Promise<{ app: ElectronApplication; window: Page }> {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  for (const hook of ['NOVA_STARTUP_SYNC', 'NOVA_E2E_SHELL_HOOKS', 'NOVA_E2E_FAIL_STARTUP']) delete env[hook];
  const app = await electron.launch({
    env,
    executablePath: executable,
    // --no-sandbox/--disable-gpu/--disable-dev-shm-usage only accommodate this headless root container
    // (see tests/e2e/helpers.ts); they do not touch the app's own webPreferences.
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', `--user-data-dir=${box.userData}`],
  });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  return { app, window };
}

test('the packaged app is really packaged, loads from app.asar and finds its shipped resources', async () => {
  const { app, window } = await launchPackaged();
  try {
    const facts = await app.evaluate(({ app: electronApp }) => ({
      isPackaged: electronApp.isPackaged,
      appPath: electronApp.getAppPath(),
      resourcesPath: process.resourcesPath,
      name: electronApp.getName(),
      version: electronApp.getVersion(),
    }));
    expect(facts.isPackaged).toBe(true);
    // The product name decides the user-data folder (%APPDATA%\Nova Player on Windows); without
    // `productName` in package.json Electron would use the scoped npm name "@nova/desktop".
    expect(facts.name).toBe('Nova Player');
    expect(facts.version).toBe((JSON.parse(fs.readFileSync(path.join(desktopRoot, 'package.json'), 'utf8')) as { version: string }).version);
    expect(facts.appPath.endsWith('app.asar')).toBe(true);
    for (const file of ['icon.png', 'tray.png', 'app.asar']) expect(fs.existsSync(path.join(facts.resourcesPath, file)), file).toBe(true);
    expect(fs.existsSync(path.join(facts.resourcesPath, 'app.asar.unpacked/node_modules/better-sqlite3/prebuilds'))).toBe(true);

    await expect(window).toHaveTitle('Nova Player');
    await expect(window.getByTestId('sidebar')).toContainText('Nova Player');
    await expect(window.getByTestId('empty-state')).toContainText('Welcome to Nova Player');
    expect(window.url().includes('app.asar')).toBe(true);
  } finally {
    await app.close();
  }
});

test('the packaged app scans a real folder, plays a track, and keeps the library across a restart', async () => {
  let { app, window } = await launchPackaged();
  try {
    await pickFolders(app, box.music);
    await window.getByTestId('home-add-folder').click(); // adds the folder and scans it
    await expect(count(window, 'tracks')).toHaveText(String(FIXTURE.length), { timeout: 30_000 });
    await window.getByTestId('nav-songs').click();
    const alpha = window.getByTestId('track-row').filter({ hasText: 'Alpha' });
    await alpha.hover();
    await alpha.getByRole('button', { name: 'Play Alpha' }).click();
    await waitPlaying(window);
    expect((await audioOf(window)).src.startsWith('nova-media://track/')).toBe(true);
    await expect(window.getByTestId('player-title')).toHaveText('Alpha');
  } finally {
    await app.close();
  }

  // Second launch: the SQLite database (opened through the unpacked native addon) must hold the library.
  ({ app, window } = await launchPackaged());
  try {
    await expect(count(window, 'tracks')).toHaveText(String(FIXTURE.length), { timeout: 30_000 });
    const db = path.join(box.userData, 'nova-player.db');
    expect(fs.existsSync(db) || fs.readdirSync(box.userData).some((n) => n.endsWith('.db')), 'a database file in the user-data folder').toBe(true);
  } finally {
    await app.close();
  }
});

test('the packaged app contains no test files, source maps, or build-machine paths', () => {
  // Static check of the asar that was just launched. `@electron/asar` is a dependency of electron-builder.
  const asarPath = path.join(path.dirname(executable), 'resources/app.asar');
  const buf = fs.readFileSync(asarPath);
  const headerSize = buf.readUInt32LE(12);
  const header = buf.subarray(16, 16 + headerSize).toString('utf8');
  const names = [...header.matchAll(/"([^"]+\.(?:test\.js|spec\.js|map|env|pem|pfx))"/g)].map((m) => m[1]);
  expect(names).toEqual([]);
  expect(buf.includes(Buffer.from(os.homedir() === '/' ? '/root' : os.homedir()))).toBe(false);
  expect(buf.includes(Buffer.from('/home/claude'))).toBe(false);
});
