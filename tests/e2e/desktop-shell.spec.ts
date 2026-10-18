import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ElectronApplication, Page } from 'playwright';
import { test, expect } from '@playwright/test';
import electronBinaryPath from 'electron';
import { launchApp, mainEntryPath, pickFolders } from './helpers.js';
import { writeWav } from './media-fixtures.js';

/**
 * Phase 7: the desktop shell in the REAL Electron app (real Tray, real globalShortcut, real
 * BrowserWindow, real <audio>). What a container cannot do is press a physical media key or look at a
 * real Windows notification area, so the split is honest:
 *  - real: the tray is created through Electron's Tray, its REAL context menu items are clicked,
 *    the media keys are registered with Electron's real globalShortcut, windows are really hidden /
 *    shown / closed, the process really exits;
 *  - not real: an OS-level media-key press (the registered key's callback is the same
 *    `dispatch(command)` the tray menu uses, and that function is invoked directly).
 */

const TITLES = ['Alpha', 'Bravo', 'Charlie'] as const;
let sandbox: string;
let music: string;
let userData: string;

test.beforeEach(() => {
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nova-e2e-shell-')));
  music = path.join(sandbox, 'Music');
  userData = path.join(sandbox, 'userData');
  for (const name of TITLES) writeWav(music, `Test Artist - ${name}`, 6);
});
test.afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

/** Close-to-tray is an opt-in (default: closing quits). Tests of the hide-to-tray behaviour switch it on the way a user would have to: in the stored shell state. */
function optInCloseToTray(): void {
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'shell-state.json'), JSON.stringify({ closeToTray: true }));
}

const title = (page: Page) => page.getByTestId('player-title');
const audioPaused = (page: Page): Promise<boolean> => page.evaluate(() => (document.getElementById('nova-audio') as HTMLAudioElement).paused);

async function openLibraryAndPlay(app: ElectronApplication, window: Page): Promise<void> {
  await pickFolders(app, music);
  await window.getByTestId('home-add-folder').click(); // adds the folder and scans it
  await window.getByTestId('nav-songs').click();
  await expect(window.getByTestId('track-row').filter({ hasText: 'Alpha' })).toBeVisible({ timeout: 20_000 });
  await window.getByTestId('track-row').filter({ hasText: 'Alpha' }).hover(); // the play button shows on hover
  await window.getByTestId('track-row').filter({ hasText: 'Alpha' }).getByRole('button', { name: 'Play Alpha' }).click();
  await expect.poll(() => audioPaused(window), { timeout: 15_000 }).toBe(false);
}

const clickTrayItem = (app: ElectronApplication, id: string): Promise<void> =>
  app.evaluate((_electron, itemId) => {
    const shell = (globalThis as unknown as { __novaShell: { tray: { menu(): ReadonlyArray<{ kind: string; id?: string; click?: () => void }> } } }).__novaShell;
    const item = shell.tray.menu().find((entry) => entry.kind === 'item' && entry.id === itemId);
    if (item?.click === undefined) throw new Error(`no tray item ${itemId}`);
    item.click();
  }, id);

const windowFacts = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => ({ id: w.id, visible: w.isVisible(), minimized: w.isMinimized(), destroyed: w.isDestroyed() })));

/**
 * `launchApp` can return before the window's first `ready-to-show` - and `isVisible()` already reports true
 * before it on Linux - so a test that hides/closes the window first waits for the real first show; otherwise
 * the pending first show would (correctly) bring the window back and the test would be racing the app's start-up.
 */
const waitUntilVisible = async (app: ElectronApplication): Promise<void> => {
  await app.evaluate(() => (globalThis as unknown as { __novaWindowReady: Promise<void> }).__novaWindowReady);
  await expect.poll(async () => (await windowFacts(app))[0]?.visible).toBe(true);
};

test.describe('startup', () => {
  test('one window, a real tray with the documented menu, and the three media keys registered', async () => {
    const { app } = await launchApp({ userDataDir: userData });
    expect(await windowFacts(app)).toHaveLength(1);
    const facts = await app.evaluate(({ globalShortcut }) => {
      const shell = (globalThis as unknown as { __novaShell: { tray: { isActive(): boolean; menu(): ReadonlyArray<{ kind: string; id?: string; label?: string }> } } }).__novaShell;
      return {
        trayActive: shell.tray.isActive(),
        menu: shell.tray.menu().map((i) => (i.kind === 'item' ? i.label : '-')),
        keys: ['MediaPlayPause', 'MediaNextTrack', 'MediaPreviousTrack'].map((k) => globalShortcut.isRegistered(k)),
      };
    });
    expect(facts.trayActive).toBe(true);
    expect(facts.menu).toEqual(['Show Nova Player', '-', 'Play / Pause', 'Next', 'Previous', '-', 'Quit Nova Player']);
    expect(facts.keys).toEqual([true, true, true]);
    await app.close();
  });
});

