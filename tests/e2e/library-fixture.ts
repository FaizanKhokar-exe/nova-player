import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ElectronApplication, Page } from 'playwright';
import { expect } from '@playwright/test';
import { launchApp, pickFolders } from './helpers.js';
import { writeArtworkWav, writeTaggedWav, type WavTags } from './media-fixtures.js';

/** Shared by the Phase 5 specs: a deterministic tagged library, and locators for the library UI. */
export type { WavTags };
export { writeTaggedWav, writeArtworkWav };

export interface Fixture extends WavTags {
  readonly seconds: number;
}

// Durations differ so "sort by duration" has one right answer; all are long enough that nothing ends mid-test.
export const FIXTURE: readonly Fixture[] = [
  { title: 'Alpha', artist: 'Ann', album: 'First', genre: 'Rock', year: 2001, track: 1, seconds: 23 },
  { title: 'Bravo', artist: 'Ann', album: 'First', genre: 'Rock', year: 2001, track: 2, seconds: 24 },
  { title: 'Charlie', artist: 'Bob', album: 'Second', genre: 'Jazz', year: 1990, track: 1, seconds: 25 },
  { title: 'Delta', artist: 'Bob', album: 'Second', genre: 'Jazz', year: 1990, track: 2, seconds: 26 },
  { title: 'Echo', artist: 'Cy', genre: 'Pop, Rock', seconds: 27 },
  { title: 'Foxtrot', artist: 'Dee', seconds: 28 },
];
export const ALL = FIXTURE.map((f) => f.title);

export interface AudioSnapshot {
  src: string;
  paused: boolean;
  currentTime: number;
}
export const audioOf = (page: Page): Promise<AudioSnapshot> =>
  page.evaluate(() => {
    const a = document.getElementById('nova-audio') as HTMLAudioElement;
    return { src: a.src, paused: a.paused, currentTime: a.currentTime };
  });
export async function waitPlaying(page: Page): Promise<void> {
  await expect.poll(async () => (await audioOf(page)).paused, { timeout: 15_000 }).toBe(false);
  await expect.poll(async () => (await audioOf(page)).currentTime, { timeout: 15_000 }).toBeGreaterThan(0.2);
}

type View = 'tracks' | 'albums' | 'artists' | 'genres' | 'queue' | 'nowplaying' | 'lyrics' | 'settings';
const NAV: Record<View, string> = { tracks: 'nav-songs', albums: 'nav-albums', artists: 'nav-artists', genres: 'nav-genres', queue: 'player-queue', nowplaying: 'nav-home', lyrics: 'player-lyrics', settings: 'nav-settings' };
export const nav = (page: Page, view: View) => page.getByTestId(NAV[view]);
const COUNT: Record<'tracks' | 'albums' | 'artists' | 'genres' | 'queue', string> = { tracks: 'nav-songs-count', albums: 'nav-albums-count', artists: 'nav-artists-count', genres: 'nav-genres-count', queue: 'nav-songs-count' };
export const count = (page: Page, view: 'tracks' | 'albums' | 'artists' | 'genres' | 'queue') => page.getByTestId(COUNT[view]);
export const title = (page: Page) => page.getByTestId('player-title');
export const trackRow = (page: Page, name: string) => page.getByTestId('track-row').filter({ has: page.locator('.nx-row-title', { hasText: new RegExp(`^${name}$`) }) });
export const trackTitles = (page: Page) => page.getByTestId('track-row').locator('.nx-row-title').allInnerTexts();
/** Row play buttons only show on hover (as in Spotify), so a user hovers first. */
export async function playTrack(page: Page, name: string): Promise<void> {
  await trackRow(page, name).hover();
  await trackRow(page, name).getByTestId('row-play').click();
}
export const queueTitles = (page: Page) => page.getByTestId('queue-panel').getByTestId('queue-title').allInnerTexts();
export const isPaused = (page: Page): Promise<boolean> => audioOf(page).then((a) => a.paused);
export async function openQueue(page: Page): Promise<void> {
  if ((await page.getByTestId('queue-panel').getAttribute('data-open')) !== 'true') await page.getByTestId('player-queue').click();
  await expect(page.getByTestId('queue-panel')).toHaveAttribute('data-open', 'true');
}

export interface Sandbox {
  readonly sandbox: string;
  readonly music: string;
  readonly userData: string;
}

export function makeSandbox(): Sandbox {
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nova-e2e-lib-')));
  const music = path.join(sandbox, 'Music');
  for (const f of FIXTURE) writeTaggedWav(music, f.title, f.seconds, f);
  return { sandbox, music, userData: path.join(sandbox, 'userData') };
}

/** Launches the app, adds the fixture folder through the UI (it scans straight away) and opens Songs. */
export async function openLibrary(box: Sandbox, expectedTracks = 6): Promise<{ app: ElectronApplication; window: Page }> {
  const { app, window } = await launchApp({ userDataDir: box.userData });
  await window.setViewportSize({ width: 1360, height: 820 });
  await pickFolders(app, box.music);
  await window.getByTestId('home-add-folder').click();
  await expect(count(window, 'tracks')).toHaveText(String(expectedTracks), { timeout: 30_000 });
  await nav(window, 'tracks').click();
  await expect(window.getByTestId('track-row').first()).toBeVisible();
  return { app, window };
}

const LYRICS_FIXTURES = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../fixtures/lyrics');

/** Copies a fixture from tests/fixtures/lyrics next to the named track as its `.lrc` sidecar. */
export function placeLyrics(box: Sandbox, trackTitle: string, fixtureName: string): string {
  const target = path.join(box.music, `${trackTitle}.lrc`);
  fs.copyFileSync(path.join(LYRICS_FIXTURES, fixtureName), target);
  return target;
}

export const lyricLines = (page: Page) => page.getByTestId('lyrics-list').getByTestId('lyric-line');
export const activeLyricText = (page: Page) => page.locator('[data-testid="lyric-line"][data-active="true"]').innerText().catch(() => '');
