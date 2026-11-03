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

async function openApp(extraTracks = 0): Promise<{ app: Awaited<ReturnType<typeof launchApp>>['app']; window: Page }> {
  const { app, window } = await launchApp({ userDataDir: box.userData });
  await window.setViewportSize({ width: 1360, height: 820 });
  await pickFolders(app, box.music);
  await expect(window.getByTestId('view-home')).toBeVisible();
  await window.getByTestId('home-add-folder').click();
  await expect(window.getByTestId('nav-songs')).toBeVisible();
  await window.getByTestId('nav-songs').click();
  await expect(window.getByTestId('track-row')).toHaveCount(7 + extraTracks, { timeout: 30_000 });
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

/* ---------------------------------- v0.11.1: first Windows feedback batch ---------------------------------- */

const overlaps = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean =>
  a.x < b.x + b.width - 1 && b.x < a.x + a.width - 1 && a.y < b.y + b.height - 1 && b.y < a.y + a.height - 1;

test('clicking a song row plays it (no need for the small play button); the heart and ⋯ do not', async () => {
  const { app, window } = await openApp();
  await rowFor(window, 'Alpha').locator('.nx-row-title').click();
  await waitPlaying(window);
  await expect(window.getByTestId('player-title')).toHaveText('Alpha');
  await rowFor(window, 'Alpha').hover();
  await rowFor(window, 'Alpha').getByTestId('row-more').click();
  await expect(window.getByRole('menu')).toBeVisible();
  await expect(window.getByTestId('player-title')).toHaveText('Alpha'); // opening ⋯ did not restart or change anything
  await window.keyboard.press('Escape');
  await app.close();
});

test('the player bar is themed from the cover and a click on it opens Now Playing, but its buttons keep their own job', async () => {
  const { app, window } = await openApp();
  await rowFor(window, 'Courtside').locator('.nx-row-title').click();
  await waitPlaying(window);
  await expect(window.getByTestId('player-bar')).toHaveAttribute('data-expandable', 'true');
  await window.getByTestId('player-queue').click(); // a control: must not expand
  await expect(window.getByTestId('now-playing')).toBeHidden();
  await window.keyboard.press('q');
  const bar = await window.getByTestId('player-bar').boundingBox();
  await window.mouse.click((bar?.x ?? 0) + (bar?.width ?? 0) * 0.62, (bar?.y ?? 0) + 6); // empty part of the bar
  await expect(window.getByTestId('now-playing')).toBeVisible();
  await app.close();
});

test('there is no native menu bar (File / Edit / View / Window)', async () => {
  const { app } = await openApp();
  expect(await app.evaluate(({ Menu }) => Menu.getApplicationMenu() === null)).toBe(true);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every((w) => !w.isMenuBarVisible()))).toBe(true);
  await app.close();
});

test('hovering an icon-only control shows its name (and shortcut) in a tooltip', async () => {
  const { app, window } = await openApp();
  await window.getByTestId('player-queue').hover();
  await expect(window.getByTestId('tooltip')).toContainText('Queue', { timeout: 5_000 });
  await expect(window.getByTestId('tooltip')).toContainText('Q');
  await window.mouse.move(300, 300);
  await expect(window.getByTestId('tooltip')).toBeHidden();
  await app.close();
});

test('sidebar: nothing overlaps (footer buttons vs the playlist list) in expanded and collapsed mode, at a short window height too', async () => {
  const { app, window } = await openApp();
  for (const height of [820, 560]) {
    await window.setViewportSize({ width: 1360, height });
    const foot = await window.locator('.nx-side-foot').boundingBox();
    const lists = await window.getByTestId('sidebar-playlists').boundingBox();
    expect(foot).not.toBeNull();
    if (foot !== null && lists !== null) expect(overlaps(foot, lists)).toBe(false);
    await expect(window.getByTestId('add-folder')).toBeVisible();
  }
  await window.getByTestId('sidebar-toggle').click();
  await expect(window.getByTestId('app-shell')).toHaveAttribute('data-collapsed', 'true');
  const sizes = await window.locator('.nx-sidebar .nx-nav-item').evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return `${Math.round(r.width)}x${Math.round(r.height)}`; }));
  expect(new Set(sizes).size).toBe(1); // every collapsed button is the same size
  expect(await window.locator('.nx-sidebar').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await window.getByTestId('nav-songs').hover();
  await expect(window.getByTestId('tooltip')).toContainText('Songs', { timeout: 5_000 });
  await app.close();
});

