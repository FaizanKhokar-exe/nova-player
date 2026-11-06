import { useState } from 'react';
import type { IpcResult, LyricsCandidateDto, LyricsSearchResultDto, TrackDto } from '@nova/shared';
import { Icon } from '../theme/Icon.js';
import { suggestNames } from './name-clean.js';
import { usePrefs, useServices } from './services.js';

type Lookup = { readonly status: 'idle' | 'searching' | 'offline' | 'error' | 'done'; readonly candidates: readonly LyricsCandidateDto[] };

/**
 * Correct a song's title, artist and album. Three helpers find the right names: "Tidy up" removes download clutter
 * (numbers, site names, "Official Video"), "Find the right name" looks the song up online (same optional lookup as Lyric
 * Studio, with the same consent) and offers real titles to pick, and "Reset" returns to what the file's own tags say.
 * The audio file is never changed.
 */
export function EditInfoForm({ track, onClose }: { track: TrackDto; onClose: () => void }) {
  const { bridge, playback, prefs } = useServices();
  const consent = usePrefs((s) => s.lyricsSearchConsent);
  const [title, setTitle] = useState(track.title);
  const [artist, setArtist] = useState(track.artist);
  const [album, setAlbum] = useState(track.album ?? '');
  const [lookup, setLookup] = useState<Lookup>({ status: 'idle', candidates: [] });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const tidy = suggestNames(title, artist);
  const valid = title.trim() !== '' && artist.trim() !== '';

  const finish = async (): Promise<void> => {
    await playback.getState().refreshSession();
    onClose();
  };

  const save = async (): Promise<void> => {
    if (!valid || busy) return;
    setBusy(true);
    setProblem(undefined);
    let result: IpcResult<{ outcome: string }> | undefined;
    try {
      result = (await bridge.invoke('track:editInfo', { trackId: track.id, title, artist, ...(album.trim() !== '' && { album }) })) as IpcResult<{ outcome: string }>;
    } catch {
      result = undefined;
    }
    if (result?.ok === true && result.value.outcome === 'saved') return void (await finish());
    setBusy(false);
    setProblem(result?.ok === true && result.value.outcome === 'unknown' ? 'This song is no longer in the library.' : 'Could not save the names. Try again.');
  };

  const reset = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await bridge.invoke('track:resetInfo', { trackId: track.id });
    } catch {
      // nothing to undo; the dialog simply closes
    }
    await finish();
  };

  const search = async (): Promise<void> => {
    if (lookup.status === 'searching') return;
    prefs.getState().setLyricsSearchConsent(true);
    setLookup({ status: 'searching', candidates: [] });
    let result: IpcResult<LyricsSearchResultDto> | undefined;
    try {
      result = (await bridge.invoke('lyrics:search', { trackId: track.id, title: suggestNames(title, artist).title, artist: suggestNames(title, artist).artist })) as IpcResult<LyricsSearchResultDto>;
    } catch {
      result = undefined;
    }
    if (result?.ok === true) setLookup({ status: result.value.status === 'ok' ? 'done' : result.value.status === 'unavailable' ? 'error' : result.value.status, candidates: result.value.candidates });
    else setLookup({ status: result === undefined ? 'offline' : 'error', candidates: [] });
  };

  return (
    <form style={{ display: 'contents' }} onSubmit={(event) => { event.preventDefault(); void save(); }} data-testid="edit-info">
      <label className="nx-field"><span className="nx-muted">Title</span><input className="nx-input" value={title} dir="auto" data-testid="edit-title" onChange={(e) => setTitle(e.target.value)} /></label>
      <label className="nx-field"><span className="nx-muted">Artist</span><input className="nx-input" value={artist} dir="auto" data-testid="edit-artist" onChange={(e) => setArtist(e.target.value)} /></label>
      <label className="nx-field"><span className="nx-muted">Album (optional)</span><input className="nx-input" value={album} dir="auto" data-testid="edit-album" onChange={(e) => setAlbum(e.target.value)} /></label>

      <div className="nx-edit-helpers">
        <button type="button" className="nx-btn" disabled={!tidy.changed} data-testid="edit-tidy" data-tip="Removes track numbers, site names, quality tags and “Official Video”" onClick={() => { setTitle(tidy.title); setArtist(tidy.artist); }}><Icon name="sparkles" size={14} /> Tidy up</button>
        <button type="button" className="nx-btn" disabled={lookup.status === 'searching' || title.trim() === ''} data-testid="edit-find" onClick={() => void search()}><Icon name="search" size={14} /> {lookup.status === 'searching' ? 'Looking…' : 'Find the right name'}</button>
      </div>
      {!consent && lookup.status === 'idle' && <p className="nx-faint" style={{ margin: 0, fontSize: 12.5 }}>“Find the right name” sends only this title and artist to lrclib.net (a free lyrics database). Nothing else leaves your computer.</p>}
      {lookup.status === 'offline' && <p className="nx-studio-warn" role="status">Couldn’t reach the lookup service. Check your internet connection.</p>}
      {lookup.status === 'error' && <p className="nx-studio-warn" role="status">The lookup failed. Try again in a moment.</p>}
      {lookup.status === 'done' && lookup.candidates.length === 0 && <p className="nx-faint" role="status" data-testid="edit-none" style={{ margin: 0 }}>Nothing found. Try “Tidy up” first, or type the name yourself.</p>}
      {lookup.candidates.length > 0 && (
        <ul className="nx-edit-cands" data-testid="edit-candidates">
          {lookup.candidates.slice(0, 6).map((c) => (
            <li key={c.id}>
              <span className="nx-edit-cand-text" dir="auto"><b>{c.title}</b><span className="nx-muted"> — {c.artist}{c.album !== '' ? ` · ${c.album}` : ''}</span></span>
              <button type="button" className="nx-btn nx-btn--small" data-testid="edit-use" onClick={() => { setTitle(c.title); setArtist(c.artist); if (c.album !== '') setAlbum(c.album); }}>Use</button>
            </li>
          ))}
        </ul>
      )}
      {problem !== undefined && <p className="nx-studio-warn" role="alert">{problem}</p>}
      <div className="nx-modal-actions">
        <button type="button" className="nx-btn nx-btn--ghost" disabled={busy} data-testid="edit-reset" data-tip="Go back to the names stored in the file" onClick={() => void reset()}>Reset to file’s names</button>
        <span style={{ flex: 1 }} />
        <button type="button" className="nx-btn nx-btn--ghost" onClick={onClose}>Cancel</button>
        <button type="submit" className="nx-btn nx-btn--primary" disabled={!valid || busy} data-testid="edit-save">Save</button>
      </div>
    </form>
  );
}
