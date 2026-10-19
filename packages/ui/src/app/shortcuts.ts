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

export const SEEK_STEP_SECONDS = 5;
export const SEEK_LONG_STEP_SECONDS = 15;
export const VOLUME_STEP = 0.05;

/** The action a key press means while nothing is being typed. Alt combinations belong to navigation and are not handled here. */
export function resolveShortcut(input: KeyInput): ShortcutAction | undefined {
  const { key, ctrl, shift, alt } = input;
  if (alt) return undefined;
  if (ctrl) {
    if (key === 'ArrowRight') return { kind: 'next' };
    if (key === 'ArrowLeft') return { kind: 'previous' };
    if (key === ',') return { kind: 'settings' };
    return undefined;
  }
  switch (key) {
    case ' ': return { kind: 'togglePlay' };
    case 'ArrowRight': return { kind: 'seek', deltaSeconds: shift ? SEEK_LONG_STEP_SECONDS : SEEK_STEP_SECONDS };
    case 'ArrowLeft': return { kind: 'seek', deltaSeconds: -(shift ? SEEK_LONG_STEP_SECONDS : SEEK_STEP_SECONDS) };
    case 'ArrowUp': return { kind: 'volume', delta: VOLUME_STEP };
    case 'ArrowDown': return { kind: 'volume', delta: -VOLUME_STEP };
    case 'F11': return { kind: 'fullscreen' };
    case ']': return { kind: 'speedUp' };
    case '[': return { kind: 'speedDown' };
    case '?': return { kind: 'settings' };
  }
  if (/^[0-9]$/.test(key)) return { kind: 'seekPercent', percent: Number(key) * 10 };
  switch (key.toLowerCase()) {
    case 'n': return { kind: 'next' };
    case 'p': return { kind: 'previous' };
    case 'm': return { kind: 'mute' };
    case 's': return { kind: 'shuffle' };
    case 'r': return { kind: 'repeat' };
    case 'q': return { kind: 'queue' };
    case 'l': return { kind: 'lyrics' };
    case 'f': return { kind: 'fullscreen' };
    case 'h': return { kind: 'favorite' };
    default: return undefined;
  }
}

export const SHORTCUT_HELP: readonly (readonly [string, string])[] = [
  ['Play / pause', 'Space'],
  ['Next / previous', 'Ctrl + → / ←   or   N / P'],
  ['Seek 5 s back / forward', '← / →'],
  ['Seek 15 s back / forward', 'Shift + ← / →'],
  ['Jump to 0–90 % of the song', '0 – 9'],
  ['Volume up / down', '↑ / ↓'],
  ['Mute', 'M'],
  ['Shuffle', 'S'],
  ['Repeat', 'R'],
  ['Favorite the current song', 'H'],
  ['Playback speed down / up', '[ / ]'],
  ['Queue', 'Q'],
  ['Lyrics Mode', 'L'],
  ['Fullscreen', 'F, F11 or double-click'],
  ['Search', 'Ctrl + K'],
  ['Settings', 'Ctrl + , or ?'],
  ['Back / forward', 'Alt + ← / →'],
  ['Close Now Playing / menus', 'Esc'],
];