test('Home: the favourites tiles sit side by side at one size, never on top of each other', async () => {
  const { app, window } = await openApp();
  for (const name of ['Alpha', 'Bravo', 'Courtside']) {
    await rowFor(window, name).hover();
    await rowFor(window, name).getByTestId('row-heart').click();
  }
  await window.getByTestId('nav-home').click();
  const tiles = window.getByTestId('home-favorites').getByTestId('favorite-tile');
  await expect(tiles).toHaveCount(3, { timeout: 10_000 });
  const boxes = await tiles.evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }));
  for (let i = 0; i < boxes.length; i += 1) for (let j = i + 1; j < boxes.length; j += 1) expect(overlaps(boxes[i] as never, boxes[j] as never)).toBe(false);
  expect(new Set(boxes.map((b) => Math.round(b.width))).size).toBe(1);
  expect(new Set(boxes.map((b) => Math.round(b.y))).size).toBe(1);
  // the section below does not start before this one ends
  const recents = await window.getByTestId('home-favorites').boundingBox();
  const shelf = await window.getByTestId('home-favorites').locator('.nx-shelf').boundingBox();
  expect((shelf?.y ?? 0) + (shelf?.height ?? 0)).toBeLessThanOrEqual((recents?.y ?? 0) + (recents?.height ?? 0) + 1);
  await shot(window, '20-home-tiles');
  await app.close();
});

test('keyboard: seek, volume, shuffle, speed and favourite shortcuts', async () => {
  const { app, window } = await openApp();
  await rowFor(window, 'Courtside').locator('.nx-row-title').click();
  await waitPlaying(window);
  const before = (await audioOf(window)).currentTime;
  await window.keyboard.press('Shift+ArrowRight');
  await expect.poll(async () => (await audioOf(window)).currentTime).toBeGreaterThan(before + 10);
  const volume = await window.evaluate(() => (document.getElementById('nova-audio') as HTMLAudioElement).volume);
  await window.getByTestId('nav-settings').focus(); // focus off the song list, where Up/Down walk the rows
  await window.keyboard.press('ArrowDown');
  await expect.poll(() => window.evaluate(() => (document.getElementById('nova-audio') as HTMLAudioElement).volume)).toBeLessThan(volume);
  await window.keyboard.press('s');
  await expect(window.getByTestId('player-shuffle')).toHaveAttribute('aria-pressed', 'true');
  await window.keyboard.press(']');
  await expect.poll(() => window.evaluate(() => (document.getElementById('nova-audio') as HTMLAudioElement).playbackRate)).toBeGreaterThan(1);
  await window.keyboard.press('h');
  await expect(window.getByTestId('player-heart')).toHaveAttribute('aria-pressed', 'true');
  await app.close();
});

test('Now Playing: double-click toggles fullscreen and the pointer hides itself when idle, returning on movement', async () => {
  const { app, window } = await openApp();
  await rowFor(window, 'Alpha').locator('.nx-row-title').click();
  await waitPlaying(window);
  await window.getByRole('button', { name: 'Open Now Playing' }).first().click();
  await expect(window.getByTestId('now-playing')).toBeVisible();
  await window.mouse.move(640, 300);
  await expect.poll(() => window.evaluate(() => document.documentElement.dataset['idle']), { timeout: 8_000 }).toBe('true');
  await window.mouse.move(660, 320);
  await expect.poll(() => window.evaluate(() => document.documentElement.dataset['idle'])).toBe('false');
  await window.mouse.dblclick(660, 320);
  await expect.poll(() => window.evaluate(() => document.fullscreenElement !== null)).toBe(true);
  await window.mouse.dblclick(660, 320);
  await expect.poll(() => window.evaluate(() => document.fullscreenElement !== null)).toBe(false);
  await app.close();
});


/* ---------------------------------- v0.11.2 ---------------------------------- */

