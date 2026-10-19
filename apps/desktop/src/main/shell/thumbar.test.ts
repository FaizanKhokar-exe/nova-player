import { describe, expect, it } from 'vitest';
import { SHELL_COMMANDS } from '@nova/shared';
import { buildThumbarButtons } from './thumbar.js';

describe('buildThumbarButtons', () => {
  it('offers Previous, Play/Pause and Next, each a real shell command with an icon file', () => {
    const buttons = buildThumbarButtons((name) => `/res/${name}`);
    expect(buttons.map((b) => b.id)).toEqual(['previous', 'toggle-play', 'next']);
    for (const button of buttons) {
      expect(SHELL_COMMANDS).toContain(button.id);
      expect(button.iconPath).toMatch(/^\/res\/thumb-.+\.png$/);
      expect(button.tooltip.length).toBeGreaterThan(0);
    }
  });
});
