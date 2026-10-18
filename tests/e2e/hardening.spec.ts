import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { ElectronApplication, Page } from 'playwright';
import electronBinaryPath from 'electron';
import { test, expect } from '@playwright/test';
import type BetterSqlite3 from 'better-sqlite3';
import { launchApp, mainEntryPath, pickFolders } from './helpers.js';
import { writeWav } from './media-fixtures.js';

// better-sqlite3 is a dependency of the infrastructure package, not of the root (see library-lifecycle.spec.ts).
const infrastructureRequire = createRequire(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../packages/infrastructure/package.json'));
const Database = infrastructureRequire('better-sqlite3') as typeof BetterSqlite3;

/**
 * Phase 8 (hardening): behaviour of the real app that only a real Electron process can show -
 * what survives the user closing the window mid-song, and the window / permission policy of the
 * real BrowserWindow. Same conventions as the earlier specs: real library folder through the UI,
 * waits on observable conditions, no fixed sleeps.
 */

let sandbox: string;
let music: string;
let userData: string;

test.beforeEach(() => {
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nova-e2e-hardening-')));
  music = path.join(sandbox, 'Music');
  userData = path.join(sandbox, 'userData');
});
test.afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const audioTime = (page: Page): Promise<number> =>
  page.evaluate(() => (document.getElementById('nova-audio') as HTMLAudioElement).currentTime);

async function openLibrary(trackCount: number, seconds: number): Promise<{ app: ElectronApplication; window: Page }> {
  for (let i = 1; i <= trackCount; i += 1) writeWav(music, `Test Artist - Track ${i}`, seconds);
  const { app, window } = await launchApp({ userDataDir: userData });
  await pickFolders(app, music);
  await window.getByTestId('home-add-folder').click(); // adds the folder and scans it
  await window.getByTestId('nav-songs').click();
  await expect(window.getByTestId('track-row')).toHaveCount(trackCount);
  return { app, window };
}

async function playUntilPastCheckpoint(window: Page): Promise<number> {
  await window.getByTestId('track-row').filter({ hasText: 'Track 1' }).hover();
  await window.getByRole('button', { name: 'Play Track 1' }).click();
  // The renderer saves at most every 5 s while playing. Quit well inside that interval.
  await expect.poll(() => audioTime(window), { timeout: 20_000 }).toBeGreaterThan(3.5);
  return audioTime(window);
}

async function expectResumesNear(userDataDir: string, closedAt: number): Promise<void> {
  const second = await launchApp({ userDataDir });
  try {
    await expect(second.window.getByTestId('player-title')).toHaveText('Track 1', { timeout: 20_000 });
    await expect.poll(() => audioTime(second.window), { timeout: 15_000 }).toBeGreaterThan(closedAt - 1.5);
    expect(await audioTime(second.window)).toBeLessThanOrEqual(closedAt + 1.5);
  } finally {
    await second.app.close();
  }
}

test.describe('playback position when the app is quit mid-song', () => {
  test('quitting through app.quit() (the tray\'s Quit, the OS) while PLAYING also keeps the position: the renderer\'s last save must reach the database BEFORE it is closed', async () => {
    const { app, window } = await openLibrary(1, 60);
    const closedAt = await playUntilPastCheckpoint(window);
    const exited = app.waitForEvent('close');
    await app.evaluate(({ app: electronApp }) => electronApp.quit());
    await exited;
    await expectResumesNear(userData, closedAt);
  });
});

test.describe('playback position when the window is closed mid-song', () => {
  test('closing the window while a track is PLAYING keeps the position (within about a second), not the last 5-second checkpoint', async () => {
    const { app, window } = await openLibrary(1, 60);
    await window.getByTestId('track-row').filter({ hasText: 'Track 1' }).hover();
  await window.getByRole('button', { name: 'Play Track 1' }).click();
    // The renderer saves at most every 5 s while playing. Close well inside that interval.
    await expect.poll(() => audioTime(window), { timeout: 20_000 }).toBeGreaterThan(3.5);
    const closedAt = await audioTime(window);

    // The user clicks the window's close button (default policy: closing quits) - the real shutdown path.
    const exited = app.waitForEvent('close');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    await exited;

    const second = await launchApp({ userDataDir: userData });
    try {
      await expect(second.window.getByTestId('player-title')).toHaveText('Track 1', { timeout: 20_000 });
      await expect.poll(() => audioTime(second.window), { timeout: 15_000 }).toBeGreaterThan(closedAt - 1.5);
      expect(await audioTime(second.window)).toBeLessThanOrEqual(closedAt + 1.5);
    } finally {
      await second.app.close();
    }
  });
});

/* ------------------------------------------------------------------------------------------------ *
 * A library database holding a row the app cannot read
 * ------------------------------------------------------------------------------------------------ */

test.describe('a damaged library database', () => {
  test('one unreadable stored track no longer blocks the library: the app opens, shows the rest, and the launch scan restores it', async () => {
    const { app, window } = await openLibrary(3, 3);
    await app.close();

    // Damage done behind the app's back: one row's id is no longer a TrackId (36 characters still pass the table's CHECK).
    const dbFile = path.join(userData, 'library', 'nova.db');
    const raw = new Database(dbFile);
    try {
      raw.prepare("UPDATE tracks SET id = 'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz' WHERE source_path LIKE '%Track 2.wav'").run();
    } finally {
      raw.close();
    }
    void window;

    // The REAL launch policy (watch + one reconciliation scan) runs too, so the damaged file is re-read.
    const second = await launchApp({ userDataDir: userData, startupSync: true });
    try {
      let output = '';
      second.app.process().stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
      second.app.process().stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
      await second.window.getByTestId('nav-songs').click();
      await expect(second.window.getByTestId('track-row')).toHaveCount(3, { timeout: 30_000 });
      await expect(second.window.getByTestId('error-banner')).toHaveCount(0);
      await expect(second.window.getByText('Track 2', { exact: true }).first()).toBeVisible();
    } finally {
      await second.app.close();
    }
  });
});

/* ------------------------------------------------------------------------------------------------ *
 * Fatal errors, startup failure and quitting
 * ------------------------------------------------------------------------------------------------ */

/** Stdout and stderr of the main process, collected from the moment it starts. */
function collectOutput(app: ElectronApplication): { text: () => string; exitCode: () => number | null } {
  let output = '';
  const child = app.process(); // taken now: the handle is gone once the app has closed
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  return { text: () => output, exitCode: () => child.exitCode };
}
/** Replaces the blocking native error box with a line in the main process's output. */
async function stubErrorBox(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ dialog }) => {
    (dialog as unknown as { showErrorBox: unknown }).showErrorBox = (title: string, content: string) => console.log(`E2E-ERRORBOX ${title} | ${content.replace(/\n/g, ' ')}`);
  });
}
const libraryFolderIsClosed = (): string[] => fs.readdirSync(path.join(userData, 'library')).sort();

