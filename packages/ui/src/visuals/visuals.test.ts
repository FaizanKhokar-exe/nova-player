import { describe, expect, it } from 'vitest';
import { createFrameGovernor } from './frame-governor.js';
import { createVisualBus, type VisualFrame } from './visual-bus.js';

describe('frame governor', () => {
  it('paces frames to the mode', () => {
    const g = createFrameGovernor('low');
    let drawn = 0;
    for (let t = 0; t < 1000; t += 16.7) if (g.due(t)) drawn += 1;
    expect(drawn).toBeGreaterThanOrEqual(18) // a 60 Hz display can only draw every 3rd tick;
    expect(drawn).toBeLessThanOrEqual(26);
    const h = createFrameGovernor('high');
    drawn = 0;
    for (let t = 0; t < 1000; t += 16.7) if (h.due(t)) drawn += 1;
    expect(drawn).toBeGreaterThanOrEqual(58);
  });
  it('auto steps down when drawing is slow and back up after a calm spell', () => {
    const g = createFrameGovernor('auto');
    expect(g.budget.fps).toBe(60);
    for (let i = 0; i < 40; i += 1) g.recordCost(14);
    expect(g.budget.fps).toBe(40);
    for (let i = 0; i < 40; i += 1) g.recordCost(14);
    expect(g.budget.fps).toBe(24);
    expect(g.budget.glow).toBe(false);
    for (let i = 0; i < 40 * 6; i += 1) g.recordCost(1);
    expect(g.budget.fps).toBe(40);
  });
  it('fixed modes ignore costs; switching resets auto', () => {
    const g = createFrameGovernor('balanced');
    for (let i = 0; i < 200; i += 1) g.recordCost(50);
    expect(g.budget.fps).toBe(40);
    g.setMode('auto');
    expect(g.budget.fps).toBe(60);
  });
});

function setup(visible = true) {
  const callbacks = new Map<number, (t: number) => void>();
  let id = 0;
  let clock = 0;
  const engine = { connected: true, binCount: 512, binHz: 43, readFrequencies: (into: Uint8Array) => (into.fill(100), true) };
  const state = { visible };
  const bus = createVisualBus({
    engine,
    raf: (cb) => (callbacks.set(++id, cb), id),
    caf: (h) => void callbacks.delete(h),
    now: () => clock,
    visible: () => state.visible,
  });
  const step = (ms = 16.7) => {
    clock += ms;
    const pending = [...callbacks.entries()];
    callbacks.clear();
    for (const [, cb] of pending) cb(clock);
  };
  return { bus, step, scheduled: () => callbacks.size, state };
}

describe('visual bus', () => {
  it('schedules nothing until something listens AND music plays', () => {
    const t = setup();
    expect(t.scheduled()).toBe(0);
    const frames: VisualFrame[] = [];
    const off = t.bus.subscribe((f) => frames.push(f));
    expect(t.scheduled()).toBe(0); // not playing
    t.bus.setPlaying(true);
    expect(t.scheduled()).toBe(1);
    for (let i = 0; i < 10; i += 1) t.step();
    expect(frames.length).toBeGreaterThan(5);
    expect(frames[0]!.synthetic).toBe(false);
    off();
    expect(t.scheduled()).toBe(0);
  });
  it('stops when playback pauses or the window is hidden, and resumes', () => {
    const t = setup();
    t.bus.subscribe(() => undefined);
    t.bus.setPlaying(true);
    t.step();
    t.bus.setPlaying(false);
    expect(t.scheduled()).toBe(0);
    t.bus.setPlaying(true);
    expect(t.scheduled()).toBe(1);
    t.state.visible = false;
    t.step(); // the pending frame notices and does not reschedule
    expect(t.scheduled()).toBe(0);
  });
  it('shares one frame between listeners', () => {
    const t = setup();
    let a = 0;
    let b = 0;
    t.bus.subscribe(() => (a += 1));
    t.bus.subscribe(() => (b += 1));
    t.bus.setPlaying(true);
    t.step();
    expect([a, b]).toEqual([1, 1]);
    expect(t.scheduled()).toBe(1); // still ONE loop
  });
  it('flags synthetic frames when Web Audio is unavailable', () => {
    const callbacks: Array<(t: number) => void> = [];
    const bus = createVisualBus({ engine: { connected: false, binCount: 512, binHz: 43, readFrequencies: () => false }, raf: (cb) => (callbacks.push(cb), 1), caf: () => undefined, now: () => 0, visible: () => true });
    const frames: VisualFrame[] = [];
    bus.subscribe((f) => frames.push(f));
    bus.setPlaying(true);
    callbacks.shift()!(100);
    expect(frames[0]!.synthetic).toBe(true);
  });
});
