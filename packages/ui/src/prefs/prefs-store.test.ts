import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFS, createPrefsStore, snapSpeed } from './prefs-store.js';

const memory = (initial?: string) => {
  const data = new Map<string, string>();
  if (initial !== undefined) data.set('nova.prefs.v1', initial);
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
};

describe('prefs store', () => {
  it('starts from sensible defaults', () => {
    const s = createPrefsStore(memory()).getState();
    expect(s.eqEnabled).toBe(false);
    expect(s.speed).toBe(1);
    expect(s.performance).toBe('auto');
    expect(s.wallpaperDim).toBeGreaterThan(0); // text stays readable on a wallpaper by default
    expect(s.lyricsBackdrop).toBe('particles');
  });
  it('lyrics: Apple by default, sung lines dim, and a saved Magnet becomes Apple', () => {
    const fresh = createPrefsStore(memory()).getState();
    expect(fresh.lyricsAnimation).toBe('apple');
    expect(fresh.sungLines).toBe('dim');
    const old = createPrefsStore(memory(JSON.stringify({ lyricsAnimation: 'magnet', sungLines: 'nonsense' }))).getState();
    expect(old.lyricsAnimation).toBe('apple');
    expect(old.sungLines).toBe('dim');
    const storage = memory();
    createPrefsStore(storage).getState().setSungLines('hide');
    expect(createPrefsStore(storage).getState().sungLines).toBe('hide');
  });
  it('persists and reloads', () => {
    const storage = memory();
    const a = createPrefsStore(storage);
    a.getState().setSpeed(1.25);
    a.getState().setEqBand(0, 20);
    a.getState().setWallpaperBlur(999);
    const b = createPrefsStore(storage).getState();
    expect(b.speed).toBe(1.25);
    expect(b.eqGains[0]).toBe(12);
    expect(b.wallpaperBlur).toBe(40);
  });
  it('sanitises corrupt storage field by field', () => {
    const s = createPrefsStore(memory(JSON.stringify({ speed: 'fast', eqGains: [1, 2], visualizer: 'x', wallpaperDim: 5000, performance: 'low' }))).getState();
    expect(s.speed).toBe(1);
    expect(s.eqGains).toEqual(DEFAULT_PREFS.eqGains);
    expect(s.visualizer).toBe('bars');
    expect(s.wallpaperDim).toBe(90);
    expect(s.performance).toBe('low');
    expect(createPrefsStore(memory('not json')).getState().speed).toBe(1);
  });
  it('survives storage that throws', () => {
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    const store = createPrefsStore(broken);
    expect(() => store.getState().setSpeed(1.5)).not.toThrow();
    expect(store.getState().speed).toBe(1.5);
  });
  it('snaps speed and resets', () => {
    expect(snapSpeed(1.2)).toBe(1.25);
    expect(snapSpeed(Number.NaN)).toBe(1);
    const store = createPrefsStore(memory());
    store.getState().setSpeed(2);
    store.getState().resetAll();
    expect(store.getState().speed).toBe(1);
  });
});
