import fs from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { makeSandbox, openLibrary, playTrack, waitPlaying, title, type Sandbox } from './library-fixture.js';

/**
 * The on-screen display, in the real Electron app (real Chromium media events, no fake audio). Audible output is not
 * verifiable here; what is verified is the sequence of media events the HUD reacts to.
 */

let box: Sandbox;
test.beforeEach(() => { box = makeSandbox(); });
test.afterEach(() => { fs.rmSync(box.sandbox, { recursive: true, force: true }); });
test.setTimeout(90_000);

/** Records every text the HUD's live region ever shows, so a flash that is gone again after 1.5 s cannot be missed. */
const record = (page: Page): Promise<void> =>
  page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __hud: string[] }).__hud = seen;
    seen.push(document.querySelector('.nx-hud-live')?.textContent ?? ''); // whatever was already there is the baseline
    new MutationObserver(() => {
      const text = document.querySelector('.nx-hud-live')?.textContent ?? '';
      if (text !== '' && seen[seen.length - 1] !== text) seen.push(text);
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
/** Play / Pause texts the HUD showed since the last `forget` (other texts, like an earlier label still on screen, are not what is tested). */
const seen = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as { __hud: string[] }).__hud.filter((t) => t === 'Play' || t === 'Pause'));
const forget = (page: Page): Promise<void> => page.evaluate(() => { (window as unknown as { __hud: string[] }).__hud.length = 0; });
const neutralFocus = (page: Page) => page.locator('body').click({ position: { x: 4, y: 4 } });

test('a song that plays to its end and the next one starting never flash Pause or Play (real media events)', async () => {
  const { app, window } = await openLibrary(box);
  await record(window);
  await playTrack(window, 'Alpha');
  await waitPlaying(window);
  await window.waitForTimeout(1600); // well past any start-up noise; this is NOT what the fix relies on
  await forget(window);
  // jump close to the end and let the element reach it by itself, after playing for longer than any grace period would cover
  await window.evaluate(() => { const a = document.getElementById('nova-audio') as HTMLAudioElement; a.currentTime = a.duration - 2.8; });
  await expect(title(window)).toHaveText('Bravo', { timeout: 15_000 });
  await waitPlaying(window);
  await window.waitForTimeout(1500);
  expect(await seen(window)).toEqual([]);
  // a real pause by the listener is still confirmed, and so is playing again
  await neutralFocus(window);
  await window.keyboard.press('Space');
  await expect(window.locator('.nx-hud-live')).toHaveText('Pause');
  await window.keyboard.press('Space');
  await expect(window.locator('.nx-hud-live')).toHaveText('Play');
  await app.close();
});

test('repeat one: the song restarting by itself shows no Pause or Play', async () => {
  const { app, window } = await openLibrary(box);
  await playTrack(window, 'Alpha');
  await waitPlaying(window);
  await neutralFocus(window);
  await window.keyboard.press('r'); // all
  await window.keyboard.press('r'); // one
  await expect(window.locator('.nx-hud-live')).toHaveText('Repeat this song');
  await record(window);
  await forget(window);
  await window.evaluate(() => { const a = document.getElementById('nova-audio') as HTMLAudioElement; a.currentTime = a.duration - 2.4; });
  await window.waitForTimeout(4500);
  expect(await seen(window)).toEqual([]);
  expect((await window.evaluate(() => (document.getElementById('nova-audio') as HTMLAudioElement).paused))).toBe(false);
  await app.close();
});

test('volume HUD shows for increases and decreases, for every control, with the right number and a full bar at 100', async () => {
  const { app, window } = await openLibrary(box);
  await playTrack(window, 'Alpha');
  await waitPlaying(window);
  const live = window.locator('.nx-hud-live');
  const card = window.getByTestId('hud-volume');
  await neutralFocus(window);
  // keys, focus elsewhere
  await window.keyboard.press('ArrowDown');
  await expect(live).toHaveText('Volume 95%');
  await window.keyboard.press('ArrowDown');
  await expect(live).toHaveText('Volume 90%');
  await window.keyboard.press('ArrowUp');
  await expect(live).toHaveText('Volume 95%');
  await window.keyboard.press('ArrowUp');
  await expect(live).toHaveText('Volume 100%');
  await expect(card).toHaveCSS('--v', '1');
  await expect(window.locator('.nx-hud')).toHaveAttribute('data-show', 'true');
  // pressed again at the maximum: it confirms the real level and does not pretend it went up
  await expect(window.locator('.nx-hud')).toHaveAttribute('data-show', 'false', { timeout: 5000 });
  await window.keyboard.press('ArrowUp');
  await expect(window.locator('.nx-hud')).toHaveAttribute('data-show', 'true');
  await expect(card).toHaveAttribute('data-dir', 'none');
  await expect(live).toHaveText('Volume 100%');
  // the slider keeps focus after a click on it: the keyboard still announces both directions
  const slider = window.getByTestId('player-volume');
  await slider.focus();
  await window.keyboard.press('ArrowDown');
  await expect(live).toHaveText('Volume 99%');
  await expect(card).toHaveAttribute('data-dir', 'down');
  await window.keyboard.press('ArrowUp');
  await expect(live).toHaveText('Volume 100%');
  await expect(card).toHaveAttribute('data-dir', 'up');
  // down to the minimum
  await window.keyboard.press('Home');
  await expect(live).toHaveText('Volume 0%');
  await expect(card).toHaveCSS('--v', '0');
  await window.keyboard.press('ArrowUp');
  await expect(live).toHaveText('Volume 1%');
  // the slider, the shortcut and the mute button agree on the same number
  await neutralFocus(window);
  await window.keyboard.press('m');
  await expect(live).toHaveText('Muted');
  await window.keyboard.press('ArrowUp'); // raising it un-mutes and shows the level
  await expect(live).toHaveText('Volume 6%');
  expect(await slider.inputValue()).toBe('6');
  await app.close();
});
