import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import type { LyricsCandidateDto } from '@nova/shared';
import { usePlaybackStore } from '../playback/PlaybackStoreProvider.js';
import { Icon } from '../theme/Icon.js';
import { usePrefs, useServices } from '../app/services.js';
import { LOW_CONFIDENCE } from './align.js';
import { formatLrcTime, splitLyricsText } from './lrc-format.js';
import type { StudioState } from './studio-store.js';

const useStudio = <T,>(selector: (state: StudioState) => T): T => useStore(useServices().studio, selector);

const isTyping = (target: EventTarget | null): boolean => {
  const el = target as HTMLElement | null;
  return el !== null && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable === true);
};

/* ------------------------------------------------------------------ source step ------------------------------------------------------------------ */

function CandidateRow({ candidate, chosen, onPick }: { candidate: LyricsCandidateDto; chosen: boolean; onPick: (candidate: LyricsCandidateDto, withTiming: boolean) => void }) {
  const minutes = candidate.durationSec === undefined ? '' : `${Math.floor(candidate.durationSec / 60)}:${String(candidate.durationSec % 60).padStart(2, '0')}`;
  return (
    <li className="nx-cand" data-chosen={chosen ? 'true' : 'false'} data-testid="studio-candidate">
      <div className="nx-cand-main">
        <strong dir="auto">{candidate.title}</strong>
        <span dir="auto">{[candidate.artist, candidate.album, minutes].filter((part) => part !== '').join(' · ')}</span>
        <span className="nx-cand-badges">
          <em data-level={candidate.match >= 0.85 ? 'high' : candidate.match >= 0.55 ? 'mid' : 'low'}>{Math.round(candidate.match * 100)}% match</em>
          {candidate.syncedLines !== undefined && <em data-level="sync">has timing</em>}
          {candidate.instrumental && <em data-level="low">instrumental</em>}
        </span>
      </div>
      <div className="nx-cand-actions">
        <button type="button" className="nx-btn" disabled={candidate.plain.trim() === '' && candidate.syncedLines === undefined} data-testid="studio-use-words" onClick={() => onPick(candidate, false)}>Use words</button>
        {candidate.syncedLines !== undefined && (
          <button type="button" className="nx-btn" data-testid="studio-use-timing" onClick={() => onPick(candidate, true)}>Words + its timing</button>
        )}
      </div>
    </li>
  );
}

