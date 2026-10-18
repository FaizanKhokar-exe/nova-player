import { createStore } from 'zustand/vanilla';
import { describe, expect, it, vi } from 'vitest';
import { createAudioControls, formatRemaining, type AudioElementLike } from './audio-controls.js';
import type { AudioEngine } from './audio-engine.js';
import { createPrefsStore } from '../prefs/prefs-store.js';

function setup() {
  const audio: AudioElementLike = { playbackRate: 1, defaultPlaybackRate: 1 };
  const engineCalls: string[] = [];
  const engine = {
    connect: () => (engineCalls.push('connect'), true),
    resume: () => void engineCalls.push('resume'),
    setEqEnabled: (e: boolean) => void engineCalls.push(`enabled:${e}`),
    setGains: (g: readonly number[]) => void engineCalls.push(`gains:${g[0]}`),
  } as unknown as AudioEngine;
  const prefs = createPrefsStore(undefined);
  const pause = vi.fn();
  const playback = createStore<{ session: { current?: { track: { id: string } } } | undefined; pause: () => void }>(() => ({ session: { current: { track: { id: 'a' } } }, pause }));
  let time = 0;
  let tick: (() => void) | undefined;
  const controls = createAudioControls({
    audio,
    engine,
    prefs,
    playback: playback as never,
    now: () => time,
    setInterval: (handler) => ((tick = handler), 1),
    clearInterval: () => (tick = undefined),
  });
  return { audio, engineCalls, prefs, pause, playback, controls, advance: (ms: number) => { time += ms; tick?.(); } };
}

describe('audio controls', () => {
  it('applies speed to the element and keeps it across track changes', () => {
    const t = setup();
    t.prefs.getState().setSpeed(1.5);
    expect(t.audio.playbackRate).toBe(1.5);
    expect(t.audio.defaultPlaybackRate).toBe(1.5);
    t.audio.playbackRate = 1; // a load resets it
    t.playback.setState({ session: { current: { track: { id: 'b' } } } });
    expect(t.audio.playbackRate).toBe(1.5);
  });
  it('pushes EQ changes to the engine once it is active', () => {
    const t = setup();
    t.controls.getState().activateEngine();
    expect(t.controls.getState().engineReady).toBe(true);
    t.prefs.getState().setEqEnabled(true);
    t.prefs.getState().setEqBand(0, 5);
    expect(t.engineCalls).toContain('enabled:true');
    expect(t.engineCalls).toContain('gains:5');
  });
  it('the timer counts down, then pauses and says so', () => {
    const t = setup();
    t.controls.getState().setSleepTimer(10);
    expect(t.controls.getState().sleepRemainingMs).toBe(600_000);
    t.advance(60_000);
    expect(t.controls.getState().sleepRemainingMs).toBe(540_000);
    expect(t.pause).not.toHaveBeenCalled();
    t.advance(540_000);
    expect(t.pause).toHaveBeenCalledTimes(1);
    expect(t.controls.getState().sleep).toEqual({ mode: 'off' });
    expect(t.controls.getState().notice).toMatch(/Sleep timer/);
  });
  it('cancel and invalid minutes clear the timer', () => {
    const t = setup();
    t.controls.getState().setSleepTimer(5);
    t.controls.getState().cancelSleep();
    expect(t.controls.getState().sleep.mode).toBe('off');
    t.controls.getState().setSleepTimer(0);
    expect(t.controls.getState().sleep.mode).toBe('off');
    t.advance(10 * 60_000);
    expect(t.pause).not.toHaveBeenCalled();
  });
  it('end-of-track mode pauses when a different track becomes current', () => {
    const t = setup();
    t.controls.getState().setSleepEndOfTrack();
    expect(t.controls.getState().sleep).toEqual({ mode: 'track', trackId: 'a' });
    t.playback.setState({ session: { current: { track: { id: 'a' } } } });
    expect(t.pause).not.toHaveBeenCalled();
    t.playback.setState({ session: { current: { track: { id: 'b' } } } });
    expect(t.pause).toHaveBeenCalledTimes(1);
    expect(t.controls.getState().sleep.mode).toBe('off');
  });
  it('formats the remaining time', () => {
    expect(formatRemaining(61_000)).toBe('1:01');
    expect(formatRemaining(-5)).toBe('0:00');
  });
});