test.describe('tray and media-key commands drive the real player', () => {
  test('Play/Pause, Next and Previous (tray items and the media-key dispatch) use the real playback path', async () => {
    const { app, window } = await launchApp({ userDataDir: userData });
    await openLibraryAndPlay(app, window);
    await expect(title(window)).toHaveText('Alpha');

    await clickTrayItem(app, 'toggle-play');
    await expect.poll(() => audioPaused(window)).toBe(true);
    await clickTrayItem(app, 'toggle-play');
    await expect.poll(() => audioPaused(window)).toBe(false);

    await clickTrayItem(app, 'next');
    await expect(title(window)).toHaveText('Bravo');
    await expect.poll(() => audioPaused(window)).toBe(false);

    // The media keys' callback is `dispatch(command)`; call it as a key press would.
    const delivered = await app.evaluate(() => {
      const shell = (globalThis as unknown as { __novaShell: { dispatch(c: string): boolean } }).__novaShell;
      return [shell.dispatch('next'), shell.dispatch('previous'), shell.dispatch('quit')];
    });
    expect(delivered).toEqual([true, true, false]); // 'quit' is not a shell command and is refused
    await expect(title(window)).toHaveText('Bravo');

    // Previous early in a track goes back (Phase 4 rule, applied in main with the real position).
    await clickTrayItem(app, 'previous');
    await expect(title(window)).toHaveText('Alpha');
    await app.close();
  });

  test('(opt-in close-to-tray) a command with a hidden window still reaches the playing player (playback never stopped)', async () => {
    optInCloseToTray();
    const { app, window } = await launchApp({ userDataDir: userData });
    await waitUntilVisible(app);
    await openLibraryAndPlay(app, window);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close()); // the native close button's path
    await expect.poll(async () => (await windowFacts(app))[0]?.visible).toBe(false);
    expect(await audioPaused(window)).toBe(false); // music keeps playing in the tray
    await clickTrayItem(app, 'toggle-play');
    await expect.poll(() => audioPaused(window)).toBe(true);
    await app.close();
  });
});

test.describe('window lifecycle', () => {
  test('(opt-in close-to-tray) closing hides to the tray; Show restores the SAME window; repeated cycles never add windows', async () => {
    optInCloseToTray();
    const { app, window } = await launchApp({ userDataDir: userData });
    await waitUntilVisible(app);
    const [first] = await windowFacts(app);
    for (let i = 0; i < 3; i += 1) {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
      await expect.poll(async () => (await windowFacts(app))[0]?.visible).toBe(false);
      expect(await windowFacts(app)).toHaveLength(1);
      await clickTrayItem(app, 'show');
      await expect.poll(async () => (await windowFacts(app))[0]?.visible).toBe(true);
      const now = await windowFacts(app);
      expect(now).toHaveLength(1);
      expect(now[0]!.id).toBe(first!.id);
    }
    const keys = await app.evaluate(({ globalShortcut }) => ['MediaPlayPause', 'MediaNextTrack', 'MediaPreviousTrack'].map((k) => globalShortcut.isRegistered(k)));
    expect(keys).toEqual([true, true, true]);
    await expect(window.getByTestId('home-add-folder')).toBeVisible();
    await app.close();
  });

  test('Quit from the tray really exits the process (no lingering background app)', async () => {
    const { app } = await launchApp({ userDataDir: userData });
    const exited = new Promise<number | null>((resolve) => app.process().once('exit', (code) => resolve(code)));
    await clickTrayItem(app, 'quit').catch(() => undefined); // the app may go away mid-call
    expect(await exited).toBe(0);
  });

  test('DEFAULT: closing the window quits the app, exactly as before Phase 7 (the tray does not keep it alive)', async () => {
    const { app } = await launchApp({ userDataDir: userData });
    expect(await app.evaluate(() => (globalThis as unknown as { __novaShell: { tray: { isActive(): boolean } } }).__novaShell.tray.isActive())).toBe(true);
    const exited = new Promise<number | null>((resolve) => app.process().once('exit', (code) => resolve(code)));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close()).catch(() => undefined);
    expect(await exited).toBe(0);
  });

  test('an explicit closeToTray:false, or an invalid value, also quits on close', async () => {
    for (const value of [false, 'yes']) {
      fs.mkdirSync(userData, { recursive: true });
      fs.writeFileSync(path.join(userData, 'shell-state.json'), JSON.stringify({ closeToTray: value }));
      const { app } = await launchApp({ userDataDir: userData });
      const exited = new Promise<number | null>((resolve) => app.process().once('exit', (code) => resolve(code)));
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close()).catch(() => undefined);
      expect(await exited).toBe(0);
    }
  });

  test('a second launch hands over to the running app: no second window, and it exits', async () => {
    const { app } = await launchApp({ userDataDir: userData });
    await waitUntilVisible(app);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.hide());
    await expect.poll(async () => (await windowFacts(app))[0]?.visible).toBe(false);
    const child = spawn(electronBinaryPath as unknown as string, [mainEntryPath, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', `--user-data-dir=${userData}`], { env: { ...process.env, NOVA_STARTUP_SYNC: 'off' }, stdio: 'ignore' });
    // A second instance that does NOT hand over would stay running; never leave it behind.
    const secondExit = await Promise.race([
      new Promise<number | null | 'still-running'>((resolve) => child.once('exit', (code) => resolve(code))),
      new Promise<'still-running'>((resolve) => setTimeout(() => resolve('still-running'), 10_000)),
    ]).finally(() => child.kill('SIGKILL'));
    expect(secondExit).toBe(0);
    await expect.poll(async () => (await windowFacts(app))[0]?.visible).toBe(true); // the running app showed itself
    expect(await windowFacts(app)).toHaveLength(1);
    await app.close();
  });

  test('size and position are remembered across a restart', async () => {
    const first = await launchApp({ userDataDir: userData });
    await first.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setBounds({ x: 40, y: 30, width: 900, height: 640 }));
    await first.app.close();
    const stored = JSON.parse(fs.readFileSync(path.join(userData, 'shell-state.json'), 'utf8')) as { window: { width: number; height: number } };
    expect(stored.window).toMatchObject({ width: 900, height: 640, maximized: false });

    const second = await launchApp({ userDataDir: userData });
    const bounds = await second.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBounds());
    expect(bounds).toMatchObject({ width: 900, height: 640 });
    await second.app.close();
  });

  test('a corrupt state file cannot break startup', async () => {
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(path.join(userData, 'shell-state.json'), '{not json');
    const { app } = await launchApp({ userDataDir: userData });
    expect(await windowFacts(app)).toHaveLength(1);
    await app.close();
  });
});

