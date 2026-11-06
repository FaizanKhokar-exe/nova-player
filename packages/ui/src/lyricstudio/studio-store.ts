import { createStore, type StoreApi } from 'zustand/vanilla';
import type { IpcResult, LyricsCandidateDto, LyricsSearchResultDto, NovaBridge, SaveLyricsResultDto } from '@nova/shared';
import type { PlaybackStoreApi } from '../playback/playback-store.js';
import { alignLinesAsync } from './align.js';
import { calibrateTimes, snapLines } from './calibrate.js';
import { buildLrc, splitLyricsText, type PlainLine, type TimedLine } from './lrc-format.js';
import { overview, snapToOnset, TAP_LAG_MS } from './snap.js';
import { lineWeight } from './syllables.js';
import { analyseSignal, type VocalFeatures } from './vocal-features.js';

/**
 * Lyric Studio's state: find or paste the words, let the app estimate when each line starts from the song itself,
 * then fix what is off while listening (tap to stamp, nudge, lock), and save a `.lrc`.
 */

export type StudioStep = 'source' | 'analysing' | 'timing';
export type SearchStatus = 'idle' | 'searching' | 'done' | 'offline' | 'error' | 'unavailable';
export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export interface StudioState {
  readonly open: boolean;
  readonly step: StudioStep;
  readonly trackId: string | undefined;
  readonly title: string;
  readonly artist: string;
  readonly queryTitle: string;
  readonly queryArtist: string;
  readonly text: string;
  readonly search: { readonly status: SearchStatus; readonly candidates: readonly LyricsCandidateDto[]; readonly chosenId: number | undefined };
  /** True when the chosen result brought its own timestamps and the listener asked to start from them. */
  readonly startFromSynced: boolean;
  /** The song already has lyrics: the studio opened on them, so they can be fixed or estimated again. */
  readonly hasExisting: boolean;
  /** What was done to timing that came from elsewhere ("moved 2.8 s later"), or undefined. */
  readonly calibrationNote: string | undefined;
  readonly lines: readonly PlainLine[];
  readonly times: readonly number[];
  readonly confidence: readonly number[];
  readonly locks: ReadonlySet<number>;
  readonly selected: number;
  readonly progress: number;
  readonly overview: readonly number[];
  readonly durationMs: number;
  /** The song's audio could not be analysed: the times are evenly spaced guesses. */
  readonly analysisFailed: boolean;
  readonly canUndo: boolean;
  /** Where the listener marked the singing as starting / ending (ms), or undefined to let the estimate decide. */
  readonly singStartMs: number | undefined;
  readonly singEndMs: number | undefined;
  readonly save: { readonly status: SaveStatus; readonly outcome: SaveLyricsResultDto['outcome'] | undefined; readonly message: string | undefined };

  openStudio(): void;
  close(): void;
  setText(text: string): void;
  setQuery(title: string, artist: string): void;
  runSearch(): Promise<void>;
  pickCandidate(candidate: LyricsCandidateDto, startFromSynced: boolean): void;
  /** `fresh`: ignore any timing the words came with and estimate from the audio again. */
  begin(fresh?: boolean): Promise<void>;
  backToSource(): void;
  select(index: number): void;
  stamp(): void;
  nudge(index: number, deltaMs: number): void;
  setTime(index: number, ms: number): void;
  toggleLock(index: number): void;
  reestimate(): void;
  shiftAll(deltaMs: number): void;
  undo(): void;
  audition(index: number): void;
  /** Adds a line of words after line `afterIndex` (-1 = at the very start); it is timed between its neighbours and locked, ready to nudge. */
  insertLine(afterIndex: number, text: string): void;
  removeLine(index: number): void;
  editLine(index: number, text: string): void;
  /** Marks the singing as starting / ending at the playing position (`clear` removes both) and estimates again around it. */
  markSinging(which: 'start' | 'end' | 'clear'): void;
  saveLrc(): Promise<void>;
}
export type StudioStoreApi = StoreApi<StudioState>;

