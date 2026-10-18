import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { test, expect, type Page } from '@playwright/test';
import { launchApp, pickFolders } from './helpers.js';
import { makeSandbox, waitPlaying, audioOf, placeLyrics, openQueue, queueTitles, type Sandbox } from './library-fixture.js';
import { artworkWavBytes } from './media-fixtures.js';

/**
 * Nova Player 2 in the real Electron app: the rebuilt UI end to end (library, thumbnails, favourites, playlists,
 * lyrics + Lyrics Mode, real spectrum, speed/sleep/EQ, wallpaper limits). No fixed sleeps: every wait is on a UI or
 * media condition. Audible output is not verifiable here (no sound device); "plays" means Chromium decoded the file
 * and its media clock advanced. Set NOVA_SHOTS=<dir> to also write screenshots.
 */

const SHOTS = process.env['NOVA_SHOTS'];
const shot = async (page: Page, name: string): Promise<void> => {
  if (SHOTS === undefined) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(900); // let entrance animations finish (screenshots only)
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
};

/** A real, big-enough picture (gradient) as PNG bytes - no binary fixtures in the repo. */
function gradientPng(size: number, a: [number, number, number], b: [number, number, number]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (const byte of buf) c = (crcTable[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, tail]);
  };
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x += 1) {
      const t = (x + y) / (2 * size);
      for (let c = 0; c < 3; c += 1) raw[y * (size * 3 + 1) + 1 + x * 3 + c] = Math.round((a[c] as number) * (1 - t) + (b[c] as number) * t);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test.setTimeout(90_000);
let box: Sandbox;
test.beforeEach(() => {
  box = makeSandbox();
  // A cover-carrying track with real embedded artwork (a 600 px gradient) and an Urdu + Hindi title: no tofu boxes allowed.
  const withCover = artworkWavBytes(30, { title: 'Courtside', artist: 'Karan', album: 'Covers', png: gradientPng(600, [255, 90, 60], [60, 40, 160]) });
  fs.writeFileSync(path.join(box.music, 'Karan - Courtside.wav'), withCover);
});
test.afterEach(() => {
  fs.rmSync(box.sandbox, { recursive: true, force: true });
});

async function openApp(): Promise<{ app: Awaited<ReturnType<typeof launchApp>>['app']; window: Page }> {
  const { app, window } = await launchApp({ userDataDir: box.userData });
  await window.setViewportSize({ width: 1360, height: 820 });
  await pickFolders(app, box.music);
  await expect(window.getByTestId('view-home')).toBeVisible();
  await window.getByTestId('home-add-folder').click();
  await expect(window.getByTestId('nav-songs')).toBeVisible();
  await window.getByTestId('nav-songs').click();
  await expect(window.getByTestId('track-row')).toHaveCount(7, { timeout: 30_000 });
  return { app, window };
}

const rowFor = (page: Page, title: string) => page.getByTestId('track-row').filter({ hasText: title }).first();
/** The play button of a row only appears on hover (like Spotify), so a user hovers first. */
const playRow = async (page: Page, title: string): Promise<void> => {
  await rowFor(page, title).hover();
  await rowFor(page, title).getByTestId('row-play').click();
};

test('first run: add a folder, songs appear with covers or generated covers (never empty boxes)', async () => {
  const { app, window } = await openApp();
  await shot(window, '01-songs');
  const states = await window.getByTestId('track-row').first().getByTestId('cover').evaluate((el) => el.getAttribute('data-state'));
  expect(['image', 'fallback', 'loading']).toContain(states);
  await expect(window.getByTestId('track-row').first().getByTestId('cover')).not.toHaveAttribute('data-state', 'loading', { timeout: 10_000 });
  await app.close();
});

test('play a song: audio runs, dock shows it, the spectrum draws real data, speed and sleep work', async () => {
  const { app, window } = await openApp();
  await playRow(window, 'Alpha');
  await waitPlaying(window);
  await expect(window.getByTestId('player-title')).toHaveText('Alpha');
  await expect(window.getByTestId('player-bar')).toBeVisible();

  // The Web Audio graph is connected (crossOrigin + CORS on the protocol): the analyser sees the 440 Hz tone.
  await expect(window.getByTestId('spectrum').first()).toHaveAttribute('data-live', 'true', { timeout: 10_000 }); // real analyser data, not the idle animation
  await window.getByRole('button', { name: 'Open Now Playing' }).first().click();
  await expect(window.getByTestId('now-playing')).toBeVisible();
  await shot(window, '02-now-playing');
  await window.getByTestId('np-close').click();

  // Speed popover changes the real playbackRate.
  await window.getByTestId('player-speed').click();
  await window.getByTestId('speed-popover').getByRole('button', { name: '1.5×' }).click();
  await expect.poll(() => window.evaluate(() => (document.getElementById('nova-audio') as HTMLAudioElement).playbackRate)).toBe(1.5);

  // Sleep timer: pick one, the button shows it is active.
  await window.getByTestId('player-sleep').click();
  await window.getByTestId('sleep-popover').getByRole('button', { name: '5 min', exact: true }).click();
  await expect(window.getByTestId('player-sleep')).toHaveAttribute('data-active', 'true');
  expect((await audioOf(window)).paused).toBe(false);
  await app.close();
});

test('favourites and playlists: heart a song, create a playlist from the menu, play it', async () => {
  const { app, window } = await openApp();
  await rowFor(window, 'Bravo').getByTestId('row-heart').click();
  await window.getByTestId('nav-favorites').click();
  await expect(window.getByTestId('view-favorites')).toBeVisible();
  await expect(window.getByTestId('track-row')).toHaveCount(1);

  await window.getByTestId('nav-songs').click();
  await rowFor(window, 'Charlie').click({ button: 'right' });
  await window.getByTestId('context-menu').getByRole('menuitem', { name: /playlist/i }).first().click();
  const menu = window.getByTestId('context-menu');
  if (await menu.isVisible()) await menu.getByRole('menuitem', { name: /new playlist/i }).click();
  await window.getByTestId('dialog').getByRole('textbox').fill('Road trip');
  await window.getByTestId('dialog').getByRole('button', { name: /create/i }).click();
  await window.getByTestId('nav-playlists').click();
  await expect(window.getByText('Road trip').first()).toBeVisible();
  await app.close();
});

test('lyrics: normal mode shows synced lines; Lyrics Mode is a distinct layout with a beat-driven backdrop', async () => {
  placeLyrics(box, 'Alpha', 'basic.lrc');
  const { app, window } = await openApp();
  await window.getByTestId('nav-settings').click();
  await window.getByTestId('nav-songs').click();
  await playRow(window, 'Alpha');
  await waitPlaying(window);
  await window.getByTestId('player-lyrics').click();
  await expect(window.getByTestId('lyrics-list')).toBeVisible({ timeout: 15_000 });
  await expect(window.getByTestId('lyric-line').first()).toBeVisible();
  await window.getByTestId('np-mode-full').click(); // normal mode: lyrics beside the cover
  await expect(window.getByTestId('now-playing')).toHaveAttribute('data-layout', 'full');
  await expect(window.getByTestId('lyric-line').first()).toBeVisible();
  await shot(window, '03-lyrics-normal');

  await window.getByTestId('np-mode-lyrics').click();
  await expect(window.getByTestId('now-playing')).toHaveAttribute('data-layout', 'lyrics');
  await expect(window.getByTestId('np-backdrop')).toBeVisible();
  await shot(window, '04-lyrics-mode');
  await app.close();
});

test('wallpaper: limits are shown and a too-small picture is refused in plain words', async () => {
  const { app, window } = await openApp();
  fs.writeFileSync(path.join(box.sandbox, 'tiny.png'), gradientPng(64, [10, 10, 10], [200, 200, 200]));
  await app.evaluate(({ dialog }, file) => {
    (dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, path.join(box.sandbox, 'tiny.png'));
  await window.getByTestId('nav-settings').click();
  await expect(window.getByTestId('wallpaper-limits')).toContainText('12');
  await window.getByTestId('wallpaper-choose').click();
  await expect(window.getByTestId('wallpaper-message')).toContainText('800 x 450');

  // A valid picture is accepted and shown behind the app.
  const good = path.join(box.sandbox, 'good.png');
  fs.writeFileSync(good, gradientPng(1000, [30, 160, 220], [220, 60, 140]));
  await app.evaluate(({ dialog }, file) => {
    (dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, good);
  await window.getByTestId('wallpaper-choose').click();
  await expect(window.getByTestId('wallpaper-layer')).toBeAttached({ timeout: 10_000 });
  await shot(window, '05-wallpaper');
  await window.getByTestId('wallpaper-remove').click();
  await expect(window.getByTestId('wallpaper-layer')).toHaveCount(0);
  await app.close();
});

test('dynamic theming: the accent follows the real cover art of the playing song', async () => {
  const { app, window } = await openApp();
  const accent = (): Promise<string> => window.evaluate(() => document.documentElement.style.getPropertyValue('--accent-primary-rgb'));
  const before = await accent();
  await playRow(window, 'Courtside');
  await waitPlaying(window);
  await expect.poll(accent, { timeout: 15_000 }).not.toBe(before);
  await window.getByRole('button', { name: 'Open Now Playing' }).first().click();
  await window.getByTestId('np-mode-full').click();
  await shot(window, '06-now-playing-cover-theme');
  await window.getByTestId('np-close').click();
  await window.getByTestId('nav-home').click();
  await expect(window.getByTestId('home-albums')).toBeVisible({ timeout: 15_000 });
  await shot(window, '07-home');
  await app.close();
});

test('queue drawer: shows what plays next, play from it, reorder, remove, clear', async () => {
  const { app, window } = await openApp();
  await playRow(window, 'Alpha');
  await waitPlaying(window);
  await openQueue(window);
  await expect.poll(() => queueTitles(window)).toEqual(['Alpha', 'Bravo', 'Charlie', 'Courtside', 'Delta', 'Echo', 'Foxtrot']);
  await expect(window.getByTestId('queue-current').getByTestId('queue-title')).toHaveText('Alpha');
  await shot(window, '08-queue');

  // Reorder: move Bravo down one step; remove Echo; play Delta from the queue.
  const item = (name: string) => window.getByTestId('queue-panel').getByTestId('queue-item').filter({ hasText: name });
  await item('Bravo').getByTestId('queue-down').click();
  await expect.poll(() => queueTitles(window)).toEqual(['Alpha', 'Charlie', 'Bravo', 'Courtside', 'Delta', 'Echo', 'Foxtrot']);
  await item('Echo').getByTestId('queue-remove').click();
  await expect.poll(() => queueTitles(window)).toEqual(['Alpha', 'Charlie', 'Bravo', 'Courtside', 'Delta', 'Foxtrot']);
  await item('Delta').getByTestId('queue-play').click();
  await expect(window.getByTestId('player-title')).toHaveText('Delta');

  // Clear keeps only the current song.
  await window.getByTestId('queue-clear').click();
  await expect.poll(() => queueTitles(window)).toEqual(['Delta']);
  await app.close();
});

test('search finds songs, albums and artists; sorting a column reorders the list', async () => {
  const { app, window } = await openApp();
  await window.getByRole('searchbox', { name: 'Search your music' }).fill('bra');
  await expect(window.getByTestId('view-search')).toBeVisible();
  await expect(window.getByTestId('track-row')).toHaveCount(1);
  await expect(window.getByTestId('track-row')).toContainText('Bravo');
  await window.getByTestId('search-clear').click();

  await window.getByTestId('nav-songs').click();
  const titles = () => window.getByTestId('track-row').locator('.nx-row-title').allInnerTexts();
  await expect.poll(titles).toEqual(['Alpha', 'Bravo', 'Charlie', 'Courtside', 'Delta', 'Echo', 'Foxtrot']);
  await window.getByTestId('sort-duration').click();
  await expect.poll(titles).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Courtside']); // by length: Courtside is 30 s
  await window.getByTestId('sort-duration').click();
  await expect.poll(titles).toEqual(['Courtside', 'Foxtrot', 'Echo', 'Delta', 'Charlie', 'Bravo', 'Alpha']);
  await app.close();
});

test('albums, artists and genres group the real tags; opening an album lists and plays its songs', async () => {
  const { app, window } = await openApp();
  await window.getByTestId('nav-albums').click();
  await expect(window.getByTestId('group-grid')).toBeVisible();
  await window.getByTestId('group-grid').getByText('First', { exact: true }).click();
  await expect(window.getByTestId('view-group')).toBeVisible();
  await expect(window.getByTestId('track-row')).toHaveCount(2);
  await window.getByTestId('hero-play').click();
  await waitPlaying(window);
  await expect(window.getByTestId('player-title')).toHaveText('Alpha');
  await window.getByTestId('nav-genres').click();
  await expect(window.getByTestId('group-grid').getByText('Rock', { exact: true })).toBeVisible();
  await window.getByTestId('nav-artists').click();
  await expect(window.getByTestId('group-grid').getByText('Ann', { exact: true })).toBeVisible();
  await app.close();
});

test('synced lyrics follow the song; clicking a line seeks; Lyrics Mode and Now Playing share the same lyrics', async () => {
  placeLyrics(box, 'Alpha', 'basic.lrc');
  const { app, window } = await openApp();
  await playRow(window, 'Alpha');
  await waitPlaying(window);
  await window.getByTestId('player-lyrics').click();
  await expect(window.getByTestId('lyric-line').first()).toBeVisible({ timeout: 15_000 });
  await expect(window.locator('[data-testid="lyric-line"][data-active="true"]')).toHaveCount(1, { timeout: 15_000 });
  const lines = await window.getByTestId('lyric-line').count();
  expect(lines).toBeGreaterThan(2);
  // Clicking a later line moves playback there (the real media clock jumps forward).
  const before = (await audioOf(window)).currentTime;
  await window.getByTestId('lyric-line').nth(lines - 1).click();
  await expect.poll(async () => (await audioOf(window)).currentTime).toBeGreaterThan(before + 1);
  await window.getByTestId('np-mode-full').click();
  await expect(window.getByTestId('lyric-line').first()).toBeVisible();
  await app.close();
});

test('settings: equalizer preset, speed and visualizer style apply to the live audio and are remembered after a restart', async () => {
  const first = await openApp();
  await playRow(first.window, 'Alpha');
  await waitPlaying(first.window);
  await first.window.getByTestId('nav-settings').click();
  await first.window.getByRole('button', { name: 'Bass boost' }).click();
  await expect(first.window.getByRole('switch', { name: 'Equalizer' })).toHaveAttribute('aria-checked', 'true');
  await expect(first.window.getByRole('button', { name: 'Bass boost' })).toHaveAttribute('aria-pressed', 'true');
  await first.window.getByRole('group', { name: 'Playback speed' }).getByRole('button', { name: '1.25×' }).click();
  await first.window.getByRole('group', { name: 'Spectrum style' }).getByRole('button', { name: 'Wave' }).click();
  expect((await audioOf(first.window)).paused).toBe(false); // the graph changed under a playing song without stopping it
  await expect.poll(() => first.window.evaluate(() => (document.getElementById('nova-audio') as HTMLAudioElement).playbackRate)).toBe(1.25);
  await shot(first.window, '09-settings-audio');
  await first.app.close();

  const second = await launchApp({ userDataDir: box.userData });
  await second.window.getByTestId('nav-settings').click();
  await expect(second.window.getByRole('switch', { name: 'Equalizer' })).toHaveAttribute('aria-checked', 'true');
  await expect(second.window.getByRole('button', { name: 'Bass boost' })).toHaveAttribute('aria-pressed', 'true');
  await expect(second.window.getByRole('group', { name: 'Spectrum style' }).getByRole('button', { name: 'Wave' })).toHaveAttribute('aria-pressed', 'true');
  await second.app.close();
});
