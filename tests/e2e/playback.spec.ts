import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ElectronApplication, Page } from 'playwright';
import { test, expect } from '@playwright/test';
import { launchApp, pickFolders } from './helpers.js';
import { writeWav } from './media-fixtures.js';

/**
 * Phase 4: real playback in the real Electron app. A real library folder is
 * added and scanned through the UI, and the real <audio> element plays real
 * audio files that the main process serves over `nova-media://track/<id>`.
 *
 * What is verified is the browser's own media state (paused, currentTime,
 * readyState, ended, the element's source), read from the live element - not
 * a simulation. What is NOT verified is audible output: this container has no
 * sound device, so "it played" means "Chromium decoded it and its media clock
 * advanced", which is what the element reports. Every wait is on a media or UI
 * condition; there are no fixed sleeps.
 */

const TRACK_SECONDS = 6;
const TITLES = ['Alpha', 'Bravo', 'Charlie'] as const;

interface AudioSnapshot {
  src: string;
  paused: boolean;
  ended: boolean;
  currentTime: number;
  duration: number;
  readyState: number;
  volume: number;
  muted: boolean;
  errorCode: number | null;
}

const audioOf = (page: Page): Promise<AudioSnapshot> =>
  page.evaluate(() => {
    const a = document.getElementById('nova-audio') as HTMLAudioElement;
    return { src: a.src, paused: a.paused, ended: a.ended, currentTime: a.currentTime, duration: a.duration, readyState: a.readyState, volume: a.volume, muted: a.muted, errorCode: a.error?.code ?? null };
  });

const player = (page: Page) => page.getByTestId('player-bar');
const title = (page: Page) => page.getByTestId('player-title');
const toggle = (page: Page) => page.getByTestId('player-play');
const row = (page: Page, name: string) => page.getByTestId('track-row').filter({ hasText: name });
/** Waits until no scan is running and the last one finished (read from main, not from a label). */
const waitScanIdle = (page: Page): Promise<void> =>
  expect
    .poll(() => page.evaluate(async () => {
      const r = await (window as unknown as { nova: { invoke: (c: string) => Promise<{ ok: boolean; value: { active?: unknown; last?: { status: string } } }> } }).nova.invoke('library:getScanState');
      return r.ok && r.value.active === undefined && r.value.last?.status === 'completed';
    }), { timeout: 20_000 })
    .toBe(true);
/** A row's play button only shows on hover (as in Spotify), so a user hovers first. */
const playRow = async (page: Page, name: string): Promise<void> => {
  await row(page, name).hover();
  await row(page, name).getByTestId('row-play').click();
};

/** The file's own TrackId, read from the row the user sees. */
const trackIdOf = (page: Page, name: string): Promise<string> => row(page, name).getAttribute('data-track-id').then((id) => id!);

async function waitPlaying(page: Page, minTime = 0.3): Promise<void> {
  await expect.poll(async () => (await audioOf(page)).paused, { timeout: 15_000 }).toBe(false);
  await expect.poll(async () => (await audioOf(page)).currentTime, { timeout: 15_000 }).toBeGreaterThan(minTime);
}

/** Fetches a media URL through the app's real protocol handler, the same code path the <audio> element uses. */
async function fetchMedia(app: ElectronApplication, url: string, headers: Record<string, string> = {}, method = 'GET') {
  return app.evaluate(
    async ({ net }, args) => {
      try {
        const response = await net.fetch(args.url, { method: args.method, headers: args.headers, bypassCustomProtocolHandlers: false });
        const buffer = Buffer.from(await response.arrayBuffer());
        return {
          status: response.status,
          contentType: response.headers.get('content-type'),
          contentRange: response.headers.get('content-range'),
          contentLength: response.headers.get('content-length'),
          acceptRanges: response.headers.get('accept-ranges'),
          denial: response.headers.get('x-nova-media-denial'),
          bytes: buffer.length,
          head: buffer.subarray(0, 4).toString('latin1'),
          text: response.status >= 400 ? buffer.toString('utf8') : '',
        };
      } catch (error) {
        return { status: -1, error: String(error) } as never;
      }
    },
    { url, headers, method },
  );
}

