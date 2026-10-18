import { describe, expect, it, vi } from 'vitest';
import { createMediaKeys, MEDIA_KEY_BINDINGS, type GlobalShortcutPort } from './media-keys.js';

function fakeShortcuts(refused: readonly string[] = []) {
  const callbacks = new Map<string, () => void>();
  const port: GlobalShortcutPort & { callbacks: Map<string, () => void>; register: ReturnType<typeof vi.fn>; unregister: ReturnType<typeof vi.fn> } = {
    callbacks,
    register: vi.fn((accelerator: string, callback: () => void) => {
      if (refused.includes(accelerator)) return false;
      callbacks.set(accelerator, callback);
      return true;
    }),
    unregister: vi.fn((accelerator: string) => void callbacks.delete(accelerator)),
    isRegistered: (accelerator: string) => callbacks.has(accelerator),
  };
  return port;
}

describe('media keys', () => {
  it('binds exactly Play/Pause, Next and Previous to the three player commands', () => {
    expect(MEDIA_KEY_BINDINGS.map((b) => [b.accelerator, b.command])).toEqual([
      ['MediaPlayPause', 'toggle-play'],
      ['MediaNextTrack', 'next'],
      ['MediaPreviousTrack', 'previous'],
    ]);
  });

  it('registers all three and each key dispatches ITS command', () => {
    const shortcuts = fakeShortcuts();
    const dispatch = vi.fn();
    const keys = createMediaKeys({ globalShortcut: shortcuts, dispatch, log: vi.fn() });
    expect(keys.start()).toEqual({ registered: ['MediaPlayPause', 'MediaNextTrack', 'MediaPreviousTrack'], failed: [] });
    shortcuts.callbacks.get('MediaPlayPause')!();
    shortcuts.callbacks.get('MediaNextTrack')!();
    shortcuts.callbacks.get('MediaPreviousTrack')!();
    expect(dispatch.mock.calls).toEqual([['toggle-play'], ['next'], ['previous']]);
  });

  it('repeated start() registers nothing twice', () => {
    const shortcuts = fakeShortcuts();
    const keys = createMediaKeys({ globalShortcut: shortcuts, dispatch: vi.fn(), log: vi.fn() });
    const first = keys.start();
    expect(keys.start()).toBe(first);
    keys.start();
    expect(shortcuts.register).toHaveBeenCalledTimes(3);
  });

  it('a key another application owns is reported as failed; the others still work', () => {
    const shortcuts = fakeShortcuts(['MediaNextTrack']);
    const log = vi.fn();
    const keys = createMediaKeys({ globalShortcut: shortcuts, dispatch: vi.fn(), log });
    expect(keys.start()).toEqual({ registered: ['MediaPlayPause', 'MediaPreviousTrack'], failed: ['MediaNextTrack'] });
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('a platform that throws on register is contained and logged', () => {
    const shortcuts = fakeShortcuts();
    shortcuts.register.mockImplementation(() => { throw new Error('unsupported'); });
    const log = vi.fn();
    const keys = createMediaKeys({ globalShortcut: shortcuts, dispatch: vi.fn(), log });
    expect(keys.start()).toEqual({ registered: [], failed: ['MediaPlayPause', 'MediaNextTrack', 'MediaPreviousTrack'] });
    expect(log).toHaveBeenCalledTimes(3);
  });

  it('dispose() unregisters exactly what it registered - not a key it failed to get - and is idempotent', () => {
    const shortcuts = fakeShortcuts(['MediaNextTrack']);
    const keys = createMediaKeys({ globalShortcut: shortcuts, dispatch: vi.fn(), log: vi.fn() });
    keys.start();
    keys.dispose();
    keys.dispose();
    expect(shortcuts.unregister.mock.calls.map((c) => c[0]).sort()).toEqual(['MediaPlayPause', 'MediaPreviousTrack']);
    expect(shortcuts.callbacks.size).toBe(0);
  });

  it('a failing unregister is logged and does not stop the others', () => {
    const shortcuts = fakeShortcuts();
    shortcuts.unregister.mockImplementationOnce(() => { throw new Error('x'); });
    const log = vi.fn();
    const keys = createMediaKeys({ globalShortcut: shortcuts, dispatch: vi.fn(), log });
    keys.start();
    keys.dispose();
    expect(shortcuts.unregister).toHaveBeenCalledTimes(3);
    expect(log).toHaveBeenCalledTimes(1);
  });
});
