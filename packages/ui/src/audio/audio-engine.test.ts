import { describe, expect, it } from 'vitest';
import { createBeatAnalyzer, logBars } from './beat-detector.js';
import { createAudioEngine, type AnalyserLike, type AudioContextLike, type BiquadLike, type GainLike } from './audio-engine.js';
import { EQ_BANDS, EQ_PRESETS, clampDb, matchPreset, preampFor } from './eq-presets.js';

const frame = (bassLevel: number, binHz = 43): Uint8Array => {
  const bins = new Uint8Array(512);
  for (let i = 0; i < 512; i += 1) bins[i] = i * binHz < 150 ? bassLevel : 20;
  return bins;
};

describe('beat analyzer', () => {
  it('detects kicks above the running average and honours the minimum gap', () => {
    const analyzer = createBeatAnalyzer();
    let now = 0;
    for (let i = 0; i < 60; i += 1) analyzer.analyze(frame(70), 43, (now += 16)); // steady bed
    const kick = analyzer.analyze(frame(220), 43, (now += 16));
    expect(kick.beat).toBe(true);
    expect(kick.pulse).toBe(1);
    const tooSoon = analyzer.analyze(frame(230), 43, now + 16);
    expect(tooSoon.beat).toBe(false); // inside the 210 ms gap
    expect(tooSoon.pulse).toBeLessThan(1);
  });
  it('never fires on silence or a constant tone', () => {
    const analyzer = createBeatAnalyzer();
    let now = 0;
    const hits = Array.from({ length: 200 }, () => analyzer.analyze(frame(0), 43, (now += 16)).beat).filter(Boolean);
    expect(hits).toHaveLength(0);
    const steady = Array.from({ length: 200 }, () => analyzer.analyze(frame(140), 43, (now += 16)).beat).filter(Boolean);
    expect(steady.length).toBeLessThanOrEqual(1); // at most the first ramp-up
  });
  it('fires again after the gap, and reset clears state', () => {
    const analyzer = createBeatAnalyzer();
    let now = 0;
    for (let i = 0; i < 60; i += 1) analyzer.analyze(frame(60), 43, (now += 16));
    expect(analyzer.analyze(frame(230), 43, (now += 16)).beat).toBe(true);
    for (let i = 0; i < 20; i += 1) analyzer.analyze(frame(60), 43, (now += 16));
    expect(analyzer.analyze(frame(230), 43, now + 16).beat).toBe(true);
    analyzer.reset();
    const after = analyzer.analyze(frame(0), 43, 1);
    expect(after.pulse).toBe(0);
    expect(after.beat).toBe(false);
  });
  it('splits energy into bass / mid / treble', () => {
    const analyzer = createBeatAnalyzer();
    const bins = new Uint8Array(512);
    for (let i = 0; i < 512; i += 1) bins[i] = i * 43 < 150 ? 255 : 0;
    let levels = analyzer.analyze(bins, 43, 0);
    for (let i = 1; i < 20; i += 1) levels = analyzer.analyze(bins, 43, i * 16);
    expect(levels.bass).toBeGreaterThan(0.9);
    expect(levels.treble).toBeLessThan(0.05);
  });
  it('logBars fills every bar within 0..1', () => {
    const out = new Float32Array(32);
    logBars(frame(200), 43, out);
    expect([...out].every((v) => v >= 0 && v <= 1)).toBe(true);
    expect(out[0]).toBeGreaterThan(out[31] as number);
  });
});

describe('eq presets', () => {
  it('every preset has ten bands within range and flat matches', () => {
    for (const preset of EQ_PRESETS) {
      expect(preset.gains).toHaveLength(EQ_BANDS.length);
      expect(preset.gains.every((g) => g >= -12 && g <= 12)).toBe(true);
    }
    expect(matchPreset(EQ_PRESETS[0]!.gains)).toBe('flat');
    expect(matchPreset([1, 0, 0, 0, 0, 0, 0, 0, 0, 0])).toBe('custom');
  });
  it('clamps and rounds to half dB, and never raises the pre-amp', () => {
    expect(clampDb(99)).toBe(12);
    expect(clampDb(-99)).toBe(-12);
    expect(clampDb(2.26)).toBe(2.5);
    expect(clampDb(Number.NaN)).toBe(0);
    expect(preampFor([0, 0, 0])).toBe(1);
    expect(preampFor([6, 0, -3])).toBeCloseTo(0.501, 2);
  });
});

