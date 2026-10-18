import type { ShellCommand } from '@nova/shared';
import { describe, expect, it, vi } from 'vitest';
import { createCommandDispatcher, type CommandTarget } from './command-dispatcher.js';

const target = (destroyed = false) => {
  const send = vi.fn<CommandTarget['send']>();
  return { isDestroyed: () => destroyed, send } satisfies CommandTarget;
};

describe('shell command dispatcher', () => {
  it('sends exactly the typed shell:command event for each command', () => {
    const t = target();
    const dispatch = createCommandDispatcher({ target: () => t, log: vi.fn() });
    expect(dispatch('toggle-play')).toBe(true);
    expect(dispatch('next')).toBe(true);
    expect(dispatch('previous')).toBe(true);
    expect(t.send.mock.calls).toEqual([
      ['shell:command', { command: 'toggle-play' }],
      ['shell:command', { command: 'next' }],
      ['shell:command', { command: 'previous' }],
    ]);
  });

  it('refuses a command that is not one of the three (nothing arbitrary can be named)', () => {
    const t = target();
    const dispatch = createCommandDispatcher({ target: () => t, log: vi.fn() });
    expect(dispatch('quit' as ShellCommand)).toBe(false);
    expect(dispatch('__proto__' as ShellCommand)).toBe(false);
    expect(t.send).not.toHaveBeenCalled();
  });

  it('delivers nothing (and does not throw) with no window or a destroyed one', () => {
    expect(createCommandDispatcher({ target: () => undefined, log: vi.fn() })('next')).toBe(false);
    const t = target(true);
    expect(createCommandDispatcher({ target: () => t, log: vi.fn() })('next')).toBe(false);
    expect(t.send).not.toHaveBeenCalled();
  });

  it('a send that throws is logged and reported as not delivered', () => {
    const t = target();
    t.send.mockImplementation(() => { throw new Error('gone'); });
    const log = vi.fn();
    expect(createCommandDispatcher({ target: () => t, log })('next')).toBe(false);
    expect(log).toHaveBeenCalledTimes(1);
  });
});