const EMPTY_SAVE = { status: 'idle', outcome: undefined, message: undefined } as const;
const SAVE_MESSAGES: Record<SaveLyricsResultDto['outcome'], string> = {
  'saved-beside': 'Saved next to the song as a .lrc file, and in Nova Player.',
  'saved-in-app': 'Saved in Nova Player. The song’s folder couldn’t be written, so no .lrc file was created next to it.',
  invalid: 'There is nothing to save yet - no line has a time.',
  'too-large': 'That lyrics text is too large to save (limit 1 MB).',
  unavailable: 'Can’t save right now - the song’s folder can’t be reached.',
};
const UNREACHABLE = 'Could not reach the application. Try restarting Nova Player.';
const UNDO_LIMIT = 60;
const PRE_ROLL_MS = 700;

export function createStudioStore(bridge: NovaBridge, playback: PlaybackStoreApi, onSaved: () => void = () => undefined, existingLines: () => readonly TimedLine[] = () => []): StudioStoreApi {
  let features: VocalFeatures | undefined;
  let weights: number[] = [];
  let token = 0;
  let undoStack: { times: readonly number[]; locks: ReadonlySet<number>; confidence: readonly number[]; lines: readonly PlainLine[] }[] = [];

  return createStore<StudioState>((set, get) => {
    const monotonic = (times: readonly number[], duration: number): number[] => {
      const out: number[] = [];
      times.forEach((t, i) => out.push(Math.max(i === 0 ? 0 : (out[i - 1] ?? 0), Math.min(duration > 0 ? duration : Number.MAX_SAFE_INTEGER, Math.round(t)))));
      return out;
    };
    const remember = (): void => {
      const s = get();
      undoStack = [...undoStack.slice(-(UNDO_LIMIT - 1)), { times: s.times, locks: s.locks, confidence: s.confidence, lines: s.lines }];
      set({ canUndo: true });
    };
    const fresh = {
      step: 'source' as StudioStep,
      text: '',
      queryTitle: '',
      queryArtist: '',
      search: { status: 'idle' as SearchStatus, candidates: [] as readonly LyricsCandidateDto[], chosenId: undefined as number | undefined },
      startFromSynced: false,
      hasExisting: false,
      calibrationNote: undefined as string | undefined,
      lines: [] as readonly PlainLine[],
      times: [] as readonly number[],
      confidence: [] as readonly number[],
      locks: new Set<number>() as ReadonlySet<number>,
      selected: 0,
      progress: 0,
      overview: [] as readonly number[],
      durationMs: 0,
      analysisFailed: false,
      canUndo: false,
      singStartMs: undefined as number | undefined,
      singEndMs: undefined as number | undefined,
      save: EMPTY_SAVE as StudioState['save'],
    };
    let syncedLines: TimedLine[] | undefined;
    let syncedSourceMs: number | undefined;

    const windowOf = (s: StudioState): { windowStartMs?: number; windowEndMs?: number } => ({ ...(s.singStartMs !== undefined && { windowStartMs: s.singStartMs }), ...(s.singEndMs !== undefined && { windowEndMs: s.singEndMs }) });
    let resolveSequence = 0;
    async function resolveFrom(fromIndex: number): Promise<void> {
      const s = get();
      if (features === undefined) return;
      const mine = ++resolveSequence; // a newer stamp supersedes an older, still-running re-solve
      const anchors = new Map<number, number>();
      for (let i = 0; i < fromIndex && i < s.times.length; i += 1) anchors.set(i, s.times[i] ?? 0);
      for (const i of s.locks) anchors.set(i, s.times[i] ?? 0);
      const token0 = token;
      const result = await alignLinesAsync(weights, features, { anchors, breakBefore: s.lines.map((l) => l.breakBefore), ...windowOf(s) }, () => mine !== resolveSequence || token0 !== token);
      if (result === undefined) return;
      const now = get();
      // Lines the listener touched while this was running keep their newer value.
      const keep = (i: number): boolean => now.locks.has(i) && !s.locks.has(i);
      const times = monotonic(result.startsMs.map((t, i) => (keep(i) ? (now.times[i] ?? t) : t)), s.durationMs);
      const confidence = result.confidence.map((c, i) => (now.locks.has(i) ? 1 : i < fromIndex ? (s.confidence[i] ?? c) : c));
      set({ times, confidence });
    }

    return {
      open: false,
      trackId: undefined,
      title: '',
      artist: '',
      ...fresh,

      openStudio() {
        const current = playback.getState().session?.current;
        if (current === undefined) return;
        token += 1;
        features = undefined;
        undoStack = [];
        syncedLines = undefined;
        const existing = existingLines().filter((l) => l.text.trim() !== '');
        if (existing.length > 0) syncedLines = existing.map((l) => ({ timeMs: l.timeMs, text: l.text }));
        const preload = existing.length > 0 ? { text: existing.map((l) => l.text).join('\n'), startFromSynced: true, hasExisting: true } : {};
        playback.getState().setHoldTrack(true); // the song repeats while you time it; it never moves on to the next one
        set({ ...fresh, ...preload, open: true, trackId: current.track.id, title: current.track.title, artist: current.track.artist, queryTitle: current.track.title, queryArtist: current.track.artist, locks: new Set<number>() });
      },
      close() {
        playback.getState().setHoldTrack(false);
        token += 1; // abandons any analysis in flight
        features = undefined;
        undoStack = [];
        syncedLines = undefined;
        set({ ...fresh, open: false, trackId: undefined, locks: new Set<number>() });
      },
      setText: (text) => set({ text, startFromSynced: false, save: EMPTY_SAVE }),
      setQuery: (queryTitle, queryArtist) => set({ queryTitle, queryArtist }),

      async runSearch() {
        const s = get();
        if (s.trackId === undefined || s.search.status === 'searching') return;
        const mine = token;
        set({ search: { status: 'searching', candidates: [], chosenId: undefined } });
        let result: IpcResult<LyricsSearchResultDto> | undefined;
        try {
          result = (await bridge.invoke('lyrics:search', { trackId: s.trackId, title: s.queryTitle, artist: s.queryArtist })) as IpcResult<LyricsSearchResultDto>;
        } catch {
          result = undefined;
        }
        if (mine !== token) return;
        if (result?.ok === true) set({ search: { status: result.value.status === 'ok' ? 'done' : result.value.status, candidates: result.value.candidates, chosenId: undefined } });
        else set({ search: { status: result === undefined ? 'offline' : 'error', candidates: [], chosenId: undefined } });
      },

      pickCandidate(candidate, startFromSynced) {
        const timed: TimedLine[] = candidate.syncedLines === undefined ? [] : candidate.syncedLines.map((l) => ({ timeMs: l.timeMs, text: l.text }));
        const useSynced = startFromSynced && timed.length > 0;
        syncedLines = useSynced ? timed : undefined;
        syncedSourceMs = candidate.durationSec !== undefined ? candidate.durationSec * 1000 : undefined;
        const text = candidate.plain.trim() !== '' ? candidate.plain : timed.map((l) => l.text).join('\n');
        set({ text: useSynced ? timed.map((l) => l.text).join('\n') : text, startFromSynced: useSynced, search: { ...get().search, chosenId: candidate.id } });
      },

      async begin(freshEstimate = false) {
        const s = get();
        const lines = splitLyricsText(s.text);
        if (lines.length === 0 || s.trackId === undefined) return;
        const mine = ++token;
        const useSynced = !freshEstimate && s.startFromSynced && syncedLines !== undefined && syncedLines.length === lines.length;
        weights = lines.map((l) => lineWeight(l.text));
        undoStack = [];
        set({ step: 'analysing', lines, progress: 0, analysisFailed: false, canUndo: false, locks: new Set<number>(), selected: 0, save: EMPTY_SAVE });
        const signal = await playback.getState().monoSignal();
        if (mine !== token) return;
        const engineDuration = playback.getState().engine.durationMs ?? 0;
        let analysed: VocalFeatures | undefined;
        if (signal !== undefined) analysed = await analyseSignal(signal.samples, signal.sampleRate, { ...(signal.side !== undefined && { side: signal.side }), onProgress: (progress) => mine === token && set({ progress }), isCancelled: () => mine !== token });
        if (mine !== token) return;
        const failed = analysed === undefined;
        const duration = analysed?.durationMs ?? engineDuration;
        features =
          analysed ??
          ({ frameMs: 20, durationMs: duration, level: new Float32Array(0), onset: new Float32Array(0), active: new Uint8Array(0), activeCum: new Float32Array(1), phrases: [] } satisfies VocalFeatures);
        const result = (await alignLinesAsync(weights, features, { breakBefore: lines.map((l) => l.breakBefore), ...windowOf(s) }, () => mine !== token)) ?? { startsMs: [] as number[], confidence: [] as number[] };
        if (mine !== token) return;
        let times: number[] = useSynced && syncedLines !== undefined ? syncedLines.map((l) => l.timeMs) : [...result.startsMs];
        let note: string | undefined;
        if (useSynced && !failed && !s.hasExisting) {
          // Timing found for ANOTHER recording: shift/stretch it onto this one, then settle each start on the nearest real onset.
          const calibrated = calibrateTimes(times, features, syncedSourceMs);
          if (calibrated.changed) {
            const shift = calibrated.offsetMs / 1000;
            note = `The found timing was moved ${Math.abs(shift).toFixed(1)} s ${shift < 0 ? 'earlier' : 'later'}${Math.abs(calibrated.scale - 1) > 0.004 ? ' and stretched' : ''} to fit your recording.`;
          }
          times = snapLines(calibrated.times, features, 250);
        } else if (!useSynced && !failed) {
          times = snapLines(times, features, 200);
        }
        set({
          step: 'timing',
          calibrationNote: note,
          times: monotonic(times, duration),
          confidence: useSynced ? times.map(() => 0.8) : result.confidence,
          durationMs: duration,
          overview: failed ? [] : overview(features, 480),
          analysisFailed: failed,
        });
      },

      backToSource() {
        token += 1;
        set({ step: 'source', save: EMPTY_SAVE });
      },
      select: (selected) => set({ selected: Math.max(0, Math.min(get().lines.length - 1, selected)) }),

      stamp() {
        const s = get();
        if (s.step !== 'timing' || s.lines.length === 0) return;
        remember();
        const raw = playback.getState().livePositionMs() - TAP_LAG_MS;
        const snapped = features !== undefined && features.onset.length > 0 ? snapToOnset(features, raw) : Math.max(0, Math.round(raw));
        const times = [...s.times];
        times[s.selected] = snapped;
        const locks = new Set(s.locks).add(s.selected);
        set({ times: monotonic(times, s.durationMs), locks, selected: Math.min(s.lines.length - 1, s.selected + 1) });
        set({ confidence: get().confidence.map((c, i) => (i === s.selected ? 1 : c)) });
        void resolveFrom(s.selected + 1); // the lines after it follow the new anchor (in the background)
      },

      nudge(index, deltaMs) {
        get().setTime(index, (get().times[index] ?? 0) + deltaMs);
      },

      setTime(index, ms) {
        const s = get();
        if (index < 0 || index >= s.times.length) return;
        remember();
        const lower = index > 0 ? (s.times[index - 1] ?? 0) : 0;
        const upper = index < s.times.length - 1 ? (s.times[index + 1] ?? s.durationMs) : s.durationMs > 0 ? s.durationMs : Number.MAX_SAFE_INTEGER;
        const times = [...s.times];
        times[index] = Math.max(lower, Math.min(upper, Math.round(ms)));
        set({ times, locks: new Set(s.locks).add(index), confidence: s.confidence.map((c, i) => (i === index ? 1 : c)), save: EMPTY_SAVE });
      },

      toggleLock(index) {
        const s = get();
        remember();
        const locks = new Set(s.locks);
        if (locks.has(index)) locks.delete(index);
        else locks.add(index);
        set({ locks });
      },

      reestimate() {
        remember();
        void resolveFrom(0);
      },

      shiftAll(deltaMs) {
        const s = get();
        remember();
        set({ times: monotonic(s.times.map((t) => t + deltaMs), s.durationMs), save: EMPTY_SAVE });
      },

      undo() {
        const last = undoStack[undoStack.length - 1];
        if (last === undefined) return;
        undoStack = undoStack.slice(0, -1);
        weights = last.lines.map((l) => lineWeight(l.text));
        set({ lines: last.lines, times: last.times, locks: last.locks, confidence: last.confidence, canUndo: undoStack.length > 0, selected: Math.min(get().selected, Math.max(0, last.lines.length - 1)) });
      },

      audition(index) {
        const s = get();
        const time = s.times[index];
        if (time === undefined) return;
        const p = playback.getState();
        p.seekMs(Math.max(0, time - PRE_ROLL_MS));
        if (!p.engine.playing) void p.togglePlay();
        set({ selected: index });
      },

      insertLine(afterIndex, rawText) {
        const s = get();
        const text = rawText.replace(/\s+/g, ' ').trim();
        if (s.step !== 'timing' || text === '' || text.length > 400) return;
        remember();
        const at = Math.max(-1, Math.min(s.lines.length - 1, afterIndex)) + 1;
        const before = at > 0 ? (s.times[at - 1] ?? 0) : 0;
        const after = at < s.times.length ? (s.times[at] ?? s.durationMs) : Math.min(s.durationMs > 0 ? s.durationMs : before + 4000, before + 4000);
        const time = at === 0 ? Math.max(0, Math.round(after - 2000)) : Math.round(before + Math.max(300, (after - before) / 2));
        const lines = [...s.lines.slice(0, at), { text, breakBefore: false } as PlainLine, ...s.lines.slice(at)];
        const times = [...s.times.slice(0, at), time, ...s.times.slice(at)];
        const confidence = [...s.confidence.slice(0, at), 1, ...s.confidence.slice(at)];
        const locks = new Set<number>();
        for (const i of s.locks) locks.add(i >= at ? i + 1 : i);
        locks.add(at);
        weights = lines.map((l) => lineWeight(l.text));
        set({ lines, times: monotonic(times, s.durationMs), confidence, locks, selected: at, save: EMPTY_SAVE });
      },

      removeLine(index) {
        const s = get();
        if (s.step !== 'timing' || s.lines.length <= 1 || index < 0 || index >= s.lines.length) return;
        remember();
        const drop = <T,>(list: readonly T[]): T[] => list.filter((_, i) => i !== index);
        const locks = new Set<number>();
        for (const i of s.locks) if (i !== index) locks.add(i > index ? i - 1 : i);
        const lines = drop(s.lines);
        weights = lines.map((l) => lineWeight(l.text));
        set({ lines, times: drop(s.times), confidence: drop(s.confidence), locks, selected: Math.min(index, lines.length - 1), save: EMPTY_SAVE });
      },

      editLine(index, rawText) {
        const s = get();
        const text = rawText.replace(/\s+/g, ' ').trim();
        const old = s.lines[index];
        if (s.step !== 'timing' || old === undefined || text === '' || text === old.text) return;
        remember();
        const lines = s.lines.map((l, i) => (i === index ? { ...l, text } : l));
        weights = lines.map((l) => lineWeight(l.text));
        set({ lines, save: EMPTY_SAVE });
      },

      markSinging(which) {
        const s = get();
        if (s.step !== 'timing') return;
        remember();
        const here = Math.max(0, Math.round(playback.getState().livePositionMs()));
        if (which === 'clear') set({ singStartMs: undefined, singEndMs: undefined });
        else if (which === 'start') set({ singStartMs: here });
        else set({ singEndMs: here });
        void resolveFrom(0);
      },

      async saveLrc() {
        const s = get();
        if (s.trackId === undefined || s.step !== 'timing' || s.save.status === 'saving') return;
        const lrc = buildLrc(
          s.lines.map((line, i) => ({ timeMs: s.times[i] ?? 0, text: line.text })),
          { ti: s.title, ar: s.artist, by: 'Nova Player Lyric Studio' },
        );
        set({ save: { status: 'saving', outcome: undefined, message: undefined } });
        let result: IpcResult<SaveLyricsResultDto> | undefined;
        try {
          result = (await bridge.invoke('lyrics:save', { trackId: s.trackId, lrc })) as IpcResult<SaveLyricsResultDto>;
        } catch {
          result = undefined;
        }
        if (result?.ok !== true) {
          set({ save: { status: 'error', outcome: undefined, message: result === undefined ? UNREACHABLE : result.error.message } });
          return;
        }
        const outcome = result.value.outcome;
        const saved = outcome === 'saved-beside' || outcome === 'saved-in-app';
        set({ save: { status: saved ? 'saved' : 'error', outcome, message: SAVE_MESSAGES[outcome] } });
        if (saved) onSaved();
      },
    };
  });
}