function fakeContext(): { context: AudioContextLike; filters: BiquadLike[]; gains: GainLike[]; analyser: { value?: AnalyserLike }; connections: [unknown, unknown][] } {
  const connections: [unknown, unknown][] = [];
  const filters: BiquadLike[] = [];
  const gains: GainLike[] = [];
  const analyser: { value?: AnalyserLike } = {};
  const node = () => ({ connect: function (this: unknown, next: unknown) { connections.push([this, next]); return next; }, disconnect: () => undefined });
  const context: AudioContextLike = {
    sampleRate: 44_100,
    state: 'suspended',
    destination: { name: 'destination' },
    resume: async () => undefined,
    close: async () => undefined,
    createMediaElementSource: () => node(),
    createBiquadFilter: () => {
      const f = { ...node(), type: '', frequency: { value: 0 }, gain: { value: 0 }, Q: { value: 0 } };
      filters.push(f);
      return f;
    },
    createGain: () => {
      const g = { ...node(), gain: { value: 1 } };
      gains.push(g);
      return g;
    },
    createAnalyser: () => {
      const a = { ...node(), fftSize: 0, smoothingTimeConstant: 0, minDecibels: 0, maxDecibels: 0, frequencyBinCount: 512, getByteFrequencyData: (into: Uint8Array) => into.fill(9) };
      analyser.value = a;
      return a;
    },
  };
  return { context, filters, gains, analyser, connections };
}

describe('audio engine', () => {
  it('builds source -> 10 filters -> gain -> analyser -> destination once', () => {
    const fake = fakeContext();
    const engine = createAudioEngine({ element: {}, createContext: () => fake.context });
    expect(engine.connected).toBe(false);
    expect(engine.connect()).toBe(true);
    expect(engine.connect()).toBe(true);
    expect(fake.filters).toHaveLength(10);
    expect(fake.filters[0]!.type).toBe('lowshelf');
    expect(fake.filters[9]!.type).toBe('highshelf');
    expect(fake.connections).toHaveLength(10 + 1 + 1 + 1); // source->f0 ... f9->gain, gain->analyser, analyser->destination
    expect(fake.connections.at(-1)![1]).toBe(fake.context.destination);
    expect(engine.binHz).toBeCloseTo(44_100 / 1024);
  });
  it('applies gains only while enabled, with automatic headroom', () => {
    const fake = fakeContext();
    const engine = createAudioEngine({ element: {}, createContext: () => fake.context });
    engine.connect();
    engine.setGains([6, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(fake.filters[0]!.gain.value).toBe(0); // disabled
    engine.setEqEnabled(true);
    expect(fake.filters[0]!.gain.value).toBe(6);
    expect(fake.gains[0]!.gain.value).toBeCloseTo(0.501, 2);
    engine.setEqEnabled(false);
    expect(fake.gains[0]!.gain.value).toBe(1);
  });
  it('reads frequencies and degrades safely when Web Audio is missing', () => {
    const fake = fakeContext();
    const engine = createAudioEngine({ element: {}, createContext: () => fake.context });
    const into = new Uint8Array(512);
    expect(engine.readFrequencies(into)).toBe(false);
    engine.connect();
    expect(engine.readFrequencies(into)).toBe(true);
    expect(into[0]).toBe(9);

    const errors: unknown[] = [];
    const broken = createAudioEngine({ element: {}, createContext: () => { throw new Error('no audio'); }, onError: (e) => errors.push(e) });
    expect(broken.connect()).toBe(false);
    expect(broken.connect()).toBe(false);
    expect(errors).toHaveLength(1); // not retried every frame
    expect(broken.readFrequencies(into)).toBe(false);
    expect(() => broken.setGains([1])).not.toThrow();
  });
});
