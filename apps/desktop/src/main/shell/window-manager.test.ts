import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SHELL_STATE, type ShellState, type ShellStateStore } from './shell-state.js';
import { createWindowManager, type ManagedWindow } from './window-manager.js';

class FakeWindow implements ManagedWindow {
  destroyed = false;
  minimized = false;
  visible = false;
  maximized = false;
  bounds = { x: 10, y: 20, width: 900, height: 700 };
  calls: string[] = [];
  private listeners: Record<string, Array<(event: { preventDefault(): void }) => void>> = {};
  isDestroyed = () => this.destroyed;
  isMinimized = () => this.minimized;
  isVisible = () => this.visible;
  isMaximized = () => this.maximized;
  getNormalBounds = () => this.bounds;
  restore = () => { this.calls.push('restore'); this.minimized = false; };
  show = () => { this.calls.push('show'); this.visible = true; };
  hide = () => { this.calls.push('hide'); this.visible = false; };
  focus = () => { this.calls.push('focus'); };
  on(event: 'close' | 'closed', listener: never): void {
    (this.listeners[event] ??= []).push(listener);
  }
  listenerCount = (event: string): number => (this.listeners[event] ?? []).length;
  /** Emulates the OS closing the window: returns whether a handler prevented it. */
  close(): boolean {
    let prevented = false;
    for (const listener of this.listeners.close ?? []) listener({ preventDefault: () => { prevented = true; } });
    if (!prevented) {
      this.destroyed = true;
      for (const listener of this.listeners.closed ?? []) listener({ preventDefault: () => undefined });
    }
    return prevented;
  }
}

function setup(options: { hide?: boolean; state?: ShellState } = {}) {
  const windows: FakeWindow[] = [];
  const saved: ShellState[] = [];
  const stateStore: ShellStateStore = { load: () => options.state ?? DEFAULT_SHELL_STATE, save: (s) => void saved.push(s) };
  const hideRef = { value: options.hide ?? true };
  const createWindow = vi.fn(() => { const w = new FakeWindow(); windows.push(w); return w; });
  const log = vi.fn();
  const manager = createWindowManager({ createWindow, stateStore, displays: () => [], shouldHideOnClose: () => hideRef.value, log });
  return { manager, windows, saved, createWindow, hideRef, log };
}

describe('window manager', () => {
  it('creates the window from the remembered state, once', () => {
    const { manager, createWindow } = setup({ state: { window: { width: 700, height: 600, maximized: false }, closeToTray: true } });
    manager.show();
    manager.show();
    expect(createWindow).toHaveBeenCalledTimes(1);
    expect(createWindow).toHaveBeenCalledWith({ width: 700, height: 600, maximized: false });
  });

  it('show() shows a hidden window, restores a minimized one, and always focuses - never creating a second', () => {
    const { manager, windows, createWindow } = setup();
    manager.show();
    const win = windows[0]!;
    win.calls = [];
    win.visible = true;
    win.minimized = true;
    manager.show();
    expect(win.calls).toEqual(['restore', 'focus']);
    win.calls = [];
    win.visible = false;
    manager.show();
    expect(win.calls).toEqual(['show', 'focus']);
    expect(createWindow).toHaveBeenCalledTimes(1);
  });

  it('closing hides the window to the tray (and remembers its geometry) while the tray policy is on', () => {
    const { manager, windows, saved } = setup();
    manager.show();
    const win = windows[0]!;
    expect(win.close()).toBe(true);
    expect(win.visible).toBe(false);
    expect(win.destroyed).toBe(false);
    expect(manager.current()).toBe(win);
    expect(saved.at(-1)?.window).toEqual({ width: 900, height: 700, x: 10, y: 20, maximized: false });
  });

  it('the hidden window comes back through show() as the SAME window', () => {
    const { manager, windows, createWindow } = setup();
    const first = manager.show();
    windows[0]!.close();
    expect(manager.show()).toBe(first);
    expect(windows[0]!.visible).toBe(true);
    expect(createWindow).toHaveBeenCalledTimes(1);
  });

  it('with the default preferences, the window manager reports close-to-tray OFF (close quits)', () => {
    const { manager } = setup();
    expect(manager.preferences.closeToTray()).toBe(false);
  });

  it('an opted-in preference is what the manager reports (the policy callback decides with the tray)', () => {
    const { manager } = setup({ state: { ...DEFAULT_SHELL_STATE, closeToTray: true } });
    expect(manager.preferences.closeToTray()).toBe(true);
  });

  it('closing really closes when there is no tray (or the preference is off)', () => {
    const { manager, windows, hideRef } = setup({ hide: false });
    manager.show();
    expect(windows[0]!.close()).toBe(false);
    expect(windows[0]!.destroyed).toBe(true);
    expect(manager.current()).toBeUndefined();
    hideRef.value = true;
  });

  it('after beginQuit() a close is never prevented, even with a tray', () => {
    const { manager, windows } = setup();
    manager.show();
    manager.beginQuit();
    expect(manager.isQuitting()).toBe(true);
    expect(windows[0]!.close()).toBe(false);
    expect(windows[0]!.destroyed).toBe(true);
  });

  it('a window recreated after a real close gets its own single set of listeners (no leak, no duplicate)', () => {
    const { manager, windows, createWindow } = setup({ hide: false });
    manager.show();
    windows[0]!.close();
    manager.show();
    manager.show();
    expect(createWindow).toHaveBeenCalledTimes(2);
    expect(windows[1]!.listenerCount('close')).toBe(1);
    expect(windows[1]!.listenerCount('closed')).toBe(1);
    expect(windows[0]!.listenerCount('close')).toBe(1);
  });

  it('records maximized state and the normal (not maximized) bounds', () => {
    const { manager, windows, saved } = setup();
    manager.show();
    windows[0]!.maximized = true;
    manager.saveState();
    expect(saved.at(-1)?.window.maximized).toBe(true);
    expect(saved.at(-1)?.window.width).toBe(900);
  });

  it('dispose() saves once, is idempotent, and refuses to create a window afterwards', () => {
    const { manager, saved } = setup();
    manager.show();
    manager.dispose();
    const count = saved.length;
    manager.dispose();
    expect(saved.length).toBe(count);
    expect(() => manager.show()).toThrow();
  });

  it('a window that fails to focus is reported, not thrown', () => {
    const { manager, windows, log } = setup();
    manager.show();
    windows[0]!.focus = () => { throw new Error('boom'); };
    expect(() => manager.show()).not.toThrow();
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('does not save state for a window that is already destroyed', () => {
    const { manager, windows, saved } = setup();
    manager.show();
    windows[0]!.destroyed = true;
    const before = saved.length;
    manager.saveState();
    expect(saved.length).toBe(before);
  });
});
