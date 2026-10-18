import { SHELL_COMMANDS, type ShellCommand, type ShellCommandEvent } from '@nova/shared';

export interface CommandTarget {
  isDestroyed(): boolean;
  send(channel: 'shell:command', payload: ShellCommandEvent): void;
}

/**
 * The ONE way a shell command (tray, media key) reaches the player: main sends a typed
 * `shell:command` event to the main window's renderer, which runs it through the same playback
 * store actions as the on-screen buttons. Main never touches the audio element or the renderer's
 * state, and there is no second playback controller. Returns whether the command was delivered.
 */
export function createCommandDispatcher(options: {
  readonly target: () => CommandTarget | undefined;
  readonly log: (message: string, error: unknown) => void;
}): (command: ShellCommand) => boolean {
  return (command) => {
    if (!(SHELL_COMMANDS as readonly string[]).includes(command)) return false;
    const target = options.target();
    if (target === undefined || target.isDestroyed()) return false;
    try {
      target.send('shell:command', { command });
      return true;
    } catch (error) {
      options.log(`[nova] could not deliver the shell command "${command}":`, error);
      return false;
    }
  };
}