test('tiles keep one size even with a very long title', async () => {
  const long = 'An extremely long song title that keeps going and going and would stretch a shrink-wrapped button across the whole row';
  fs.writeFileSync(path.join(box.music, 'Long - Title.wav'), artworkWavBytes(30, { title: long, artist: 'Someone With A Very Long Artist Name Too', album: 'Long', png: gradientPng(900, [30, 160, 90], [250, 240, 80]) }));
  const { app, window } = await openApp(1);
  for (const name of ['Alpha', 'An extremely long', 'Courtside']) {
    await rowFor(window, name).hover();
    await rowFor(window, name).getByTestId('row-heart').click();
  }
  await window.getByTestId('nav-home').click();
  const tiles = window.getByTestId('home-favorites').getByTestId('favorite-tile');
  await expect(tiles).toHaveCount(3, { timeout: 10_000 });
  const widths = await tiles.evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().width)));
  expect(new Set(widths).size).toBe(1);
  expect(widths[0]).toBeLessThanOrEqual(200);
  await app.close();
});

test('the heart bursts when a song becomes a favourite, not when it is removed; text cannot be selected', async () => {
  const { app, window } = await openApp();
  await rowFor(window, 'Alpha').hover();
  const heart = rowFor(window, 'Alpha').getByTestId('row-heart');
  await heart.click();
  await expect(heart.getByTestId('heart-burst')).toBeVisible();
  await expect(heart).toHaveAttribute('aria-pressed', 'true');
  expect(await window.evaluate(() => getComputedStyle(document.body).userSelect)).toBe('none');
  await window.getByTestId('view-songs').dblclick({ position: { x: 5, y: 5 } }).catch(() => undefined);
  expect(await window.evaluate(() => String(window.getSelection()))).toBe('');
  await app.close();
});

test('hovering the seek bar shows a loudness + lyrics preview that goes away with the pointer', async () => {
  placeLyrics(box, 'Karan - Courtside', 'basic.lrc');
  const { app, window } = await openApp();
  await rowFor(window, 'Courtside').locator('.nx-row-title').click();
  await waitPlaying(window);
  const seek = window.getByTestId('player-seek');
  const box1 = await seek.boundingBox();
  await window.mouse.move((box1?.x ?? 0) + (box1?.width ?? 0) * 0.3, (box1?.y ?? 0) + 4);
  await expect(window.getByTestId('seek-preview')).toBeVisible();
  await expect(window.getByTestId('seek-preview-bars')).toHaveAttribute('data-ready', 'true', { timeout: 15_000 });
  await window.mouse.move((box1?.x ?? 0) + (box1?.width ?? 0) * 0.7, (box1?.y ?? 0) + 4);
  await expect(window.getByTestId('seek-preview')).toContainText(':');
  await shot(window, '21-seek-preview');
  await window.mouse.move(300, 200);
  await expect(window.getByTestId('seek-preview')).toBeHidden();
  await app.close();
});

test('the .lrc attach/remove control lives only in the player bar', async () => {
  placeLyrics(box, 'Karan - Courtside', 'basic.lrc');
  const { app, window } = await openApp();
  await rowFor(window, 'Courtside').locator('.nx-row-title').click();
  await waitPlaying(window);
  await expect(window.getByTestId('player-bar').getByTestId('lyrics-attach-other')).toBeVisible({ timeout: 10_000 });
  await window.getByRole('button', { name: 'Open Now Playing' }).first().click();
  await expect(window.getByTestId('now-playing')).toBeVisible();
  await expect(window.getByTestId('now-playing').getByTestId('lyrics-attach-other')).toHaveCount(0);
  await expect(window.getByTestId('now-playing').getByTestId('lyrics-attached-note')).toHaveCount(0);
  await app.close();
});


/* ---------------------------------- v0.11.3 ---------------------------------- */

test('opening an audio file with Nova Player (a launch argument) plays that song - already in the library', async () => {
  const first = await openApp();
  await first.app.close();
  const target = path.join(box.music, 'Charlie.wav');
  const files = fs.readdirSync(box.music);
  const file = files.find((name) => name.toLowerCase().includes('charlie')) ?? files[0] ?? '';
  const second = await launchApp({ userDataDir: box.userData, extraArgs: [path.join(box.music, file)] });
  await expect(second.window.getByTestId('player-title')).toHaveText(/Charlie|Alpha|Bravo|Delta|Echo|Foxtrot|Courtside/, { timeout: 20_000 });
  await waitPlaying(second.window);
  expect(target.length).toBeGreaterThan(0);
  await second.app.close();
});

