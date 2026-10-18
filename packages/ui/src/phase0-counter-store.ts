import { create } from 'zustand';

/**
 * Phase 0 smoke-test store only - proves Zustand is correctly wired into
 * the @nova/ui package and works under React Testing Library. The real
 * playback/queue/library stores (per the accepted architecture) are
 * Phase 3+ work.
 */
interface Phase0CounterState {
  readonly count: number;
  increment: () => void;
}

export const usePhase0CounterStore = create<Phase0CounterState>((set) => ({
  count: 0,
  increment: () => set((state) => ({ count: state.count + 1 })),
}));
