/** Pure keyboard-shortcut mapping (no DOM, no stores): the key handler and the Settings list both read this, so they cannot drift apart. */

export type ShortcutAction =
  | { readonly kind: 'togglePlay' | 'next' | 'previous' | 'mute' | 'shuffle' | 'repeat' | 'queue' | 'lyrics' | 'fullscreen' | 'speedUp' | 'speedDown' | 'favorite' | 'settings' }
  | { readonly kind: 'seek'; readonly deltaSeconds: number }
  | { readonly kind: 'volume'; readonly delta: number }
  | { readonly kind: 'seekPercent'; readonly percent: number };

export interface KeyInput {
  readonly key: string;
  readonly ctrl: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
}

export type CustomizableId = 'togglePlay' | 'next' | 'previous' | 'mute' | 'shuffle' | 'repeat' | 'queue' | 'lyrics' | 'fullscreen' | 'favorite' | 'speedUp' | 'speedDown';
/** The actions whose key the listener may change in Settings, with their built-in key. (Arrows, digits, F11, ? and Ctrl combinations stay fixed.) */
export const CUSTOMIZABLE: readonly { readonly id: CustomizableId; readonly label: string; readonly key: string }[] = [
  { id: 'togglePlay', label: 'Play / pause', key: ' ' },
  { id: 'next', label: 'Next song', key: 'n' },
  { id: 'previous', label: 'Previous song', key: 'p' },
  { id: 'mute', label: 'Mute', key: 'm' },
  { id: 'shuffle', label: 'Shuffle', key: 's' },
  { id: 'repeat', label: 'Repeat', key: 'r' },
  { id: 'favorite', label: 'Favorite the current song', key: 'h' },
  { id: 'queue', label: 'Queue', key: 'q' },
  { id: 'lyrics', label: 'Lyrics Mode', key: 'l' },
  { id: 'fullscreen', label: 'Fullscreen', key: 'f' },
  { id: 'speedDown', label: 'Slower', key: '[' },
  { id: 'speedUp', label: 'Faster', key: ']' },
];

export const normaliseKey = (key: string): string => (key.length === 1 ? key.toLowerCase() : key);
export const keyLabel = (key: string): string => (key === ' ' ? 'Space' : key.length === 1 ? key.toUpperCase() : key);

/** A key that may be assigned: one printable character that is not a digit (those jump in the song) and not `?` (Settings). */
export function isAssignableKey(key: string): boolean {
  return key.length === 1 && !/[0-9?]/.test(key);
}

/** The action already using `key` (given the current overrides), other than `except`, or `undefined`. */
export function conflictFor(key: string, except: CustomizableId, overrides: Readonly<Record<string, string>>): CustomizableId | undefined {
  const wanted = normaliseKey(key);
  return CUSTOMIZABLE.find((entry) => entry.id !== except && normaliseKey(overrides[entry.id] ?? entry.key) === wanted)?.id;
}

export const SEEK_STEP_SECONDS = 5;
export const SEEK_LONG_STEP_SECONDS = 15;
export const VOLUME_STEP = 0.05;

/** The action a key press means while nothing is being typed. Alt combinations belong to navigation and are not handled here. */
export function resolveShortcut(input: KeyInput, overrides: Readonly<Record<string, string>> = {}): ShortcutAction | undefined {
  const { key, ctrl, shift, alt } = input;
  if (alt) return undefined;
  if (ctrl) {
    if (key === 'ArrowRight') return { kind: 'next' };
    if (key === 'ArrowLeft') return { kind: 'previous' };
    if (key === ',') return { kind: 'settings' };
    return undefined;
  }
  switch (key) {
    case 'ArrowRight': return { kind: 'seek', deltaSeconds: shift ? SEEK_LONG_STEP_SECONDS : SEEK_STEP_SECONDS };
    case 'ArrowLeft': return { kind: 'seek', deltaSeconds: -(shift ? SEEK_LONG_STEP_SECONDS : SEEK_STEP_SECONDS) };
    case 'ArrowUp': return { kind: 'volume', delta: VOLUME_STEP };
    case 'ArrowDown': return { kind: 'volume', delta: -VOLUME_STEP };
    case 'F11': return { kind: 'fullscreen' };
    case '?': return { kind: 'settings' };
  }
  if (/^[0-9]$/.test(key)) return { kind: 'seekPercent', percent: Number(key) * 10 };
  const wanted = normaliseKey(key);
  for (const entry of CUSTOMIZABLE) if (normaliseKey(overrides[entry.id] ?? entry.key) === wanted) return { kind: entry.id };
  return undefined;
}

export const SHORTCUT_HELP: readonly (readonly [string, string])[] = [
  ['Next / previous (always)', 'Ctrl + → / ←'],
  ['Seek 5 s back / forward', '← / →'],
  ['Seek 15 s back / forward', 'Shift + ← / →'],
  ['Jump to 0–90 % of the song', '0 – 9'],
  ['Volume up / down', '↑ / ↓'],
  ['Fullscreen (always)', 'F11 or double-click'],
  ['Search', 'Ctrl + K'],
  ['Settings', 'Ctrl + , or ?'],
  ['Back / forward', 'Alt + ← / →'],
  ['Close Now Playing / menus', 'Esc'],
];