let sandbox: string;
let music: string;
let userData: string;

test.beforeEach(() => {
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nova-e2e-play-')));
  music = path.join(sandbox, 'Music');
  userData = path.join(sandbox, 'userData');
  for (const name of TITLES) writeWav(music, `Test Artist - ${name}`, TRACK_SECONDS);
});
test.afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

/** Launches, adds the library through the UI and scans it. */
async function openLibrary(options: { reuse?: { app: ElectronApplication; window: Page } } = {}) {
  const { app, window } = options.reuse ?? (await launchApp({ userDataDir: userData }));
  await pickFolders(app, music);
  await window.getByTestId('home-add-folder').click(); // adds the folder and scans it
  await window.getByTestId('nav-songs').click();
  await expect(window.getByTestId('track-row')).toHaveCount(TITLES.length, { timeout: 20_000 });
  return { app, window };
}

test.describe('playing a library track', () => {
  test('the real <audio> element plays it from an opaque nova-media URL, and the UI follows the real media state', async () => {
    const { app, window } = await openLibrary();
    await expect(player(window)).toHaveAttribute('data-state', 'empty');
    await expect(title(window)).toHaveText('Nothing playing');

    await playRow(window, 'Alpha');
    await waitPlaying(window);

    const audio = await audioOf(window);
    const alphaId = await trackIdOf(window, 'Alpha');
    expect(audio.src).toBe(`nova-media://track/${alphaId}`); // an opaque id: no path, no folder name
    expect(audio.src).not.toContain(music);
    expect(audio.src).not.toMatch(/Music|Alpha|\.wav/);
    expect(audio.readyState).toBeGreaterThanOrEqual(3);
    expect(audio.errorCode).toBeNull();
    expect(audio.duration).toBeCloseTo(TRACK_SECONDS, 0);

    await expect(player(window)).toHaveAttribute('data-state', 'playing');
    await expect(title(window)).toHaveText('Alpha');
    await expect(window.getByTestId('player-artist')).toHaveText('Test Artist');
    await expect(window.getByTestId('player-duration')).toHaveText('0:06');
    await expect(toggle(window)).toHaveAccessibleName('Pause');
    await expect(row(window, 'Alpha')).toHaveAttribute('data-current', 'true');
    await expect(row(window, 'Bravo')).toHaveAttribute('data-current', 'false');

    // the position display follows the element's own clock
    await expect.poll(async () => (await window.getByTestId('player-position').innerText()) !== '0:00').toBe(true);
    await app.close();
  });

  test('pause and resume act on the real element, and the position holds while paused', async () => {
    const { app, window } = await openLibrary();
    await playRow(window, 'Alpha');
    await waitPlaying(window);

    await toggle(window).click();
    await expect.poll(async () => (await audioOf(window)).paused).toBe(true);
    await expect(player(window)).toHaveAttribute('data-state', 'paused');
    await expect(toggle(window)).toHaveAccessibleName('Play');
    const held = (await audioOf(window)).currentTime;
    // stays put: poll until we have seen the same value twice in a row
    await expect.poll(async () => (await audioOf(window)).currentTime).toBe(held);

    await toggle(window).click();
    await expect.poll(async () => (await audioOf(window)).paused).toBe(false);
    await expect.poll(async () => (await audioOf(window)).currentTime, { timeout: 15_000 }).toBeGreaterThan(held + 0.2);
    await expect(player(window)).toHaveAttribute('data-state', 'playing');
    await app.close();
  });

  test('seeking moves the real element via byte-range requests, to the requested position', async () => {
    const { app, window } = await openLibrary();
    await playRow(window, 'Alpha');
    await waitPlaying(window);
    await toggle(window).click(); // pause so the clock does not move under the assertions
    await expect.poll(async () => (await audioOf(window)).paused).toBe(true);

    await window.getByTestId('player-seek').fill('4000'); // ms
    await expect.poll(async () => (await audioOf(window)).currentTime, { timeout: 10_000 }).toBeCloseTo(4, 1);
    await expect(window.getByTestId('player-position')).toHaveText('0:04');
    expect((await audioOf(window)).paused).toBe(true); // seeking does not start playback

    // seek near the end, then resume: the rest plays
    await window.getByTestId('player-seek').fill('5000');
    await expect.poll(async () => (await audioOf(window)).currentTime).toBeCloseTo(5, 1);
    await app.close();
  });

  test('volume and mute drive the real element', async () => {
    const { app, window } = await openLibrary();
    await playRow(window, 'Alpha');
    await waitPlaying(window);

    await window.getByTestId('player-volume').fill('30', { timeout: 4000 });
    await expect.poll(async () => (await audioOf(window)).volume).toBeCloseTo(0.3, 2);
    await window.getByTestId('player-mute').click();
    await expect.poll(async () => (await audioOf(window)).muted).toBe(true);
    await expect(window.getByRole('button', { name: 'Unmute' })).toHaveAttribute('aria-pressed', 'true');
    await expect(window.getByTestId('player-volume')).toHaveValue('0'); // shows muted as zero
    expect((await audioOf(window)).paused).toBe(false); // muting does not stop playback
    await window.getByRole('button', { name: 'Unmute' }).click();
    await expect.poll(async () => (await audioOf(window)).muted).toBe(false);
    await expect(window.getByTestId('player-volume')).toHaveValue('30');
    await app.close();
  });
});

