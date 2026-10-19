import type { ShellCommand } from '@nova/shared';

/** One taskbar thumbnail button (Windows), in a form independent of Electron's `ThumbarButton`. */
export interface ThumbarButton {
  readonly id: ShellCommand;
  readonly tooltip: string;
  readonly iconPath: string;
}

/** The three buttons under the taskbar preview: Previous, Play/Pause, Next. */
export function buildThumbarButtons(iconDir: (name: string) => string): readonly ThumbarButton[] {
  return [
    { id: 'previous', tooltip: 'Previous', iconPath: iconDir('thumb-previous.png') },
    { id: 'toggle-play', tooltip: 'Play / Pause', iconPath: iconDir('thumb-play-pause.png') },
    { id: 'next', tooltip: 'Next', iconPath: iconDir('thumb-next.png') },
  ];
}
