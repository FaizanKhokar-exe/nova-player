import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IPC_EVENT_CHANNELS, IPC_INVOKE_CHANNELS } from '@nova/shared';

const sharedSource = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../packages/shared/src/playback-ipc.ts');

describe('the playback IPC contract', () => {
  it('lists every playback channel exactly once, plus its event', () => {
    const playback = IPC_INVOKE_CHANNELS.filter((c) => c.startsWith('playback:') || c.startsWith('track:'));
    expect(playback).toEqual([
      'playback:getState',
      'playback:playTrack',
      'playback:next',
      'playback:previous',
      'playback:trackFinished',
      'playback:setRepeatMode',
      'playback:setShuffle',
      'playback:reportPosition',
      'playback:diagnoseSource',
      // Phase 5: queue view, queue editing and group playback
      'playback:playGroup',
      'playback:enqueue',
      'playback:getQueue',
      'playback:playQueueItem',
      'playback:removeFromQueue',
      'playback:moveQueueItem',
      'playback:clearQueue',
      // Phase 6: per-track lyrics and artwork
      'track:getLyrics',
      'track:getArtwork',
      // Phase 10: attach a .lrc by hand (main shows the file dialog; the renderer never names a path) and remove it again
      'track:attachLyrics',
      'track:detachLyrics',
      'track:attachArtwork',
      'track:detachArtwork',
      // Phase 11: play a whole list (favourites / history / playlist) and cover thumbnails
      'playback:playList',
      'track:getThumbnail',
    ]);
    expect(new Set(IPC_INVOKE_CHANNELS).size).toBe(IPC_INVOKE_CHANNELS.length);
    expect(IPC_EVENT_CHANNELS).toContain('playback:stateChanged');
  });

  it('declares no field that could carry a file path or file system detail', () => {
    const source = fs.readFileSync(sharedSource, 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/\b\w*(path|Path|file|File|directory|Dir|absolute)\w*\??\s*:/);
  });

  it('the Phase 5/6/11 browse, queue, lyrics, artwork and collections contracts declare no path-like field either', () => {
    for (const name of ['browse-ipc.ts', 'track-detail-ipc.ts', 'collections-ipc.ts']) {
      const file = path.resolve(path.dirname(sharedSource), name);
      const code = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(code, name).not.toMatch(/\b\w*(path|Path|file|File|directory|Dir|absolute)\w*\??\s*:/);
      expect(code, name).not.toMatch(/^import(?! type)/m); // plain data: no runtime imports
    }
  });

  it('every position in the contract is milliseconds, never seconds', () => {
    const source = fs.readFileSync(sharedSource, 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect([...code.matchAll(/\b(\w*[pP]osition\w*)\??\s*:/g)].map((m) => m[1])).toSatisfy((names: (string | undefined)[]) => names.every((n) => n?.endsWith('Ms')));
    expect(code).not.toMatch(/\b\w*Seconds?\b\s*:/);
  });
});