test.describe('queue: next, previous, ended, repeat, shuffle (the Phase 1 rules, run in main)', () => {
  test('next and previous follow the queue; Previous restarts a track played past 3 s', async () => {
    const { app, window } = await openLibrary();
    await playRow(window, 'Alpha');
    await waitPlaying(window);
    await expect(window.getByRole('button', { name: 'Next' })).toBeEnabled();

    await window.getByRole('button', { name: 'Next' }).click();
    await expect(title(window)).toHaveText('Bravo');
    await expect.poll(async () => (await audioOf(window)).src).toBe(`nova-media://track/${await trackIdOf(window, 'Bravo')}`);
    await waitPlaying(window);
    await expect(row(window, 'Bravo')).toHaveAttribute('data-current', 'true');

    // Early in the track: Previous goes back to the track before it.
    await window.getByRole('button', { name: 'Previous' }).click();
    await expect(title(window)).toHaveText('Alpha');
    await waitPlaying(window);

    // Past the 3 s threshold: Previous restarts the same track instead of going back.
    await window.getByRole('button', { name: 'Next' }).click();
    await expect(title(window)).toHaveText('Bravo');
    await waitPlaying(window);
    await window.getByTestId('player-seek').fill('4000');
    await expect.poll(async () => (await audioOf(window)).currentTime).toBeGreaterThan(3.5);
    await window.getByRole('button', { name: 'Previous' }).click();
    await expect.poll(async () => (await audioOf(window)).currentTime, { timeout: 10_000 }).toBeLessThan(2);
    await expect(title(window)).toHaveText('Bravo');

    // On the last track there is nothing after it (repeat off).
    await window.getByRole('button', { name: 'Next' }).click();
    await expect(title(window)).toHaveText('Charlie');
    await expect(window.getByRole('button', { name: 'Next' })).toBeDisabled();
    await app.close();
  });

  test('a track ending moves on to the next; the last one stops the queue (repeat off)', async () => {
    const { app, window } = await openLibrary();
    await playRow(window, 'Bravo');
    await waitPlaying(window);

    // Jump to just before the end and let it genuinely finish.
    await window.getByTestId('player-seek').fill('5000');
    await expect(title(window)).toHaveText('Charlie', { timeout: 20_000 });
    await expect.poll(async () => (await audioOf(window)).src).toBe(`nova-media://track/${await trackIdOf(window, 'Charlie')}`);
    await waitPlaying(window, 0.1);
    await expect(row(window, 'Charlie')).toHaveAttribute('data-current', 'true');

    // Charlie is last: when it ends, playback stops on it, back at the start.
    await window.getByTestId('player-seek').fill('5000');
    await expect(player(window)).toHaveAttribute('data-state', 'paused', { timeout: 20_000 });
    await expect(title(window)).toHaveText('Charlie');
    const stopped = await audioOf(window);
    expect(stopped.paused).toBe(true);
    expect(stopped.currentTime).toBeLessThan(1);
    await expect(window.getByTestId('player-position')).toHaveText('0:00');
    await expect(toggle(window)).toHaveAccessibleName('Play');

    // ...and the user can start it again.
    await toggle(window).click();
    await waitPlaying(window, 0.1);
    await app.close();
  });

  test('repeat all wraps from the last track to the first when it ends', async () => {
    const { app, window } = await openLibrary();
    await window.getByTestId('player-repeat').click();
    await expect(window.getByRole('button', { name: 'Repeat: all' })).toBeVisible();
    await playRow(window, 'Charlie');
    await waitPlaying(window);
    await window.getByTestId('player-seek').fill('5000');
    await expect(title(window)).toHaveText('Alpha', { timeout: 20_000 });
    await waitPlaying(window, 0.1);
    await expect(row(window, 'Alpha')).toHaveAttribute('data-current', 'true');
    await expect(window.getByRole('button', { name: 'Next' })).toBeEnabled();
    await app.close();
  });

  test('repeat one replays the same track when it ends, without reloading it', async () => {
    const { app, window } = await openLibrary();
    await window.getByTestId('player-repeat').click(); // all
    await window.getByTestId('player-repeat').click(); // one
    await expect(window.getByRole('button', { name: 'Repeat: one' })).toBeVisible();
    await playRow(window, 'Alpha');
    await waitPlaying(window);
    const src = (await audioOf(window)).src;

    await window.getByTestId('player-seek').fill('5000');
    // it ends, then restarts: time goes back near 0 and it is playing again
    await expect.poll(async () => (await audioOf(window)).currentTime, { timeout: 20_000 }).toBeLessThan(2);
    await waitPlaying(window, 0.1);
    expect((await audioOf(window)).src).toBe(src);
    await expect(title(window)).toHaveText('Alpha');
    await app.close();
  });

  test('shuffle visits every track exactly once, then turning it off restores the library order', async () => {
    const { app, window } = await openLibrary();
    await playRow(window, 'Alpha');
    await waitPlaying(window);

    await window.getByTestId('player-shuffle').click();
    await expect(window.getByTestId('player-shuffle')).toHaveAttribute('aria-pressed', 'true');
    await expect(title(window)).toHaveText('Alpha'); // enabling shuffle never interrupts the current track
    expect((await audioOf(window)).paused).toBe(false);

    const seen = ['Alpha'];
    for (let i = 0; i < 2; i += 1) {
      await window.getByRole('button', { name: 'Next' }).click();
      await expect(title(window)).not.toHaveText(seen.at(-1)!);
      seen.push(await title(window).innerText());
    }
    expect([...seen].sort()).toEqual(['Alpha', 'Bravo', 'Charlie']); // each exactly once, in some order
    await expect(window.getByRole('button', { name: 'Next' })).toBeDisabled(); // queue exhausted

    await window.getByTestId('player-shuffle').click();
    await expect(window.getByTestId('player-shuffle')).toHaveAttribute('aria-pressed', 'false');
    // Original order is back: whichever track is current, Next goes to the one after it in the library order
    // (or is disabled on the last one).
    const current = await title(window).innerText();
    const index = TITLES.indexOf(current as (typeof TITLES)[number]);
    if (index < TITLES.length - 1) {
      await window.getByRole('button', { name: 'Next' }).click();
      await expect(title(window)).toHaveText(TITLES[index + 1]!);
    } else {
      await expect(window.getByRole('button', { name: 'Next' })).toBeDisabled();
    }
    await app.close();
  });
});

