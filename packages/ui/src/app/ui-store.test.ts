import { describe, expect, it } from 'vitest';
import { createUiStore } from './ui-store.js';

describe('ui store navigation', () => {
  it('pushes, goes back and forward, and truncates forward history on a new navigation', () => {
    const s = createUiStore();
    s.getState().navigate({ name: 'songs' });
    s.getState().navigate({ name: 'albums' });
    expect(s.getState().route.name).toBe('albums');
    s.getState().back();
    expect(s.getState().route.name).toBe('songs');
    expect(s.getState().canForward()).toBe(true);
    s.getState().forward();
    expect(s.getState().route.name).toBe('albums');
    s.getState().back();
    s.getState().navigate({ name: 'favorites' });
    expect(s.getState().canForward()).toBe(false);
    expect(s.getState().history.map((r) => r.name)).toEqual(['home', 'songs', 'favorites']);
  });
  it('does not stack the same page twice, and back at the start does nothing', () => {
    const s = createUiStore();
    s.getState().navigate({ name: 'home' });
    expect(s.getState().history).toHaveLength(1);
    s.getState().back();
    expect(s.getState().route.name).toBe('home');
    s.getState().navigate({ name: 'group', kind: 'album', key: 'a' });
    s.getState().navigate({ name: 'group', kind: 'album', key: 'b' });
    expect(s.getState().history).toHaveLength(3);
  });
  it('navigating closes Now Playing and transient layers', () => {
    const s = createUiStore();
    s.getState().openNowPlaying('lyrics');
    s.getState().openMenu({ x: 1, y: 1, items: [] });
    expect(s.getState().nowPlayingLayout).toBe('lyrics');
    s.getState().navigate({ name: 'settings' });
    expect(s.getState().nowPlayingOpen).toBe(false);
    expect(s.getState().menu).toBeUndefined();
  });
  it('a modal replaces an open menu; bounded history', () => {
    const s = createUiStore();
    s.getState().openMenu({ x: 0, y: 0, items: [] });
    s.getState().openModal({ kind: 'create-playlist', trackIds: [] });
    expect(s.getState().menu).toBeUndefined();
    for (let i = 0; i < 100; i += 1) s.getState().navigate({ name: 'playlist', id: `p${i}` });
    expect(s.getState().history.length).toBeLessThanOrEqual(60);
  });
});
