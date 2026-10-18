import { describe, expect, it, vi } from 'vitest';
import { createShellStateStore, DEFAULT_SHELL_STATE, sanitizeShellState, sanitizeWindowState, type ShellStateFileIo } from './shell-state.js';

const screen = [{ x: 0, y: 0, width: 1920, height: 1040 }];

describe('sanitizeWindowState', () => {
  it('keeps a valid size, position and maximized flag', () => {
    expect(sanitizeWindowState({ width: 900, height: 700, x: 100, y: 50, maximized: true }, screen)).toEqual({ width: 900, height: 700, x: 100, y: 50, maximized: true });
  });

  it('falls back to the defaults for anything that is not an object', () => {
    for (const raw of [undefined, null, 5, 'x', []]) expect(sanitizeWindowState(raw, screen).width).toBe(DEFAULT_SHELL_STATE.window.width);
  });

  it('clamps sizes to the window minimum and a sane maximum, and rejects non-integers', () => {
    expect(sanitizeWindowState({ width: 10, height: 10 }, screen)).toMatchObject({ width: 560, height: 480 });
    expect(sanitizeWindowState({ width: 10_000_000, height: 99_999 }, screen)).toMatchObject({ width: 10_000, height: 10_000 });
    expect(sanitizeWindowState({ width: 900.5, height: Number.NaN }, screen)).toMatchObject({ width: 1200, height: 800 });
  });

  it('drops a position that is off every display (a disconnected monitor) but keeps the size', () => {
    const state = sanitizeWindowState({ width: 900, height: 700, x: 5000, y: 5000 }, screen);
    expect(state).toEqual({ width: 900, height: 700, maximized: false });
    expect('x' in state).toBe(false);
  });

  it('drops a position where fewer than 100 px of the window is visible', () => {
    expect('x' in sanitizeWindowState({ width: 900, height: 700, x: 1900, y: 0 }, screen)).toBe(false);
    expect('x' in sanitizeWindowState({ width: 900, height: 700, x: 1800, y: 0 }, screen)).toBe(true);
  });

  it('accepts a position on a second display', () => {
    const two = [...screen, { x: 1920, y: 0, width: 1920, height: 1040 }];
    expect(sanitizeWindowState({ width: 900, height: 700, x: 2500, y: 100 }, two)).toMatchObject({ x: 2500, y: 100 });
  });

  it('maximized is only ever a real true', () => {
    expect(sanitizeWindowState({ maximized: 'yes' }, screen).maximized).toBe(false);
  });
});

describe('sanitizeShellState', () => {
  it('closeToTray defaults to FALSE (closing the window quits, as in Phases 0-6)', () => {
    expect(DEFAULT_SHELL_STATE.closeToTray).toBe(false);
    expect(sanitizeShellState({}, screen).closeToTray).toBe(false);
    expect(sanitizeShellState(null, screen)).toEqual(DEFAULT_SHELL_STATE);
    expect(sanitizeShellState(undefined, screen).closeToTray).toBe(false);
  });

  it('closeToTray is an opt-in: only a real boolean true enables it; anything else keeps the default', () => {
    expect(sanitizeShellState({ closeToTray: true }, screen).closeToTray).toBe(true);
    expect(sanitizeShellState({ closeToTray: false }, screen).closeToTray).toBe(false);
    for (const raw of ['true', 1, 'yes', null, {}, []]) expect(sanitizeShellState({ closeToTray: raw }, screen).closeToTray).toBe(false);
  });
});

function memoryIo(initial?: string): ShellStateFileIo & { files: Map<string, string> } {
  const files = new Map<string, string>();
  if (initial !== undefined) files.set('/state.json', initial);
  return { files, readFile: (p) => files.get(p), writeFileAtomic: (p, c) => void files.set(p, c) };
}

describe('createShellStateStore', () => {
  it('with no file, the loaded state has close-to-tray OFF; a saved opt-in round-trips', () => {
    const io = memoryIo();
    const store = createShellStateStore({ filePath: '/state.json', io, log: vi.fn() });
    expect(store.load(screen).closeToTray).toBe(false);
    store.save({ ...DEFAULT_SHELL_STATE, closeToTray: true });
    expect(store.load(screen).closeToTray).toBe(true);
  });

  it('returns the defaults when there is no file, without logging', () => {
    const log = vi.fn();
    expect(createShellStateStore({ filePath: '/state.json', io: memoryIo(), log }).load(screen)).toEqual(DEFAULT_SHELL_STATE);
    expect(log).not.toHaveBeenCalled();
  });

  it('round-trips a saved state', () => {
    const io = memoryIo();
    const store = createShellStateStore({ filePath: '/state.json', io, log: vi.fn() });
    const state = { window: { width: 800, height: 600, x: 10, y: 20, maximized: true }, closeToTray: false };
    store.save(state);
    expect(store.load(screen)).toEqual(state);
  });

  it('a corrupt file yields the defaults and is reported, not thrown', () => {
    const log = vi.fn();
    expect(createShellStateStore({ filePath: '/state.json', io: memoryIo('{nope'), log }).load(screen)).toEqual(DEFAULT_SHELL_STATE);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('a read error yields the defaults and is reported', () => {
    const log = vi.fn();
    const io: ShellStateFileIo = { readFile: () => { throw new Error('EACCES'); }, writeFileAtomic: vi.fn() };
    expect(createShellStateStore({ filePath: '/s', io, log }).load(screen)).toEqual(DEFAULT_SHELL_STATE);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('a failed save is reported and never thrown', () => {
    const log = vi.fn();
    const io: ShellStateFileIo = { readFile: () => undefined, writeFileAtomic: () => { throw new Error('disk full'); } };
    expect(() => createShellStateStore({ filePath: '/s', io, log }).save(DEFAULT_SHELL_STATE)).not.toThrow();
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('a hand-edited off-screen file cannot strand the window', () => {
    const io = memoryIo(JSON.stringify({ window: { width: 900, height: 700, x: -9000, y: -9000 } }));
    const loaded = createShellStateStore({ filePath: '/state.json', io, log: vi.fn() }).load(screen);
    expect('x' in loaded.window).toBe(false);
  });
});