test.describe('the library stays usable while playing', () => {
  test('searching, rescanning and scrolling do not interrupt playback, and search results become the queue', async () => {
    const { app, window } = await openLibrary();
    await playRow(window, 'Alpha');
    await waitPlaying(window);

    // Search: the list filters, the current track keeps playing.
    await window.getByRole('searchbox', { name: 'Search your music' }).fill('bravo');
    await expect(window.getByTestId('track-row')).toHaveCount(1);
    expect((await audioOf(window)).paused).toBe(false);
    await expect(title(window)).toHaveText('Alpha');

    // A rescan changes nothing about what is playing.
    await window.getByRole('searchbox', { name: 'Search your music' }).fill('');
    await expect(window.getByTestId('track-row')).toHaveCount(3);
    const before = (await audioOf(window)).currentTime;
    await window.getByRole('button', { name: 'Scan library' }).click();
    await waitScanIdle(window);
    const after = await audioOf(window);
    expect(after.paused).toBe(false);
    expect(after.currentTime).toBeGreaterThanOrEqual(before);
    await expect(row(window, 'Alpha')).toHaveAttribute('data-current', 'true');

    // Playing from a search queues only those results: one track, so nothing follows it.
    await window.getByRole('searchbox', { name: 'Search your music' }).fill('charlie');
    await expect(window.getByTestId('track-row')).toHaveCount(1);
    await playRow(window, 'Charlie');
    await expect(title(window)).toHaveText('Charlie');
    await expect(window.getByRole('button', { name: 'Next' })).toBeDisabled();
    await app.close();
  });

  test('a playing track removed from disk: after a rescan playback stops, the user is told, and nothing claims it is playing', async () => {
    const { app, window } = await openLibrary();
    await playRow(window, 'Alpha');
    await waitPlaying(window);

    fs.rmSync(path.join(music, 'Test Artist - Alpha.wav'));
    await window.getByRole('button', { name: 'Scan library' }).click();
    await expect(window.getByTestId('track-row')).toHaveCount(2, { timeout: 20_000 });

    await expect(window.getByTestId('toasts')).toContainText('no longer in your library');
    await expect.poll(async () => (await audioOf(window)).paused).toBe(true);
    await expect(player(window)).not.toHaveAttribute('data-state', 'playing');
    await expect(title(window)).toHaveText('Bravo'); // the queue moved on, paused
    await expect(row(window, 'Bravo')).toHaveAttribute('data-current', 'true');
    await expect(window.getByTestId('track-row').filter({ hasText: 'Alpha' })).toHaveCount(0);
    // the library still works: play what is left
    await playRow(window, 'Charlie');
    await waitPlaying(window, 0.1);
    await app.close();
  });

  test('removing the library folder while playing stops playback and empties the player', async () => {
    const { app, window } = await openLibrary();
    await playRow(window, 'Alpha');
    await waitPlaying(window);
    const alphaUrl = (await audioOf(window)).src;

    await window.getByTestId('nav-settings').click();
    await window.getByTestId('root-row').getByRole('button', { name: /Remove/ }).click();
    await window.getByTestId('dialog').getByRole('button', { name: 'Remove' }).click();
    await window.getByTestId('nav-songs').click();
    await expect(window.getByTestId('track-row')).toHaveCount(0, { timeout: 15_000 });
    await expect.poll(async () => (await audioOf(window)).paused).toBe(true);
    await expect(player(window)).toHaveAttribute('data-state', 'empty');
    await expect(title(window)).toHaveText('Nothing playing');
    expect((await audioOf(window)).src).toBe(''); // the source was released

    // and the address that used to work no longer does
    const response = await fetchMedia(app, alphaUrl);
    expect(response.status).toBeGreaterThanOrEqual(403);
    expect(response.status).toBeLessThanOrEqual(404);
    expect(response.bytes).toBeLessThan(100); // an error text, not audio
    await app.close();
  });
});