test('opening a file from a folder that is not in the library adds the folder, scans it and plays the song', async () => {
  const other = path.join(box.sandbox, 'Downloads');
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, 'Zulu Song.wav'), artworkWavBytes(20, { title: 'Zulu Song', artist: 'Zed', album: 'Z' }));
  const { app, window } = await launchApp({ userDataDir: box.userData, extraArgs: [path.join(other, 'Zulu Song.wav')] });
  await expect(window.getByTestId('player-title')).toHaveText('Zulu Song', { timeout: 30_000 });
  await waitPlaying(window);
  await window.getByTestId('nav-songs').click();
  await expect(window.getByTestId('track-row')).toHaveCount(1);
  await app.close();
});

test('a cover picture can be attached from the player bar, shows at once, and can be removed', async () => {
  const picture = path.join(box.sandbox, 'mine.png');
  fs.writeFileSync(picture, gradientPng(300, [20, 200, 120], [250, 250, 40]));
  const { app, window } = await openApp();
  await rowFor(window, 'Alpha').locator('.nx-row-title').click();
  await waitPlaying(window);
  await expect(window.getByTestId('player-bar').getByTestId('cover')).toHaveAttribute('data-state', /fallback|loading/);
  await pickFolders(app, picture);
  await window.getByTestId('player-cover-menu').click();
  await window.getByRole('menuitem', { name: /Choose a cover picture/ }).click();
  await expect(window.getByTestId('player-bar').getByTestId('cover')).toHaveAttribute('data-state', 'image', { timeout: 10_000 });
  await expect(rowFor(window, 'Alpha').getByTestId('cover')).toHaveAttribute('data-state', 'image', { timeout: 10_000 });
  await window.getByTestId('player-cover-menu').click();
  await window.getByRole('menuitem', { name: /Remove my cover picture/ }).click();
  await expect(window.getByTestId('player-bar').getByTestId('cover')).toHaveAttribute('data-state', /fallback|loading/, { timeout: 10_000 });
  await app.close();
});

test('lyrics attached from a file follow edits to that file when the window comes back to the front', async () => {
  placeLyrics(box, 'Karan - Courtside', 'basic.lrc');
  const mine = path.join(box.sandbox, 'mine.lrc');
  fs.writeFileSync(mine, '[00:01.00]first version\n[00:05.00]second line\n');
  const { app, window } = await openApp();
  await rowFor(window, 'Courtside').locator('.nx-row-title').click();
  await waitPlaying(window);
  await pickFolders(app, mine);
  await window.getByTestId('player-bar').getByTestId('lyrics-attach-other').click({ timeout: 15_000 });
  await window.getByRole('button', { name: 'Open Now Playing' }).first().click();
  await expect(window.getByTestId('lyric-line').first()).toHaveText('first version', { timeout: 10_000 });
  fs.writeFileSync(mine, '[00:01.00]EDITED version\n[00:05.00]second line\n[00:09.00]third line\n');
  await window.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(window.getByTestId('lyric-line').first()).toHaveText('EDITED version', { timeout: 10_000 });
  await expect(window.getByTestId('lyric-line')).toHaveCount(3);
  await app.close();
});


/* ---------------------------------- v0.12.0: Lyric Studio ---------------------------------- */

