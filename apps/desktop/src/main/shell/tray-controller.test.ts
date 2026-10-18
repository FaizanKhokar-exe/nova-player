import { describe, expect, it, vi } from 'vitest';
import { buildTrayMenu, createTrayController, type TrayMenuItem, type TrayPort } from './tray-controller.js';

function fakeTray(): TrayPort & { destroyed: boolean; tooltip: string; menu: readonly TrayMenuItem[]; activate: Array<() => void> } {
  const tray = {
    destroyed: false,
    tooltip: '',
    menu: [] as readonly TrayMenuItem[],
    activate: [] as Array<() => void>,
    setToolTip: (t: string) => { tray.tooltip = t; },
    setMenu: (m: readonly TrayMenuItem[]) => { tray.menu = m; },
    onActivate: (l: () => void) => void tray.activate.push(l),
    destroy: () => { tray.destroyed = true; },
    isDestroyed: () => tray.destroyed,
  };
  return tray;
}

function setup(createTray?: () => TrayPort) {
  const trays: ReturnType<typeof fakeTray>[] = [];
  const handlers = { onShow: vi.fn(), onCommand: vi.fn(), onQuit: vi.fn(), log: vi.fn() };
  const factory = vi.fn(createTray ?? (() => { const t = fakeTray(); trays.push(t); return t; }));
  const controller = createTrayController({ createTray: factory, tooltip: 'Nova Player', ...handlers });
  return { controller, trays, factory, ...handlers };
}

const click = (items: readonly TrayMenuItem[], id: string): void => {
  const item = items.find((i) => i.kind === 'item' && i.id === id);
  if (item?.kind !== 'item') throw new Error(`no ${id} item`);
  item.click();
};

describe('tray menu', () => {
  it('has exactly Show, Play/Pause, Next, Previous and Quit, in that order', () => {
    const items = buildTrayMenu({ onShow: vi.fn(), onCommand: vi.fn(), onQuit: vi.fn() });
    expect(items.map((i) => (i.kind === 'item' ? i.id : '-'))).toEqual(['show', '-', 'toggle-play', 'next', 'previous', '-', 'quit']);
  });

  it('routes each item to its own handler and command', () => {
    const { controller, onShow, onCommand, onQuit } = setup();
    controller.start();
    click(controller.menu(), 'show');
    expect(onShow).toHaveBeenCalledTimes(1);
    click(controller.menu(), 'toggle-play');
    click(controller.menu(), 'next');
    click(controller.menu(), 'previous');
    expect(onCommand.mock.calls).toEqual([['toggle-play'], ['next'], ['previous']]);
    click(controller.menu(), 'quit');
    expect(onQuit).toHaveBeenCalledTimes(1);
    expect(onCommand).toHaveBeenCalledTimes(3);
  });
});

describe('tray lifetime', () => {
  it('start() creates one tray with a tooltip, the menu and a click-to-show handler', () => {
    const { controller, trays, onShow } = setup();
    expect(controller.start()).toBe(true);
    expect(trays).toHaveLength(1);
    expect(trays[0]!.tooltip).toBe('Nova Player');
    expect(trays[0]!.menu.length).toBeGreaterThan(0);
    trays[0]!.activate[0]!();
    expect(onShow).toHaveBeenCalledTimes(1);
  });

  it('repeated start() never creates a second tray icon', () => {
    const { controller, factory } = setup();
    controller.start();
    controller.start();
    controller.start();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(controller.isActive()).toBe(true);
  });

  it('dispose() destroys the icon, is idempotent, and a later start() makes a fresh one', () => {
    const { controller, trays, factory } = setup();
    controller.start();
    controller.dispose();
    controller.dispose();
    expect(trays[0]!.destroyed).toBe(true);
    expect(controller.isActive()).toBe(false);
    expect(controller.menu()).toEqual([]);
    controller.start();
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('a tray the OS destroyed on its own is recreated, not treated as alive', () => {
    const { controller, trays, factory } = setup();
    controller.start();
    trays[0]!.destroyed = true;
    expect(controller.isActive()).toBe(false);
    controller.start();
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('when the tray cannot be created it reports false and logs; the app carries on', () => {
    const { controller, log } = setup(() => { throw new Error('no tray here'); });
    expect(controller.start()).toBe(false);
    expect(controller.isActive()).toBe(false);
    expect(log).toHaveBeenCalledTimes(1);
    expect(() => controller.dispose()).not.toThrow();
  });

  it('a tray that fails halfway through setup is not left registered', () => {
    const t = fakeTray();
    t.setMenu = () => { throw new Error('menu failed'); };
    const { controller, log } = setup(() => t);
    expect(controller.start()).toBe(false);
    expect(controller.isActive()).toBe(false);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('a failing destroy is logged, never thrown', () => {
    const t = fakeTray();
    t.destroy = () => { throw new Error('nope'); };
    const { controller, log } = setup(() => t);
    controller.start();
    expect(() => controller.dispose()).not.toThrow();
    expect(log).toHaveBeenCalledTimes(1);
  });
});