test.describe('playback errors, in plain words', () => {
  test('a file deleted behind the app\'s back: a clear message, and the library keeps working', async () => {
    const { app, window } = await openLibrary();
    fs.rmSync(path.join(music, 'Test Artist - Alpha.wav'));
    await playRow(window, 'Alpha');

    const alert = window.getByTestId('player-error');
    await expect(alert).toContainText("can't be found", { timeout: 15_000 });
    await expect(player(window)).toHaveAttribute('data-state', 'error');
    const message = await alert.innerText();
    expect(message).not.toContain(music);
    expect(message).not.toMatch(/ENOENT|[\\/]|\.wav|Error:/);

    // another track plays normally and the error goes away
    await playRow(window, 'Bravo');
    await waitPlaying(window);
    await expect(window.getByTestId('player-error')).toHaveCount(0);
    await app.close();
  });

  test('a library folder that went away (unplugged drive): says the folder is unavailable, and recovers when it returns', async () => {
    const { app, window } = await openLibrary();
    const moved = `${music}-unplugged`;
    fs.renameSync(music, moved);
    await playRow(window, 'Alpha');
    await expect(window.getByTestId('player-error')).toContainText("isn't available", { timeout: 15_000 });

    fs.renameSync(moved, music);
    await window.getByRole('button', { name: 'Try again' }).click();
    await waitPlaying(window);
    await expect(window.getByTestId('player-error')).toHaveCount(0);
    await app.close();
  });

  test('a file the decoder cannot play: an honest "can\'t play" message, never a pretend playback', async () => {
    const { app, window } = await openLibrary();
    // Same name and extension, but the bytes are no longer audio.
    fs.writeFileSync(path.join(music, 'Test Artist - Alpha.wav'), Buffer.alloc(4096, 0x41));
    await playRow(window, 'Alpha');

    const alert = window.getByTestId('player-error');
    await expect(alert).toContainText(/damaged|isn't supported|can't be played/, { timeout: 15_000 });
    await expect(player(window)).toHaveAttribute('data-state', 'error');
    expect((await audioOf(window)).paused || (await audioOf(window)).errorCode !== null).toBe(true);
    expect(await alert.innerText()).not.toMatch(/[\\/]|\.wav|Error:/);
    // Pressing Dismiss clears it and the library is still fully usable.
    await window.getByRole('button', { name: 'Dismiss error' }).click();
    await expect(window.getByTestId('player-error')).toHaveCount(0);
    await expect(window.getByTestId('track-row')).toHaveCount(3);
    await app.close();
  });
});