test.describe('track notifications', () => {
  type NotifierHook = { __novaShell: { notifier: { history(): ReadonlyArray<{ content: { title: string; body: string }; outcome: string }> } } };
  const history = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as NotifierHook).__novaShell.notifier.history());
  const supported = (app: ElectronApplication) => app.evaluate(({ Notification }) => Notification.isSupported());

  test('a started track is announced (real Electron Notification where the OS supports it) once the window is not focused - never twice, never with a path', async () => {
    const { app, window } = await launchApp({ userDataDir: userData });
    await waitUntilVisible(app);
    const isSupported = await supported(app);
    test.info().annotations.push({ type: 'notification-support', description: `Notification.isSupported() = ${String(isSupported)} in this environment` });
    await openLibraryAndPlay(app, window); // Alpha starts (the window may or may not hold focus here)
    const before = (await history(app)).length;
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.hide()); // not focused for certain
    await clickTrayItem(app, 'next'); // Bravo starts through the real playback path
    await expect(title(window)).toHaveText('Bravo');
    if (!isSupported) {
      // Unsupported environment (this Linux/Xvfb sandbox has no notification service): nothing is attempted and nothing throws.
      // The 'shown' path below only runs where Notification.isSupported() is true, e.g. a real desktop.
      expect(await history(app)).toHaveLength(before);
      await app.close();
      return;
    }
    await expect.poll(async () => (await history(app)).length).toBe(before + 1);
    const records = await history(app);
    expect(records.at(-1)).toEqual({ content: { title: 'Bravo', body: 'Test Artist' }, outcome: 'shown' });
    expect(JSON.stringify(records)).not.toMatch(/nova-media|\.wav|Music|nova-e2e/);

    // Hide / show cycles, and a restart of the same track, add nothing.
    await clickTrayItem(app, 'show');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.hide());
    expect((await history(app)).length).toBe(before + 1);

    await clickTrayItem(app, 'next'); // Charlie
    await expect(title(window)).toHaveText('Charlie');
    await expect.poll(async () => (await history(app)).length).toBe(before + 2);
    expect((await history(app)).at(-1)?.content.title).toBe('Charlie');
    await app.close();
  });

  test('launching with a restored session announces nothing (the player starts paused and silent)', async () => {
    const first = await launchApp({ userDataDir: userData });
    await openLibraryAndPlay(first.app, first.window);
    await first.app.close();
    const second = await launchApp({ userDataDir: userData });
    await expect(second.window.getByTestId('app-shell')).toBeVisible();
    expect(await history(second.app)).toEqual([]);
    await second.app.close();
  });
});

test.describe('security surface', () => {
  test('the bridge gained no new function: still invoke + subscribe only, and the renderer cannot name shell commands as channels', async () => {
    const { app, window } = await launchApp({ userDataDir: userData });
    const result = await window.evaluate(async () => {
      const nova = (window as unknown as { nova: Record<string, unknown> & { invoke(c: string, r: unknown): Promise<unknown> } }).nova;
      let threw = false;
      try {
        await nova.invoke('shell:command', { command: 'next' });
      } catch {
        threw = true;
      }
      return { keys: Object.keys(nova).sort(), threw };
    });
    expect(result).toEqual({ keys: ['invoke', 'subscribe'], threw: true });
    await app.close();
  });
});
