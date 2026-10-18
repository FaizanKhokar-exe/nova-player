import { describe, expect, it, beforeEach } from 'vitest';
import { usePhase0CounterStore } from './phase0-counter-store.js';

describe('usePhase0CounterStore', () => {
  beforeEach(() => {
    usePhase0CounterStore.setState({ count: 0 });
  });

  it('increments state correctly outside of React', () => {
    expect(usePhase0CounterStore.getState().count).toBe(0);
    usePhase0CounterStore.getState().increment();
    expect(usePhase0CounterStore.getState().count).toBe(1);
  });
});