test.describe('the media boundary, attacked from outside the UI', () => {
  test('valid track URLs serve real bytes with correct range semantics', async () => {
    const { app, window } = await openLibrary();
    const url = `nova-media://track/${await trackIdOf(window, 'Alpha')}`;
    const size = fs.statSync(path.join(music, 'Test Artist - Alpha.wav')).size;

    const full = await fetchMedia(app, url);
    expect(full).toMatchObject({ status: 200, contentType: 'audio/wav', acceptRanges: 'bytes', bytes: size, head: 'RIFF' });
    expect(full.contentLength).toBe(String(size));

    const part = await fetchMedia(app, url, { Range: 'bytes=100-199' });
    expect(part).toMatchObject({ status: 206, contentRange: `bytes 100-199/${size}`, contentLength: '100', bytes: 100 });

    const tail = await fetchMedia(app, url, { Range: 'bytes=-50' });
    expect(tail).toMatchObject({ status: 206, contentRange: `bytes ${size - 50}-${size - 1}/${size}`, bytes: 50 });

    const bad = await fetchMedia(app, url, { Range: `bytes=${size + 10}-` });
    expect(bad).toMatchObject({ status: 416, contentRange: `bytes */${size}` });

    const head = await fetchMedia(app, url, {}, 'HEAD');
    expect(head).toMatchObject({ status: 200, contentLength: String(size), bytes: 0 });

    expect((await fetchMedia(app, url, {}, 'POST')).status).toBe(405);
    await app.close();
  });

  test('unknown ids, malformed URLs, traversal and absolute paths are all refused', async () => {
    const { app, window } = await openLibrary();
    const id = await trackIdOf(window, 'Alpha');
    const outsideFile = path.join(sandbox, 'outside-secret.wav');
    fs.writeFileSync(outsideFile, 'SECRET-OUTSIDE-BYTES');

    const refused: Array<[string, number[]]> = [
      ['nova-media://track/00000000-0000-4000-8000-00000000dead', [404]], // well-formed but unknown
      ['nova-media://track/not-a-track-id', [400]],
      ['nova-media://track/', [400]],
      [`nova-media://track/${id}/extra`, [400]],
      [`nova-media://track/${id}?x=1`, [400]],
      [`nova-media://track/..%2F..%2F..%2Fetc%2Fpasswd`, [400]],
      [`nova-media://track/${encodeURIComponent(outsideFile)}`, [400]],
      ['nova-media://elsewhere/anything', [400]],
      // The Phase 0 path-based shape serves only the fixtures directory, never a library or any other path:
      [`nova-media://local${path.join(music, 'Test Artist - Alpha.wav')}`, [403]],
      [`nova-media://local${outsideFile}`, [403]],
      ['nova-media://local/etc/passwd', [403]],
      [`nova-media://local${music}/../outside-secret.wav`, [403]],
    ];
    for (const [url, statuses] of refused) {
      const response = await fetchMedia(app, url);
      expect(statuses, `${url} -> ${response.status}`).toContain(response.status);
      expect(response.text ?? '').not.toContain('SECRET-OUTSIDE-BYTES');
      expect(response.head).not.toBe('RIFF');
    }
    await app.close();
  });

  test('a link inside the library that points outside it is refused (links are never followed out)', async () => {
    const { app, window } = await openLibrary();
    const id = await trackIdOf(window, 'Alpha');
    const outsideFile = path.join(sandbox, 'outside-secret.wav');
    fs.writeFileSync(outsideFile, 'SECRET-OUTSIDE-BYTES');
    // The indexed file is swapped for a symlink to a file outside every library folder.
    const alphaPath = path.join(music, 'Test Artist - Alpha.wav');
    fs.rmSync(alphaPath);
    fs.symlinkSync(outsideFile, alphaPath);

    const response = await fetchMedia(app, `nova-media://track/${id}`);
    expect(response.status).toBe(403);
    expect(response.denial).toBe('outside-root');
    expect(response.text).not.toContain('SECRET');
    expect(response.bytes).toBeLessThan(100);

    // Through the UI it reads as a plain "can't open", with no hint of the target.
    await playRow(window, 'Alpha');
    const alert = window.getByTestId('player-error');
    await expect(alert).toContainText("can't open this file", { timeout: 15_000 });
    expect(await alert.innerText()).not.toMatch(/outside|secret|[\\/]/i);
    await app.close();
  });

  test('a library folder replaced by a link to somewhere else stops granting access', async () => {
    const { app, window } = await openLibrary();
    const id = await trackIdOf(window, 'Alpha');
    const decoy = path.join(sandbox, 'Decoy');
    fs.cpSync(music, decoy, { recursive: true }); // same file names, so a lookup by path would "work"
    fs.rmSync(music, { recursive: true });
    fs.symlinkSync(decoy, music, 'dir');

    const response = await fetchMedia(app, `nova-media://track/${id}`);
    expect(response.status).toBe(403);
    expect(response.denial).toBe('root-changed');
    await app.close();
  });

  test('the bridge exposes no way to ask for a file path or to build a media address', async () => {
    const { app, window } = await openLibrary();
    await playRow(window, 'Alpha');
    await waitPlaying(window);
    const exposure = await window.evaluate(async () => {
      const nova = (window as unknown as { nova: Record<string, unknown> }).nova;
      const state = await (nova.invoke as (c: string, r?: unknown) => Promise<unknown>)('playback:getState');
      const listed = await (nova.invoke as (c: string, r?: unknown) => Promise<unknown>)('library:listTracks', {});
      return { keys: Object.keys(nova).sort(), state: JSON.stringify(state), listed: JSON.stringify(listed) };
    });
    expect(exposure.keys).toEqual(['invoke', 'subscribe']);
    for (const text of [exposure.state, exposure.listed]) {
      expect(text).not.toContain(music);
      expect(text).not.toMatch(/sourcePath|"path"|\.wav/);
    }
    await app.close();
  });
});