test('Lyric Studio: find words online (canned answer), estimate timing, stamp, save a .lrc next to the song, and the lyrics appear', async () => {
  const fixture = path.join(box.sandbox, 'lrclib.json');
  fs.writeFileSync(fixture, JSON.stringify([
    { id: 7, trackName: 'Alpha', artistName: 'Karan', albumName: 'Covers', duration: 30, instrumental: false, plainLyrics: 'first line of the song\nsecond line here\nthird and last line', syncedLyrics: null },
    { id: 8, trackName: 'Alpha (other)', artistName: 'Nobody', albumName: '', duration: 200, instrumental: false, plainLyrics: 'something else' },
  ]));
  process.env['NOVA_LYRICS_FIXTURE'] = fixture;
  const { app, window } = await openApp();
  delete process.env['NOVA_LYRICS_FIXTURE'];
  await rowFor(window, 'Alpha').locator('.nx-row-title').click();
  await waitPlaying(window);

  // A song with no lyrics offers to create them, from the player bar.
  await window.getByTestId('player-bar').getByTestId('lyrics-create').click({ timeout: 15_000 });
  await expect(window.getByTestId('lyric-studio')).toBeVisible();
  await expect(window.getByTestId('studio-consent')).toBeVisible(); // nothing is sent until the listener presses Search
  await window.getByTestId('studio-search').click();
  await expect(window.getByTestId('studio-candidate')).toHaveCount(2, { timeout: 10_000 });
  await expect(window.getByTestId('studio-candidate').first()).toContainText(/\d+% match/);
  await shot(window, '12-studio-source');
  await window.getByTestId('studio-use-words').first().click();
  await expect(window.getByTestId('studio-line-count')).toHaveText(/3 lines/);
  await window.getByTestId('studio-begin').click();
  await expect(window.getByTestId('studio-rows')).toBeVisible({ timeout: 30_000 });
  await expect(window.getByTestId('studio-row')).toHaveCount(3);
  await shot(window, '13-studio-timing');

  // Keyboard: select line 2, stamp it now (the playhead is wherever the song is), then save.
  await window.keyboard.press('ArrowDown');
  await window.keyboard.press('Enter');
  await expect(window.getByTestId('studio-row').nth(1)).toHaveAttribute('data-locked', 'true');
  await expect(window.getByTestId('studio-row').nth(2)).toHaveAttribute('data-selected', 'true');
  await window.getByTestId('studio-save').click();
  await expect(window.getByTestId('studio-save-result')).toContainText('Saved next to the song', { timeout: 10_000 });

  const written = fs.readFileSync(path.join(box.music, 'Alpha.lrc'), 'utf8');
  expect(written).toMatch(/^\[ti:Alpha\]\n\[ar:[^\]]+\]\n\[by:Nova Player Lyric Studio\]\n\[\d\d:\d\d\.\d\d\]first line of the song\n\[\d\d:\d\d\.\d\d\]second line here\n\[\d\d:\d\d\.\d\d\]third and last line\n$/);

  // Closing leaves the song with real lyrics.
  await window.getByTestId('studio-close').click();
  await expect(window.getByTestId('lyric-studio')).toHaveCount(0);
  await window.getByRole('button', { name: 'Open Now Playing' }).first().click();
  await expect(window.getByTestId('lyric-line')).toHaveCount(3, { timeout: 10_000 });
  await expect(window.getByTestId('lyric-line').first()).toHaveText('first line of the song');
  await app.close();
});

test('Lyric Studio: pasted words in Urdu and Hindi work, an unsaved timing asks before it is discarded, and no .lrc is written without Save', async () => {
  const { app, window } = await openApp();
  await rowFor(window, 'Alpha').locator('.nx-row-title').click();
  await waitPlaying(window);
  await window.getByRole('button', { name: 'Open Now Playing' }).first().click();
  await window.getByTestId('create-lyrics').click({ timeout: 15_000 });
  await window.getByTestId('studio-text').fill('دل کی بات سنو\nप्यार भरे गीत\nਤੇਰੇ ਬਿਨਾ ਜੀਣਾ\ntere bina jeena');
  await expect(window.getByTestId('studio-line-count')).toHaveText(/4 lines/);
  await window.getByTestId('studio-begin').click();
  await expect(window.getByTestId('studio-row')).toHaveCount(4, { timeout: 30_000 });
  await expect(window.getByTestId('studio-row').nth(0)).toContainText('دل کی بات سنو');
  await window.getByTestId('studio-row').nth(2).click();
  await window.keyboard.press('ArrowRight'); // nudge +0.1 s locks the line
  await expect(window.getByTestId('studio-row').nth(2)).toHaveAttribute('data-locked', 'true');
  await window.keyboard.press('Escape');
  await expect(window.getByTestId('studio-confirm')).toBeVisible();
  await window.getByTestId('studio-discard').click();
  await expect(window.getByTestId('lyric-studio')).toHaveCount(0);
  expect(fs.existsSync(path.join(box.music, 'Alpha.lrc'))).toBe(false);
  await app.close();
});

