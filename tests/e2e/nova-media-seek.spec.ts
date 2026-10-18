import { test, expect } from '@playwright/test';
import { launchApp } from './helpers.js';

interface NovaMediaResponseRecord {
  url: string;
  status: number;
  requestRange: string | null;
  contentRange: string | null;
  contentLength: string | null;
  acceptRanges: string | null;
}

/**
 * Validation item J / objective I - the real fix.
 *
 * Phase 0's first attempt at this test found that delegating to net.fetch()
 * on a file:// URL does not set 206/Content-Range/Accept-Ranges, even though
 * it does slice the response body - so every request "succeeded" but the
 * browser never learned the resource was actually range-seekable. The
 * protocol handler now constructs these HTTP semantics by hand (see
 * nova-media-protocol.ts). This test exercises the REAL renderer/audio
 * pipeline end to end - a real <audio> element, real network responses
 * inspected via Playwright's page.on('response'), real seeking, and a real
 * attempt at continued playback - not a Node-side call into the handler
 * function (that logic is covered separately and more exhaustively by
 * nova-media-protocol.test.ts's unit/integration tests).
 *
 * One honest scope note: this container has no real audio output hardware.
 * Chromium is given a dummy/null audio sink. `audio.play()` and subsequent
 * time progression are exercised for real and asserted on below; if the
 * dummy sink ever prevented the play() promise from resolving or currentTime
 * from advancing, that would show up as a real, reported test failure here,
 * not something silently skipped.
 */
test('nova-media:// serves real 206 range responses and supports seeking + continued playback', async () => {
  const { app, window } = await launchApp();

  const novaMediaResponses: NovaMediaResponseRecord[] = [];
  window.on('response', (response) => {
    if (response.url().startsWith('nova-media://')) {
      const req = response.request();
      novaMediaResponses.push({
        url: response.url(),
        status: response.status(),
        requestRange: req.headers()['range'] ?? null,
        contentRange: response.headers()['content-range'] ?? null,
        contentLength: response.headers()['content-length'] ?? null,
        acceptRanges: response.headers()['accept-ranges'] ?? null,
      });
    }
  });

  const { url: mediaUrl, absolutePath } = await window.evaluate(() =>
    window.nova.invoke('diagnostics:getSeekSpikeMediaUrl', undefined),
  );
  expect(absolutePath.endsWith('seek-spike.mp3')).toBe(true);

  // --- Load through a real <audio> element ---
  const { duration } = await window.evaluate(async (src) => {
    return new Promise<{ duration: number }>((resolve, reject) => {
      const audio = document.createElement('audio');
      audio.preload = 'metadata';
      audio.src = src;
      audio.addEventListener('loadedmetadata', () => resolve({ duration: audio.duration }), {
        once: true,
      });
      audio.addEventListener(
        'error',
        () => reject(new Error(`audio failed to load: ${String(audio.error?.message)}`)),
        { once: true },
      );
      document.body.appendChild(audio);
      (window as unknown as { __novaSpikeAudio: HTMLAudioElement }).__novaSpikeAudio = audio;
    });
  }, mediaUrl);

  // Fixture is a 60s file - loose bound to avoid coupling to ffmpeg's exact
  // reported duration.
  expect(duration).toBeGreaterThan(50);
  expect(duration).toBeLessThan(70);

  await window.waitForTimeout(200);
  const responsesAfterLoad = [...novaMediaResponses];
  expect(responsesAfterLoad.length).toBeGreaterThan(0);

  // The real fix under test: the initial load's response(s) must actually
  // be proper 206 Partial Content responses with correct Range semantics,
  // not a 200 "here's the whole file" response mislabeled as complete.
  const initialRangedResponse = responsesAfterLoad.find((r) => r.requestRange !== null);
  expect(initialRangedResponse).toBeDefined();
  expect(initialRangedResponse?.status).toBe(206);
  expect(initialRangedResponse?.acceptRanges).toBe('bytes');
  expect(initialRangedResponse?.contentRange).toMatch(/^bytes 0-\d+\/\d+$/);

  // --- Seek near the end: well beyond anything already buffered ---
  const seekTarget = duration - 5;
  await window.evaluate(async (target) => {
    return new Promise<void>((resolve, reject) => {
      const audio = (window as unknown as { __novaSpikeAudio: HTMLAudioElement }).__novaSpikeAudio;
      audio.addEventListener('seeked', () => resolve(), { once: true });
      audio.addEventListener('error', () => reject(new Error('seek failed')), { once: true });
      audio.currentTime = target;
    });
  }, seekTarget);

  await window.waitForTimeout(500);

  expect(novaMediaResponses.length).toBeGreaterThan(responsesAfterLoad.length);

  const newResponsesAfterSeek = novaMediaResponses.slice(responsesAfterLoad.length);
  const seekRangedResponses = newResponsesAfterSeek.filter((r) => r.requestRange !== null);
  const seekPartialContentResponses = newResponsesAfterSeek.filter((r) => r.status === 206);

  expect(seekRangedResponses.length).toBeGreaterThan(0);
  expect(seekPartialContentResponses.length).toBeGreaterThan(0);

  // The post-seek request must be for a genuinely different byte range, not
  // a repeat of "from the start" - proving the browser understood the first
  // response as partial (thanks to the 206 + Content-Range) and is now
  // asking for a different slice instead of assuming it already has
  // everything.
  const seekResponse = seekPartialContentResponses[0];
  expect(seekResponse?.contentRange).toBeTruthy();
  const seekStartByte = Number(seekResponse?.contentRange?.match(/^bytes (\d+)-/)?.[1]);
  expect(seekStartByte).toBeGreaterThan(0);

  // --- Verify playback actually continues after seeking ---
  const playbackResult = await window.evaluate(async () => {
    const audio = (window as unknown as { __novaSpikeAudio: HTMLAudioElement }).__novaSpikeAudio;
    const timeBeforePlay = audio.currentTime;
    try {
      await audio.play();
    } catch (error) {
      return { playCallSucceeded: false, error: String(error), timeBeforePlay, timeAfterWait: audio.currentTime, paused: audio.paused };
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return {
      playCallSucceeded: true,
      error: null,
      timeBeforePlay,
      timeAfterWait: audio.currentTime,
      paused: audio.paused,
    };
  });

  console.log('[nova-media spike] playback result:', JSON.stringify(playbackResult, null, 2));
  console.log('[nova-media spike] all responses:', JSON.stringify(novaMediaResponses, null, 2));

  expect(playbackResult.playCallSucceeded).toBe(true);
  expect(playbackResult.paused).toBe(false);
  expect(playbackResult.timeAfterWait).toBeGreaterThan(playbackResult.timeBeforePlay);

  await app.close();
});