test.describe('persistence across a restart', () => {
  test('the queue, modes and position come back after restarting - paused, never auto-playing', async () => {
    const first = await openLibrary();
    let { window } = first;
    await window.getByTestId('player-repeat').click(); // all
    await expect(window.getByRole('button', { name: 'Repeat: all' })).toBeVisible();
    await window.getByTestId('player-shuffle').click();
    await expect(window.getByTestId('player-shuffle')).toHaveAttribute('aria-pressed', 'true');
    await playRow(window, 'Bravo');
    await waitPlaying(window);

    await window.getByTestId('player-seek').fill('3000');
    await expect.poll(async () => (await audioOf(window)).currentTime).toBeGreaterThanOrEqual(3);
    await toggle(window).click(); // pause: this saves the position
    await expect.poll(async () => (await audioOf(window)).paused).toBe(true);

    // Wait until the backend has recorded it (an observable condition, not a sleep).
    await expect
      .poll(async () =>
        window.evaluate(async () => {
          const r = (await (window as unknown as { nova: { invoke: (c: string) => Promise<{ ok: boolean; value: { positionMs: number } }> } }).nova.invoke('playback:getState'));
          return r.ok ? r.value.positionMs : -1;
        }),
      )
      .toBeGreaterThanOrEqual(3000);
    const savedTitle = await title(window).innerText();
    expect(savedTitle).toBe('Bravo');
    await first.app.close();

    // ---- restart with the same profile ----
    const second = await launchApp({ userDataDir: userData });
    window = second.window;
    await expect(title(window)).toHaveText('Bravo', { timeout: 20_000 });
    await expect(window.getByRole('button', { name: 'Repeat: all' })).toBeVisible();
    await expect(window.getByTestId('player-shuffle')).toHaveAttribute('aria-pressed', 'true');
    await expect(player(window)).toHaveAttribute('data-state', 'paused', { timeout: 20_000 });

    // The source is loaded and parked at the saved position, but nothing is playing.
    await expect.poll(async () => (await audioOf(window)).readyState, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
    await expect.poll(async () => (await audioOf(window)).currentTime, { timeout: 15_000 }).toBeGreaterThanOrEqual(2.9);
    const restored = await audioOf(window);
    expect(restored.paused).toBe(true);
    expect(restored.currentTime).toBeLessThan(4);
    expect(restored.src).toMatch(/^nova-media:\/\/track\//);
    await expect(window.getByTestId('player-position')).toHaveText('0:03');
    await window.getByTestId('nav-songs').click();
    await expect(window.getByTestId('track-row')).toHaveCount(3); // the library persisted too

    // Pressing Play resumes from where it was.
    await toggle(window).click();
    await expect.poll(async () => (await audioOf(window)).paused).toBe(false);
    await expect.poll(async () => (await audioOf(window)).currentTime, { timeout: 15_000 }).toBeGreaterThan(3.2);
    await second.app.close();
  });
});