function SourceStep() {
  const { studio, prefs } = useServices();
  const consent = usePrefs((s) => s.lyricsSearchConsent);
  const queryTitle = useStudio((s) => s.queryTitle);
  const queryArtist = useStudio((s) => s.queryArtist);
  const text = useStudio((s) => s.text);
  const search = useStudio((s) => s.search);
  const startFromSynced = useStudio((s) => s.startFromSynced);
  const lineCount = useMemo(() => splitLyricsText(text).length, [text]);
  const api = studio.getState();

  const runSearch = (): void => {
    if (!prefs.getState().lyricsSearchConsent) prefs.getState().setLyricsSearchConsent(true);
    void api.runSearch();
  };
  const statusText: Record<string, string> = {
    offline: 'Couldn’t reach the lyrics service. Check your internet connection, or paste the words instead.',
    error: 'The lyrics service gave an answer Nova Player couldn’t use. Try again, or paste the words instead.',
    unavailable: 'Online search isn’t available in this build. Paste the words instead.',
  };

  return (
    <div className="nx-studio-source">
      <section className="nx-studio-card" aria-label="Find lyrics online">
        <h3>Find the words</h3>
        <p className="nx-studio-hint">Search an open lyrics catalogue, or just paste them on the right. This is the only time Nova Player goes online.</p>
        {!consent && (
          <div className="nx-studio-consent" data-testid="studio-consent">
            Pressing Search sends this song’s <b>title, artist, album and length</b> to <b>lrclib.net</b> - nothing else, and nothing is sent unless you press it.
          </div>
        )}
        <div className="nx-studio-query">
          <label className="nx-field"><span>Title</span><input className="nx-input" value={queryTitle} data-testid="studio-query-title" dir="auto" onChange={(e) => api.setQuery(e.target.value, queryArtist)} onKeyDown={(e) => e.key === 'Enter' && runSearch()} /></label>
          <label className="nx-field"><span>Artist</span><input className="nx-input" value={queryArtist} data-testid="studio-query-artist" dir="auto" onChange={(e) => api.setQuery(queryTitle, e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runSearch()} /></label>
          <button type="button" className="nx-btn nx-btn--primary" disabled={search.status === 'searching' || queryTitle.trim() === ''} data-testid="studio-search" onClick={runSearch}>
            <Icon name="search" size={16} /> {search.status === 'searching' ? 'Searching…' : consent ? 'Search' : 'Allow & search'}
          </button>
        </div>
        <div aria-live="polite">
          {search.status === 'done' && search.candidates.length === 0 && <p className="nx-studio-note" data-testid="studio-no-results">Nothing found for that title and artist. Try fewer words (just the song name), or paste the lyrics.</p>}
          {statusText[search.status] !== undefined && <p className="nx-studio-note" data-testid={`studio-search-${search.status}`}>{statusText[search.status]}</p>}
        </div>
        {search.candidates.length > 0 && (
          <ul className="nx-cands" data-testid="studio-results">
            {search.candidates.map((c) => <CandidateRow key={c.id} candidate={c} chosen={search.chosenId === c.id} onPick={api.pickCandidate} />)}
          </ul>
        )}
      </section>

      <section className="nx-studio-card" aria-label="Lyrics text">
        <h3>The lyrics</h3>
        <p className="nx-studio-hint">One line per sung line, any language or script. Edit freely - fix spelling, remove “[Chorus]” labels, add missing lines.</p>
        <textarea className="nx-studio-text" value={text} dir="auto" spellCheck={false} placeholder={'Paste or type the lyrics here…\n\nPaste them in any language: English, اردو, हिन्दी, ਪੰਜਾਬੀ, Roman Urdu…'} data-testid="studio-text" onChange={(e) => api.setText(e.target.value)} />
        <div className="nx-studio-foot">
          <span data-testid="studio-line-count">{lineCount} {lineCount === 1 ? 'line' : 'lines'}{startFromSynced ? ' · starting from the found timing' : ''}</span>
          <button type="button" className="nx-btn nx-btn--primary" disabled={lineCount === 0} data-testid="studio-begin" onClick={() => void api.begin()}>
            <Icon name="sparkles" size={16} /> Estimate the timing
          </button>
        </div>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ timing step ------------------------------------------------------------------ */

const Row = memo(function Row({ index, text, timeMs, confidence, locked, selected, current, onSelect, onNudge, onLock, onAudition }: {
  index: number; text: string; timeMs: number; confidence: number; locked: boolean; selected: boolean; current: boolean;
  onSelect: (i: number) => void; onNudge: (i: number, delta: number) => void; onLock: (i: number) => void; onAudition: (i: number) => void;
}) {
  const low = !locked && confidence < LOW_CONFIDENCE;
  return (
    <li className="nx-srow" data-index={index} data-selected={selected ? 'true' : 'false'} data-current={current ? 'true' : 'false'} data-low={low ? 'true' : 'false'} data-locked={locked ? 'true' : 'false'} data-testid="studio-row" onClick={() => onSelect(index)}>
      <button type="button" className="nx-srow-play" aria-label="Play from this line" data-tip="Play from here (A)" onClick={(e) => { e.stopPropagation(); onAudition(index); }}><Icon name="play" size={13} /></button>
      <span className="nx-srow-time">
        <button type="button" aria-label="Earlier by 0.1 s" data-no-tip onClick={(e) => { e.stopPropagation(); onNudge(index, -100); }}><Icon name="chevronLeft" size={13} /></button>
        <b data-testid="studio-time">{formatLrcTime(timeMs)}</b>
        <button type="button" aria-label="Later by 0.1 s" data-no-tip onClick={(e) => { e.stopPropagation(); onNudge(index, 100); }}><Icon name="chevronRight" size={13} /></button>
      </span>
      <span className="nx-srow-text" dir="auto">{text}</span>
      {low && <span className="nx-srow-flag" data-tip="Not sure about this one - listen and fix it">check</span>}
      <button type="button" className="nx-srow-lock" data-on={locked ? 'true' : 'false'} aria-pressed={locked} aria-label={locked ? 'Unlock this line (it may move when re-estimating)' : 'Lock this line in place'} data-tip={locked ? 'Locked (L)' : 'Lock (L)'} onClick={(e) => { e.stopPropagation(); onLock(index); }}>
        <Icon name={locked ? 'check' : 'plus'} size={13} />
      </button>
    </li>
  );
});

function Strip() {
  const { studio, playback } = useServices();
  const overview = useStudio((s) => s.overview);
  const times = useStudio((s) => s.times);
  const durationMs = useStudio((s) => s.durationMs);
  const head = useRef<HTMLDivElement | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext('2d');
    if (el === null || el === undefined || ctx === null || ctx === undefined) return;
    const { width, height } = el;
    ctx.clearRect(0, 0, width, height);
    const accent = getComputedStyle(el).getPropertyValue('--accent-primary').trim() || '#5b8cff';
    ctx.fillStyle = accent;
    ctx.globalAlpha = 0.55;
    const bar = width / Math.max(1, overview.length);
    overview.forEach((v, i) => {
      const h = Math.max(2, v * (height - 6));
      ctx.fillRect(i * bar, (height - h) / 2, Math.max(1, bar - 1), h);
    });
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#fff';
    if (durationMs > 0) for (const t of times) ctx.fillRect(Math.round((t / durationMs) * width), 0, 1.5, height);
  }, [overview, times, durationMs]);

  useEffect(() => {
    let frame = 0;
    const tick = (): void => {
      if (head.current !== null && durationMs > 0) head.current.style.left = `${Math.min(100, (playback.getState().livePositionMs() / durationMs) * 100)}%`;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playback, durationMs]);

  return (
    <div className="nx-strip" data-testid="studio-strip" onClick={(e) => {
      const box = e.currentTarget.getBoundingClientRect();
      if (durationMs > 0) playback.getState().seekMs(Math.round(((e.clientX - box.left) / box.width) * durationMs));
    }}>
      <canvas ref={canvas} width={960} height={64} aria-hidden="true" />
      <div ref={head} className="nx-strip-head" />
      <span className="nx-strip-sel" style={{ left: `${durationMs > 0 ? ((times[studio.getState().selected] ?? 0) / durationMs) * 100 : 0}%` }} />
    </div>
  );
}

function TimingStep() {
  const { studio, playback } = useServices();
  const lines = useStudio((s) => s.lines);
  const times = useStudio((s) => s.times);
  const confidence = useStudio((s) => s.confidence);
  const locks = useStudio((s) => s.locks);
  const selected = useStudio((s) => s.selected);
  const failed = useStudio((s) => s.analysisFailed);
  const canUndo = useStudio((s) => s.canUndo);
  const save = useStudio((s) => s.save);
  const playing = usePlaybackStore((s) => s.engine.playing);
  const [now, setNow] = useState(0);
  const list = useRef<HTMLUListElement | null>(null);
  const api = studio.getState();

  // The line being sung right now (follows the exact playhead, ~15 times a second).
  useEffect(() => {
    const timer = setInterval(() => setNow(playback.getState().livePositionMs()), 66);
    return () => clearInterval(timer);
  }, [playback]);
  let currentIndex = -1;
  for (let i = 0; i < times.length; i += 1) if ((times[i] ?? 0) <= now) currentIndex = i;

  useEffect(() => {
    const row = list.current?.querySelector<HTMLElement>(`[data-index="${selected}"]`);
    if (row !== null && row !== undefined && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const lowCount = lines.reduce((n, _l, i) => n + (!locks.has(i) && (confidence[i] ?? 1) < LOW_CONFIDENCE ? 1 : 0), 0);
  const onSelect = useCallback((i: number) => studio.getState().select(i), [studio]);
  const onNudge = useCallback((i: number, d: number) => studio.getState().nudge(i, d), [studio]);
  const onLock = useCallback((i: number) => studio.getState().toggleLock(i), [studio]);
  const onAudition = useCallback((i: number) => studio.getState().audition(i), [studio]);

  return (
    <div className="nx-studio-timing">
      {failed && <p className="nx-studio-warn" data-testid="studio-analysis-failed">The song’s audio couldn’t be analysed, so these times are only evenly spaced guesses. Play the song and stamp each line yourself.</p>}
      <Strip />
      <div className="nx-studio-bar">
        <button type="button" className="nx-btn" onClick={() => void playback.getState().togglePlay()} data-testid="studio-play" aria-label={playing ? 'Pause' : 'Play'}><Icon name={playing ? 'pause' : 'play'} size={15} /> {playing ? 'Pause' : 'Play'}</button>
        <button type="button" className="nx-btn nx-btn--primary" data-testid="studio-stamp" data-tip="Start of the selected line is NOW (Enter)" onClick={() => api.stamp()}><Icon name="check" size={15} /> Stamp line {selected + 1}</button>
        <button type="button" className="nx-btn" disabled={!canUndo} data-testid="studio-undo" onClick={() => api.undo()}><Icon name="refresh" size={15} /> Undo</button>
        <button type="button" className="nx-btn" data-testid="studio-reestimate" data-tip="Estimate again - locked lines stay where they are" onClick={() => api.reestimate()}><Icon name="sparkles" size={15} /> Re-estimate</button>
        <span className="nx-studio-shift" role="group" aria-label="Move all lines">
          <button type="button" className="nx-btn" aria-label="All lines 0.5 s earlier" onClick={() => api.shiftAll(-500)}>−0.5 s</button>
          <button type="button" className="nx-btn" aria-label="All lines 0.5 s later" onClick={() => api.shiftAll(500)}>+0.5 s</button>
        </span>
        <span className="nx-studio-spacer" />
        <button type="button" className="nx-btn nx-btn--primary" disabled={save.status === 'saving'} data-testid="studio-save" onClick={() => void api.saveLrc()}><Icon name="upload" size={15} /> {save.status === 'saving' ? 'Saving…' : 'Save lyrics'}</button>
      </div>
      <p className="nx-studio-keys">
        <kbd>Space</kbd> play/pause · <kbd>Enter</kbd> stamp the selected line as it begins · <kbd>↑</kbd><kbd>↓</kbd> select · <kbd>←</kbd><kbd>→</kbd> nudge 0.1 s (<kbd>Shift</kbd> 0.5 s) · <kbd>A</kbd> hear it · <kbd>L</kbd> lock · <kbd>Ctrl</kbd>+<kbd>Z</kbd> undo
        {lowCount > 0 && <b data-testid="studio-low-count"> · {lowCount} {lowCount === 1 ? 'line' : 'lines'} to check</b>}
      </p>
      {save.message !== undefined && <p className="nx-studio-result" role="status" data-status={save.status} data-testid="studio-save-result">{save.message}</p>}
      <ul className="nx-srows" ref={list} data-testid="studio-rows">
        {lines.map((line, i) => (
          <Row key={i} index={i} text={line.text} timeMs={times[i] ?? 0} confidence={confidence[i] ?? 0} locked={locks.has(i)} selected={i === selected} current={i === currentIndex} onSelect={onSelect} onNudge={onNudge} onLock={onLock} onAudition={onAudition} />
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ shell ------------------------------------------------------------------ */

export function LyricStudio() {
  const { studio, playback } = useServices();
  const open = useStudio((s) => s.open);
  const step = useStudio((s) => s.step);
  const title = useStudio((s) => s.title);
  const artist = useStudio((s) => s.artist);
  const progress = useStudio((s) => s.progress);
  const saveStatus = useStudio((s) => s.save.status);
  const [confirmClose, setConfirmClose] = useState(false);

  const requestClose = useCallback(() => {
    const s = studio.getState();
    if (s.step === 'timing' && s.save.status !== 'saved' && s.canUndo) setConfirmClose(true);
    else s.close();
  }, [studio]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      const s = studio.getState();
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (confirmClose) setConfirmClose(false);
        else requestClose();
        return;
      }
      if (s.step !== 'timing' || isTyping(event.target)) return;
      const el = event.target as HTMLElement;
      const ctrl = event.ctrlKey || event.metaKey;
      const handled = (): void => {
        event.preventDefault();
        event.stopPropagation();
      };
      if (ctrl && event.key.toLowerCase() === 'z') { handled(); s.undo(); return; }
      if (ctrl || event.altKey) return;
      switch (event.key) {
        case ' ': if (el.tagName === 'BUTTON') return; handled(); void playback.getState().togglePlay(); return;
        case 'Enter': if (el.tagName === 'BUTTON') return; handled(); s.stamp(); return;
        case 'ArrowDown': handled(); s.select(s.selected + 1); return;
        case 'ArrowUp': handled(); s.select(s.selected - 1); return;
        case 'ArrowLeft': handled(); s.nudge(s.selected, event.shiftKey ? -500 : -100); return;
        case 'ArrowRight': handled(); s.nudge(s.selected, event.shiftKey ? 500 : 100); return;
      }
      switch (event.key.toLowerCase()) {
        case 'a': handled(); s.audition(s.selected); return;
        case 'l': handled(); s.toggleLock(s.selected); return;
        case 't': handled(); s.stamp(); return;
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, studio, playback, requestClose, confirmClose]);

  if (!open) return null;
  return (
    <div className="nx-studio" role="dialog" aria-modal="true" aria-label="Lyric Studio" data-testid="lyric-studio" data-step={step}>
      <header className="nx-studio-top">
        <div>
          <h2><Icon name="lyrics" size={20} /> Lyric Studio</h2>
          <span className="nx-studio-song" dir="auto">{title} · {artist}</span>
        </div>
        <div className="nx-studio-steps" aria-hidden="true">
          <span data-on={step === 'source'}>1 Words</span><span data-on={step !== 'source'}>2 Timing</span>
        </div>
        {step === 'timing' && <button type="button" className="nx-btn" data-testid="studio-back" onClick={() => studio.getState().backToSource()}><Icon name="chevronLeft" size={15} /> Words</button>}
        <button type="button" className="nx-btn" aria-label="Close Lyric Studio" data-testid="studio-close" onClick={requestClose}><Icon name="close" size={16} /></button>
      </header>
      {confirmClose && (
        <div className="nx-studio-confirm" role="alertdialog" aria-label="Discard your timing?" data-testid="studio-confirm">
          <span>You haven’t saved this timing yet. Discard it?</span>
          <button type="button" className="nx-btn" onClick={() => setConfirmClose(false)}>Keep editing</button>
          <button type="button" className="nx-btn nx-btn--primary" data-testid="studio-discard" onClick={() => { setConfirmClose(false); studio.getState().close(); }}>Discard</button>
        </div>
      )}
      <div className="nx-studio-body" data-saved={saveStatus === 'saved'}>
        {step === 'source' && <SourceStep />}
        {step === 'analysing' && (
          <div className="nx-studio-analysing" role="status" data-testid="studio-analysing">
            <Icon name="sparkles" size={30} />
            <p>Listening to the song to find where each line starts…</p>
            <div className="nx-progress"><i style={{ width: `${Math.round(progress * 100)}%` }} /></div>
            <small>This happens on your computer. Nothing is uploaded.</small>
          </div>
        )}
        {step === 'timing' && <TimingStep />}
      </div>
    </div>
  );
}
