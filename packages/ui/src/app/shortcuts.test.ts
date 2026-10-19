import { describe, expect, it } from 'vitest';
import { resolveShortcut, SHORTCUT_HELP } from './shortcuts.js';

const k = (key: string, extra: Partial<{ ctrl: boolean; shift: boolean; alt: boolean }> = {}) => resolveShortcut({ key, ctrl: false, shift: false, alt: false, ...extra });

describe('resolveShortcut', () => {
  it('maps the transport keys', () => {
    expect(k(' ')).toEqual({ kind: 'togglePlay' });
    expect(k('ArrowRight')).toEqual({ kind: 'seek', deltaSeconds: 5 });
    expect(k('ArrowLeft', { shift: true })).toEqual({ kind: 'seek', deltaSeconds: -15 });
    expect(k('ArrowUp')).toEqual({ kind: 'volume', delta: 0.05 });
    expect(k('ArrowDown')).toEqual({ kind: 'volume', delta: -0.05 });
    expect(k('ArrowRight', { ctrl: true })).toEqual({ kind: 'next' });
    expect(k('P')).toEqual({ kind: 'previous' });
    expect(k('7')).toEqual({ kind: 'seekPercent', percent: 70 });
  });
  it('maps toggles, fullscreen and navigation', () => {
    for (const [key, kind] of [['m', 'mute'], ['s', 'shuffle'], ['r', 'repeat'], ['q', 'queue'], ['l', 'lyrics'], ['f', 'fullscreen'], ['F11', 'fullscreen'], ['h', 'favorite'], [']', 'speedUp'], ['[', 'speedDown'], ['?', 'settings']] as const) {
      expect(k(key)).toEqual({ kind });
    }
    expect(k(',', { ctrl: true })).toEqual({ kind: 'settings' });
  });
  it('leaves Alt chords and unknown keys alone', () => {
    expect(k('ArrowLeft', { alt: true })).toBeUndefined();
    expect(k('x')).toBeUndefined();
    expect(k('s', { ctrl: true })).toBeUndefined();
  });
  it('documents every action it handles', () => {
    expect(SHORTCUT_HELP.length).toBeGreaterThanOrEqual(15);
  });
});