test.describe('fatal errors in the main process end the app in a controlled way', () => {
  for (const [name, trigger, kind] of [
    ['an uncaught exception', "setTimeout(() => { throw new Error('E2E uncaught'); }, 0)", 'uncaught-exception'],
    ['an unhandled promise rejection', "void Promise.reject(new Error('E2E rejected'))", 'unhandled-rejection'],
  ] as const) {
    test(`${name}: the library is closed cleanly, the user is told, and the process exits with code 1 (it does not carry on)`, async () => {
      const { app } = await launchApp({ userDataDir: userData });
      const output = collectOutput(app);
      await stubErrorBox(app);
      const exited = app.waitForEvent('close');
      await app.evaluate((_electron, code) => void new Function(code)(), trigger);
      await exited;

      expect(output.exitCode()).toBe(1);
      expect(output.text()).toContain(`[nova] FATAL (${kind})`);
      expect(output.text()).toContain('E2E-ERRORBOX');
      expect(output.text()).toContain('[nova] library closed cleanly');
      expect(libraryFolderIsClosed()).toEqual(['nova.db']); // closed, so SQLite removed its WAL files

      // Nothing was damaged: the next launch works normally.
      const next = await launchApp({ userDataDir: userData });
      try {
        await expect(next.window.getByTestId('home-add-folder')).toBeVisible();
      } finally {
        await next.app.close();
      }
    });
  }

  test('a failure while STARTING (after the database is open) closes the library before telling the user, and does not leave a half-started app', async () => {
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    env.NOVA_E2E_FAIL_STARTUP = '1';
    // Spawned directly: the app never opens a window or answers a debugger while it waits on the error box.
    const child = spawn(electronBinaryPath as unknown as string, [mainEntryPath, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', `--user-data-dir=${userData}`], { env });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk: Buffer) => (output += chunk.toString()));
    try {
      // The native error box blocks (it is waiting for the user), so the process is still alive here: what matters
      // is the ORDER - the library was closed cleanly BEFORE the dialog, and no window was ever shown.
      await expect.poll(() => output, { timeout: 20_000 }).toContain('[nova] library closed cleanly');
      expect(output).toContain('[nova] FATAL (startup)');
      expect(libraryFolderIsClosed()).toEqual(['nova.db']);
    } finally {
      child.kill('SIGKILL');
    }
  });

  test('several quit requests in a row all wait for the one cleanup, and the app exits normally (code 0) after closing the library once', async () => {
    const { app } = await launchApp({ userDataDir: userData });
    const output = collectOutput(app);
    const exited = app.waitForEvent('close');
    await app.evaluate(({ app: electronApp }) => {
      electronApp.quit();
      electronApp.quit();
      electronApp.quit();
    });
    await exited;
    expect(output.exitCode()).toBe(0);
    expect(output.text().match(/library closed cleanly/g)).toHaveLength(1);
    expect(libraryFolderIsClosed()).toEqual(['nova.db']);
  });
});

/* ------------------------------------------------------------------------------------------------ *
 * The real window's navigation, link, permission and IPC-sender policy
 * ------------------------------------------------------------------------------------------------ */

type NovaWindow = { nova: { invoke: (channel: string, request?: unknown) => Promise<unknown> } };

test.describe('window, link and sender policy of the real BrowserWindow', () => {
  test('window.open: only an ordinary web address reaches the OS browser; file:, javascript: and credentialed addresses are dropped; no second window opens', async () => {
    const { app, window } = await launchApp({ userDataDir: userData });
    await app.evaluate(({ shell }) => {
      const opened: string[] = [];
      (globalThis as unknown as { __opened: string[] }).__opened = opened;
      (shell as unknown as { openExternal: unknown }).openExternal = async (url: string) => void opened.push(url);
    });
    await window.evaluate(() => {
      for (const url of ['https://example.org/docs', 'file:///etc/passwd', 'javascript:alert(1)', 'ms-msdt:/id', 'https://trusted.example@evil.example/', 'http://example.org/'])
        window.open(url);
    });
    await expect
      .poll(() => app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened))
      .toEqual(['https://example.org/docs', 'http://example.org/']);
    expect(app.windows()).toHaveLength(1);
    await app.close();
  });

  test('the window cannot be navigated away from the application page (the preload bridge never meets another page)', async () => {
    const { app, window } = await launchApp({ userDataDir: userData });
    const home = window.url();
    for (const target of ['https://example.org/', 'file:///etc/hostname', 'data:text/html,<p>other</p>']) {
      await window.evaluate((url) => void (window.location.href = url), target).catch(() => undefined);
      // Give a (wrongly) permitted navigation the chance to start before checking.
      await window.waitForTimeout(300);
      expect(window.url()).toBe(home);
      expect(await window.evaluate(() => typeof (window as unknown as NovaWindow).nova.invoke)).toBe('function');
    }
    await app.close();
  });

  test('permission requests from the page are refused', async () => {
    const { app, window } = await launchApp({ userDataDir: userData });
    const outcome = await window.evaluate(
      () =>
        new Promise<{ notification: string; geolocation: number }>((resolve) => {
          void Notification.requestPermission().then((notification) =>
            navigator.geolocation.getCurrentPosition(
              () => resolve({ notification, geolocation: 0 }),
              (error) => resolve({ notification, geolocation: error.code }),
            ),
          );
        }),
    );
    expect(outcome.notification).not.toBe('granted');
    expect(outcome.geolocation).toBe(1); // PERMISSION_DENIED
    await app.close();
  });

  test('an IPC call from a page that is not the application page is refused, even from a window of ours with the preload attached', async () => {
    const { app, window } = await launchApp({ userDataDir: userData });
    const preload = path.join(path.dirname(mainEntryPath), '../preload/index.cjs');
    const stranger = app.waitForEvent('window');
    await app.evaluate(({ BrowserWindow }, preloadPath) => {
      const other = new BrowserWindow({ show: false, webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true } });
      void other.loadURL('data:text/html,<title>not the app</title>');
    }, preload);
    const page = await stranger;
    await page.waitForLoadState('domcontentloaded');
    const results = await page.evaluate(async () => {
      const nova = (window as unknown as NovaWindow).nova;
      const out: Record<string, unknown> = {};
      out.roots = await nova.invoke('library:listRoots');
      out.pick = await nova.invoke('library:addRoot');
      out.ping = await nova.invoke('app:ping', { nonce: 'x' }).catch((error: Error) => `rejected: ${error.message}`);
      return out;
    });
    expect(results.roots).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(results.pick).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(String(results.ping)).toContain('rejected');
    // The real window is still served.
    expect(await window.evaluate(async () => ((await (window as unknown as NovaWindow).nova.invoke('library:listRoots')) as { ok: boolean }).ok)).toBe(true);
    await app.close();
  });

  test('the Phase 0 diagnostic channels validate their requests', async () => {
    const { app, window } = await launchApp({ userDataDir: userData });
    const results = await window.evaluate(async () => {
      const nova = (window as unknown as NovaWindow).nova;
      const attempt = (channel: string, request?: unknown) => nova.invoke(channel, request).then(() => 'ok', (error: Error) => `rejected: ${error.message}`);
      return {
        good: await attempt('app:ping', { nonce: 'hello' }),
        extraKey: await attempt('app:ping', { nonce: 'hello', other: 1 }),
        badNonce: await attempt('app:ping', { nonce: 42 }),
        hugeNonce: await attempt('app:ping', { nonce: 'x'.repeat(100_000) }),
        argsToNoArgChannel: await attempt('diagnostics:checkDatabase', { sneaky: true }),
      };
    });
    expect(results.good).toBe('ok');
    for (const key of ['extraKey', 'badNonce', 'hugeNonce', 'argsToNoArgChannel'] as const) expect(results[key]).toContain('rejected');
    await app.close();
  });
});