test('Lyric Studio: a song that already has lyrics can be re-opened to fix or redo the timing; the old .lrc is kept as .bak', async () => {
  const mine = placeLyrics(box, 'Alpha', 'basic.lrc');
  const original = fs.readFileSync(mine, 'utf8');
  const { app, window } = await openApp();
  await rowFor(window, 'Alpha').locator('.nx-row-title').click();
  await waitPlaying(window);
  await window.getByTestId('player-bar').getByTestId('lyrics-retime').click({ timeout: 15_000 });
  await expect(window.getByTestId('studio-existing-note')).toBeVisible();
  await window.getByTestId('studio-fix-current').click();
  await expect(window.getByTestId('studio-row').first()).toBeVisible({ timeout: 30_000 });
  const before = await window.getByTestId('studio-time').first().innerText();
  await window.keyboard.press('ArrowRight');
  await window.keyboard.press('ArrowRight');
  await expect(window.getByTestId('studio-time').first()).not.toHaveText(before);
  await window.getByTestId('studio-save').click();
  await expect(window.getByTestId('studio-save-result')).toContainText('Saved', { timeout: 10_000 });
  expect(fs.readFileSync(`${mine}.bak`, 'utf8')).toBe(original);
  expect(fs.readFileSync(mine, 'utf8')).not.toBe(original);
  // "estimate again" is offered too
  await window.getByTestId('studio-back').click();
  await expect(window.getByTestId('studio-begin')).toContainText('Estimate again');
  await app.close();
});

/* ---------------------------------- v0.13.0 ---------------------------------- */

test('Space is a shortcut everywhere: with a button focused it still only plays/pauses, and a remapped key works', async () => {
  const { app, window } = await openApp();
  await rowFor(window, 'Alpha').locator('.nx-row-title').click();
  await waitPlaying(window);
  // focus a button by keyboard (Tab) - Space must NOT click it, only toggle playback
  await window.getByTestId('nav-songs').focus();
  const route = await window.getByTestId('main-scroll').count();
  await window.keyboard.press('Space');
  await expect(window.getByTestId('player-bar').getByRole('button', { name: /^Play$/ })).toBeVisible({ timeout: 5000 });
  await window.keyboard.press('Space');
  await expect(window.getByTestId('player-bar').getByRole('button', { name: /^Pause$/ })).toBeVisible({ timeout: 5000 });
  expect(await window.getByTestId('main-scroll').count()).toBe(route);
  // remap play/pause to K in Settings
  await window.keyboard.press('Control+,');
  await window.getByTestId('shortcut-togglePlay').click();
  await window.keyboard.press('k');
  await expect(window.getByTestId('shortcut-togglePlay')).toHaveText('K');
  await window.getByTestId('nav-songs').click();
  await window.keyboard.press('k');
  await expect(window.getByTestId('player-bar').getByRole('button', { name: /^Play$/ })).toBeVisible({ timeout: 5000 });
  await app.close();
});

test('Lyric style settings apply to the lyrics panel, and Lyric Studio keeps repeating the same song', async () => {
  placeLyrics(box, 'Alpha', 'basic.lrc');
  const { app, window } = await openApp();
  await rowFor(window, 'Alpha').locator('.nx-row-title').click();
  await waitPlaying(window);
  await window.keyboard.press('Control+,');
  await window.getByRole('button', { name: 'CAPS', exact: true }).click();
  await window.getByRole('button', { name: 'Centre' }).click();
  await window.getByRole('button', { name: 'Karaoke' }).click();
  await window.getByRole('button', { name: 'Open Now Playing' }).first().click();
  const panel = window.getByTestId('lyrics-panel');
  await expect(panel).toHaveAttribute('data-case', 'upper');
  await expect(panel).toHaveAttribute('data-align', 'center');
  await expect(panel).toHaveAttribute('data-anim', 'karaoke');
  await app.close();
});
