import { describe, expect, it, vi } from 'vitest';
import { createAppShell } from './app-shell.js';

function setup() {
  const order: string[] = [];
  const windows = {
    show: vi.fn(() => { order.push('window.show'); return {} as never; }),
    current: vi.fn(),
    beginQuit: vi.fn(() => { order.push('window.beginQuit'); }),
    isQuitting: vi.fn(),
    saveState: vi.fn(),
    preferences: { closeToTray: () => true },
    dispose: vi.fn(() => { order.push('window.dispose'); }),
  };
  const tray = { start: vi.fn(() => { order.push('tray.start'); return true; }), isActive: vi.fn(), menu: vi.fn(), dispose: vi.fn(() => { order.push('tray.dispose'); }) };
  const mediaKeys = { start: vi.fn(() => { order.push('keys.start'); return { registered: [], failed: [] }; }), dispose: vi.fn(() => { order.push('keys.dispose'); }) };
  const notifier = { start: vi.fn(() => { order.push('notifier.start'); }), dispose: vi.fn(() => { order.push('notifier.dispose'); }), history: vi.fn(() => []) };
  const shell = createAppShell({ windows, tray, mediaKeys, notifier, dispatch: vi.fn(() => true) });
  return { shell, windows, tray, mediaKeys, notifier, order };
}

describe('app shell', () => {
  it('start() brings up the window first, then the tray, the media keys, then the notifications', () => {
    const { shell, order } = setup();
    shell.start();
    expect(order).toEqual(['window.show', 'tray.start', 'keys.start', 'notifier.start']);
  });

  it('repeated start() (startup, window recreation) initialises nothing twice', () => {
    const { shell, windows, tray, mediaKeys, notifier } = setup();
    shell.start();
    shell.start();
    shell.start();
    expect(notifier.start).toHaveBeenCalledTimes(1);
    expect(windows.show).toHaveBeenCalledTimes(1);
    expect(tray.start).toHaveBeenCalledTimes(1);
    expect(mediaKeys.start).toHaveBeenCalledTimes(1);
  });

  it('show() goes through the one window manager', () => {
    const { shell, windows } = setup();
    shell.start();
    shell.show();
    expect(windows.show).toHaveBeenCalledTimes(2);
  });

  it('dispose() stops notifications, releases media keys, then tray, then window state - once, however often it is called', () => {
    const { shell, order, windows, tray, mediaKeys } = setup();
    shell.start();
    order.length = 0;
    shell.dispose();
    shell.dispose();
    expect(order).toEqual(['notifier.dispose', 'keys.dispose', 'tray.dispose', 'window.dispose']);
    expect(mediaKeys.dispose).toHaveBeenCalledTimes(1);
    expect(tray.dispose).toHaveBeenCalledTimes(1);
    expect(windows.dispose).toHaveBeenCalledTimes(1);
  });

  it('after dispose() nothing comes back: no show, no start', () => {
    const { shell, windows, tray } = setup();
    shell.start();
    shell.dispose();
    windows.show.mockClear();
    shell.show();
    expect(windows.show).not.toHaveBeenCalled();
    const second = setup();
    second.shell.dispose();
    second.shell.start();
    expect(second.tray.start).not.toHaveBeenCalled();
    void tray;
  });

  it('beginQuit() tells the window manager that a close is now a real close', () => {
    const { shell, windows } = setup();
    shell.beginQuit();
    expect(windows.beginQuit).toHaveBeenCalledTimes(1);
  });
});
