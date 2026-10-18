import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { launchApp } from './helpers.js';
import { ALL, count, isPaused, makeSandbox, nav, openLibrary, openQueue, playTrack, queueTitles, title, trackTitles, writeTaggedWav, type Sandbox } from './library-fixture.js';

/**
 * Phase 5 launch policy, in the real app with the real policy switched ON (the older specs launch with
 * the `NOVA_STARTUP_SYNC=off` hook): at launch the app watches the registered folders and runs ONE
 * incremental reconciliation scan over the folders that are reachable - in the background, so the UI
 * is usable at once - and never touches the restored queue except to drop tracks that no longer exist.
 */

let box: Sandbox;
test.beforeEach(() => {
  box = makeSandbox();
});
test.afterEach(() => {
  fs.rmSync(box.sandbox, { recursive: true, force: true });
});

const launchWithStartupSync = () => launchApp({ userDataDir: box.userData, startupSync: true });
const scanState = (page: Page) =>
  page.evaluate(async () => {
    const r = await (window as unknown as { nova: { invoke: (c: string) => Promise<{ ok: boolean; value: { active?: unknown; last?: { status: string; roots: { status: string }[] } } }> } }).nova.invoke('library:getScanState');
    return r.ok ? { active: r.value.active !== undefined, last: r.value.last?.status, rootStatuses: r.value.last?.roots.map((x) => x.status) } : undefined;
  });

test.describe('launch policy', () => {
  test('with no library folders it does nothing: no scan, no watcher, and says what to do', async () => {
    const { app, window } = await launchWithStartupSync();
    await expect(window.getByTestId('empty-state')).toContainText('Choose the folder where your music lives');
    expect(await scanState(window)).toMatchObject({ active: false, last: undefined });
    await nav(window, 'settings').click();
    await expect(window.getByTestId('library-settings')).toContainText('No music folders yet');
    await expect(window.getByRole('switch', { name: 'Watch folders for changes' })).toHaveAttribute('aria-checked', 'false');
    await nav(window, 'albums').click();
    await expect(window.getByTestId('empty-state')).toBeVisible();
    await app.close();
  });

  test('after a restart: watching and one reconciliation scan start by themselves; changes made while closed appear; the session is restored untouched', async () => {
    const first = await openLibrary(box);
    await playTrack(first.window, 'Bravo');
    await expect(title(first.window)).toHaveText('Bravo');
    await first.window.getByTestId('player-play').click(); // pause: saves the position
    await expect.poll(() => isPaused(first.window)).toBe(true);
    await first.window.getByTestId('player-repeat').click(); // repeat all
    await expect(first.window.getByRole('button', { name: 'Repeat: all' })).toBeVisible();
    await first.app.close();

    // While the app was closed: two files arrive, one is deleted.
    writeTaggedWav(box.music, 'Hotel', 25, { title: 'Hotel', artist: 'Hal', album: 'Fourth', genre: 'Jazz' });
    writeTaggedWav(box.music, 'India', 25, { title: 'India', artist: 'Ivy', album: 'Fifth', genre: 'Pop' });
    fs.rmSync(path.join(box.music, 'Foxtrot.wav'));

    const { app, window } = await launchWithStartupSync();

    // The UI is usable immediately; nothing was clicked for any of what follows.
    await expect(title(window)).toHaveText('Bravo', { timeout: 20_000 }); // the session came back ...
    await expect(window.getByTestId('player-bar')).toHaveAttribute('data-state', 'paused'); // ... paused, never auto-playing
    await expect(window.getByRole('button', { name: 'Repeat: all' })).toBeVisible();
    await expect(count(window, 'tracks')).toHaveText('7', { timeout: 30_000 }); // 6 - Foxtrot + Hotel + India
    await expect.poll(() => scanState(window), { timeout: 30_000 }).toMatchObject({ active: false, last: 'completed', rootStatuses: ['completed'] });
    await nav(window, 'settings').click();
    await expect(window.getByRole('switch', { name: 'Watch folders for changes' })).toHaveAttribute('aria-checked', 'true');
    await nav(window, 'tracks').click();
    await expect.poll(() => trackTitles(window)).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Hotel', 'India']);
    await expect(count(window, 'albums')).toHaveText('5'); // First, Second, Fourth, Fifth, Unknown (Cy)

    // The restored queue: the deleted track left it; the new tracks did NOT join it; the position is kept.
    await openQueue(window);
    await expect.poll(() => queueTitles(window)).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo']);
    await expect(window.getByTestId('queue-current').getByTestId('queue-title')).toHaveText('Bravo');
    expect(await isPaused(window)).toBe(true);
    await app.close();
  });

  test('a restart with nothing changed rescans cheaply and leaves everything as it was', async () => {
    const first = await openLibrary(box);
    await first.app.close();
    const { app, window } = await launchWithStartupSync();
    await expect.poll(() => scanState(window), { timeout: 30_000 }).toMatchObject({ active: false, last: 'completed' });
    await expect(count(window, 'tracks')).toHaveText('6');
    await nav(window, 'tracks').click();
    await expect.poll(() => trackTitles(window)).toEqual(ALL);
    await app.close();
  });

  test('an unavailable folder is skipped, not failed: its tracks stay, nothing is removed, and it recovers when it returns', async () => {
    const first = await openLibrary(box);
    await first.app.close();
    const away = `${box.music}-away`;
    fs.renameSync(box.music, away); // "unplug the drive"

    const { app, window } = await launchWithStartupSync();
    await expect(count(window, 'tracks')).toHaveText('6'); // the library is still there
    await nav(window, 'tracks').click();
    await expect.poll(() => trackTitles(window)).toEqual(ALL);
    await nav(window, 'settings').click();
    await expect(window.getByTestId('root-row')).toContainText('folder not available');
    // No scan was started, so there is no failed result to show.
    expect(await scanState(window)).toMatchObject({ active: false, last: undefined });
    await nav(window, 'albums').click();
    await expect(window.getByText('First', { exact: true }).first()).toBeVisible(); // browsing works while the drive is away

    // Plugging it back in: a scan sees it again and nothing was lost.
    fs.renameSync(away, box.music);
    await nav(window, 'settings').click();
    await window.getByRole('button', { name: 'Scan all' }).click();
    await expect.poll(() => scanState(window), { timeout: 30_000 }).toMatchObject({ active: false, last: 'completed' });
    await expect(window.getByTestId('root-row')).not.toContainText('folder not available');
    await expect(count(window, 'tracks')).toHaveText('6');
    await app.close();
  });

  test('an interrupted scan is simply finished by the next launch', async () => {
    const first = await openLibrary(box);
    await first.app.close();
    writeTaggedWav(box.music, 'Juliet', 25, { title: 'Juliet', artist: 'Jo', album: 'Sixth', genre: 'Rock' });
    // Start a launch and quit while the startup scan may still be running.
    const interrupted = await launchWithStartupSync();
    await interrupted.app.close();
    const { app, window } = await launchWithStartupSync();
    await expect(count(window, 'tracks')).toHaveText('7', { timeout: 30_000 });
    await expect.poll(() => scanState(window), { timeout: 30_000 }).toMatchObject({ active: false, last: 'completed' });
    await app.close();
  });
});
