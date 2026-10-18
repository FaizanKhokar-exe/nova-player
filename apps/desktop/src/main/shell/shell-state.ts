/**
 * Phase 7: the little bit of state the desktop shell remembers between runs - the window's size,
 * position and maximized flag, and the close-to-tray choice. It is one small JSON file in the
 * per-user app-data folder, read and written ONLY by the main process. It is deliberately not in
 * the library database: the database schema is migration-owned (migration 4 is immutable) and
 * two window-shell preferences do not justify a migration. There is no settings screen yet
 * (later work), so `closeToTray` has no UI; it is a stored opt-in whose default keeps the established
 * behaviour (closing the window quits).
 *
 * Whatever is read from disk is untrusted: a hand-edited or corrupt file must never produce a
 * window that is off-screen, tiny, or enormous.
 */

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface WindowState {
  readonly width: number;
  readonly height: number;
  /** Absent when no valid position is known: the OS then places (centres) the window. */
  readonly x?: number;
  readonly y?: number;
  readonly maximized: boolean;
}

export interface ShellState {
  readonly window: WindowState;
  /**
   * Opt-in: closing the window hides it to the tray (when a tray exists) instead of quitting.
   * The default is `false` - closing the window quits, as in Phases 0-6. There is no settings screen
   * yet, so nothing in the UI changes this; it is only honoured if `shell-state.json` says `true`.
   */
  readonly closeToTray: boolean;
}

export const WINDOW_MIN_WIDTH = 560;
export const WINDOW_MIN_HEIGHT = 480;
const WINDOW_MAX_SIZE = 10_000;
/** At least this much of the window must be on a display, in each direction, for its position to be kept. */
const MIN_VISIBLE_PX = 100;

export const DEFAULT_SHELL_STATE: ShellState = {
  window: { width: 1200, height: 800, maximized: false },
  closeToTray: false,
};

const isInt = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

function overlap(a: Rect, b: Rect): { readonly w: number; readonly h: number } {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return { w, h };
}

/** Turns whatever was read from disk into a window state that is safe to open a window with. */
export function sanitizeWindowState(raw: unknown, displays: readonly Rect[]): WindowState {
  const fallback = DEFAULT_SHELL_STATE.window;
  if (typeof raw !== 'object' || raw === null) return fallback;
  const record = raw as Record<string, unknown>;
  const width = isInt(record.width) ? clamp(record.width, WINDOW_MIN_WIDTH, WINDOW_MAX_SIZE) : fallback.width;
  const height = isInt(record.height) ? clamp(record.height, WINDOW_MIN_HEIGHT, WINDOW_MAX_SIZE) : fallback.height;
  const maximized = record.maximized === true;
  if (isInt(record.x) && isInt(record.y)) {
    const rect: Rect = { x: record.x, y: record.y, width, height };
    // Kept only if enough of the window is on a display that exists now (a disconnected monitor must not strand it).
    const visible = displays.some((display) => {
      const { w, h } = overlap(rect, display);
      return w >= MIN_VISIBLE_PX && h >= MIN_VISIBLE_PX;
    });
    if (visible) return { width, height, x: record.x, y: record.y, maximized };
  }
  return { width, height, maximized };
}

export function sanitizeShellState(raw: unknown, displays: readonly Rect[]): ShellState {
  const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    window: sanitizeWindowState(record.window, displays),
    closeToTray: typeof record.closeToTray === 'boolean' ? record.closeToTray : DEFAULT_SHELL_STATE.closeToTray,
  };
}

/** The slice of the filesystem the store uses. Injected so the store is testable without disk. */
export interface ShellStateFileIo {
  readFile(filePath: string): string | undefined; // undefined = does not exist
  /** Writes atomically (temp file + rename), creating the folder if needed. */
  writeFileAtomic(filePath: string, contents: string): void;
}

export interface ShellStateStore {
  load(displays: readonly Rect[]): ShellState;
  save(state: ShellState): void;
}

export function createShellStateStore(options: {
  readonly filePath: string;
  readonly io: ShellStateFileIo;
  readonly log: (message: string, error: unknown) => void;
}): ShellStateStore {
  const { filePath, io, log } = options;
  return {
    load(displays) {
      let text: string | undefined;
      try {
        text = io.readFile(filePath);
      } catch (error) {
        log('[nova] could not read the window state (using defaults):', error);
        return DEFAULT_SHELL_STATE;
      }
      if (text === undefined) return DEFAULT_SHELL_STATE;
      try {
        return sanitizeShellState(JSON.parse(text) as unknown, displays);
      } catch (error) {
        log('[nova] the window state file is not valid JSON (using defaults):', error);
        return DEFAULT_SHELL_STATE;
      }
    },
    save(state) {
      try {
        io.writeFileAtomic(filePath, `${JSON.stringify(state, null, 2)}\n`);
      } catch (error) {
        // Losing a window position is never worth interrupting the user; it is reported, not thrown.
        log('[nova] could not save the window state:', error);
      }
    },
  };
}
