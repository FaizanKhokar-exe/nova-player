import { SHORTCUT_HELP } from '../shortcuts.js';
import type { ReactNode } from 'react';
import { useStore } from 'zustand';
import { EQ_BAND_LABELS, EQ_PRESETS, EQ_MAX_DB, EQ_MIN_DB, matchPreset } from '../../audio/eq-presets.js';
import { baseName, plural } from '../../library/format.js';
import { useLibraryStore } from '../../library/LibraryStoreProvider.js';
import { SPEEDS, WALLPAPER_BLUR_RANGE, WALLPAPER_DIM_RANGE, type PerformanceMode, type VisualizerStyle, type LyricsBackdrop } from '../../prefs/prefs-store.js';
import { Icon } from '../../theme/Icon.js';
import { LYRICS_SIZE_RANGE, SWATCHES } from '../../theme/theme-store.js';
import { useCollections } from '../../collections/CollectionsStoreProvider.js';
import { useActions, addFolderAndScan } from '../actions.js';
import { usePrefs, useServices } from '../services.js';

function Setting({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="nx-setting">
      <div className="nx-setting-text">
        <span className="nx-h3">{title}</span>
        {hint !== undefined && <span className="nx-muted" style={{ fontSize: 13 }}>{hint}</span>}
      </div>
      <div className="nx-setting-control">{children}</div>
    </div>
  );
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} className="nx-switch" onClick={() => onChange(!checked)} />;
}

function Chips<T extends string>({ value, options, onChange, label }: { value: T; options: ReadonlyArray<{ id: T; label: string }>; onChange: (value: T) => void; label: string }) {
  return (
    <div className="nx-chips" role="group" aria-label={label}>
      {options.map((option) => (
        <button key={option.id} type="button" className="nx-pill" aria-pressed={value === option.id} onClick={() => onChange(option.id)}>{option.label}</button>
      ))}
    </div>
  );
}

function Slider({ value, min, max, step = 1, onChange, label, format }: { value: number; min: number; max: number; step?: number; onChange: (value: number) => void; label: string; format?: (value: number) => string }) {
  return (
    <>
      <input type="range" className="nx-range" style={{ width: 170, ['--fill' as string]: `${((value - min) / (max - min)) * 100}%` }} min={min} max={max} step={step} value={value} aria-label={label} onChange={(event) => onChange(Number(event.currentTarget.value))} />
      <span className="nx-time" style={{ minWidth: 44 }}>{format === undefined ? value : format(value)}</span>
    </>
  );
}

export function SettingsView() {
  const { theme, prefs, wallpaper: wallpaperStore, library, collections } = useServices();
  const actions = useActions();
  const mode = useStore(theme, (s) => s.mode);
  const accent = useStore(theme, (s) => s.accent);
  const customColor = useStore(theme, (s) => s.customColor);
  const reduceMotion = useStore(theme, (s) => s.reduceMotion);
  const lyricsSize = useStore(theme, (s) => s.lyricsSize);
  const p = usePrefs((s) => s);
  const wallpaper = useStore(wallpaperStore, (s) => s.wallpaper);
  const wallpaperBusy = useStore(wallpaperStore, (s) => s.busy);
  const wallpaperMessage = useStore(wallpaperStore, (s) => s.message);
  const roots = useLibraryStore((s) => s.roots);
  const scanPhase = useLibraryStore((s) => s.scan.phase);
  const lastScan = useLibraryStore((s) => s.scan.last);
  const watching = useLibraryStore((s) => s.watcher.status);
  const historyCount = useCollections((s) => s.history.items.length);
  const preset = matchPreset(p.eqGains);
  const hasWallpaper = wallpaper?.status === 'set';

  return (
    <div className="nx-page nx-settings" data-testid="view-settings">
      <h1 className="nx-h1">Settings</h1>

      <section className="nx-card" aria-labelledby="set-appearance">
        <h2 className="nx-h2" id="set-appearance">Appearance</h2>
        <Setting title="Theme" hint="Dark is easiest on the eyes at night; Light suits a bright room.">
          <Chips label="Theme" value={mode} options={[{ id: 'dark', label: 'Dark' }, { id: 'light', label: 'Light' }]} onChange={(value) => theme.getState().setMode(value)} />
        </Setting>
        <Setting title="Accent colour" hint="Dynamic follows the cover art of the song that is playing.">
          <div className="nx-swatches" role="group" aria-label="Accent colour">
            <button type="button" className="nx-swatch nx-swatch--dynamic" aria-label="Dynamic (from cover art)" title="Dynamic (from cover art)" data-testid="accent-dynamic" aria-pressed={accent === 'dynamic'} onClick={() => theme.getState().setAccent('dynamic')} />
            {SWATCHES.map((swatch) => (
              <button key={swatch.id} type="button" className="nx-swatch" style={{ background: swatch.color }} aria-label={swatch.label} title={swatch.label} aria-pressed={accent === swatch.id} onClick={() => theme.getState().setAccent(swatch.id)} />
            ))}
            <label className="nx-swatch" style={{ background: customColor, position: 'relative', overflow: 'hidden', cursor: 'pointer' }} aria-pressed={accent === 'custom'} title="Custom colour">
              <input type="color" aria-label="Custom accent colour" value={customColor} onChange={(event) => theme.getState().setCustomColor(event.currentTarget.value)} style={{ opacity: 0, position: 'absolute', inset: 0, width: '100%', height: '100%', cursor: 'pointer' }} />
            </label>
          </div>
        </Setting>
        <Setting title="Lyrics size" hint="How large the lyrics are in Now Playing.">
          <Slider label="Lyrics size" value={lyricsSize} min={LYRICS_SIZE_RANGE.min} max={LYRICS_SIZE_RANGE.max} onChange={(value) => theme.getState().setLyricsSize(value)} format={(v) => `${v}px`} />
        </Setting>
        <Setting title="Reduce motion" hint="Turns off animations and the beat-reactive effects.">
          <Switch label="Reduce motion" checked={reduceMotion} onChange={(value) => theme.getState().setReduceMotion(value)} />
        </Setting>
      </section>

      <section className="nx-card" aria-labelledby="set-wallpaper" data-testid="wallpaper-settings">
        <h2 className="nx-h2" id="set-wallpaper">Wallpaper</h2>
        <div className="nx-wall-preview" data-testid="wallpaper-preview">
          {hasWallpaper && p.wallpaperEnabled ? (
            <>
              <div className="nx-wall-img" style={{ backgroundImage: `url("${wallpaper.dataUrl}")`, filter: `blur(${p.wallpaperBlur / 2}px)` }} />
              <div className="nx-wall-dim" style={{ opacity: p.wallpaperDim / 100 }} />
              <span style={{ color: '#fff', textShadow: '0 1px 8px rgba(0,0,0,.6)' }}>Preview</span>
            </>
          ) : (
            <span>{hasWallpaper ? 'Wallpaper is switched off' : 'No wallpaper chosen'}</span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button type="button" className="nx-btn nx-btn--primary" disabled={wallpaperBusy} data-testid="wallpaper-choose" onClick={() => void wallpaperStore.getState().choose()}>
            <Icon name="image" size={16} /> {hasWallpaper ? 'Change picture…' : 'Choose a picture…'}
          </button>
          <button type="button" className="nx-btn" disabled={!hasWallpaper} data-testid="wallpaper-remove" onClick={() => void wallpaperStore.getState().clear()}>Remove</button>
        </div>
        {wallpaperMessage !== undefined && (
          <div className={wallpaperMessage.tone === 'error' ? 'nx-banner' : 'nx-tag'} role={wallpaperMessage.tone === 'error' ? 'alert' : 'status'} data-testid="wallpaper-message" style={wallpaperMessage.tone === 'ok' ? { color: 'var(--ok)' } : undefined}>
            <span>{wallpaperMessage.text}</span>
          </div>
        )}
        <Setting title="Show wallpaper"><Switch label="Show wallpaper" checked={p.wallpaperEnabled} onChange={(value) => prefs.getState().setWallpaperEnabled(value)} /></Setting>
        <Setting title="Darken" hint="Keeps text readable on bright pictures.">
          <Slider label="Wallpaper darkening" value={p.wallpaperDim} min={WALLPAPER_DIM_RANGE.min} max={WALLPAPER_DIM_RANGE.max} onChange={(value) => prefs.getState().setWallpaperDim(value)} format={(v) => `${v}%`} />
        </Setting>
        <Setting title="Blur">
          <Slider label="Wallpaper blur" value={p.wallpaperBlur} min={WALLPAPER_BLUR_RANGE.min} max={WALLPAPER_BLUR_RANGE.max} onChange={(value) => prefs.getState().setWallpaperBlur(value)} format={(v) => `${v}px`} />
        </Setting>
        <p className="nx-faint" style={{ margin: 0, fontSize: 12.5 }} data-testid="wallpaper-limits">
          Limits: PNG or JPEG, up to 12 MB, at least 800 × 450 and at most 10,000 pixels on a side. The picture is copied into Nova Player at a reduced size; your original file is never changed.
        </p>
      </section>

      <section className="nx-card" aria-labelledby="set-audio" data-testid="audio-settings">
        <h2 className="nx-h2" id="set-audio">Audio</h2>
        <Setting title="Equalizer" hint="Ten bands. Boosts are balanced automatically so loud songs never distort.">
          <Switch label="Equalizer" checked={p.eqEnabled} onChange={(value) => prefs.getState().setEqEnabled(value)} />
        </Setting>
        <div className="nx-chips" role="group" aria-label="Equalizer presets">
          {EQ_PRESETS.map((item) => (
            <button key={item.id} type="button" className="nx-pill" aria-pressed={preset === item.id} onClick={() => { prefs.getState().setEqGains(item.gains); prefs.getState().setEqEnabled(item.id !== 'flat' || p.eqEnabled); }}>{item.label}</button>
          ))}
          {preset === 'custom' && <span className="nx-pill" aria-pressed="true">Custom</span>}
        </div>
        <div className="nx-eq" role="group" aria-label="Equalizer bands" style={{ opacity: p.eqEnabled ? 1 : 0.5 }}>
          {EQ_BAND_LABELS.map((label, index) => (
            <div key={label} className="nx-eq-band">
              <output>{(p.eqGains[index] as number) > 0 ? '+' : ''}{p.eqGains[index]}</output>
              <input type="range" min={EQ_MIN_DB} max={EQ_MAX_DB} step={0.5} value={p.eqGains[index] as number} aria-label={`${label} Hz`} data-testid={`eq-band-${index}`} onChange={(event) => { prefs.getState().setEqBand(index, Number(event.currentTarget.value)); prefs.getState().setEqEnabled(true); }} />
              <span>{label}</span>
            </div>
          ))}
        </div>
        <Setting title="Playback speed" hint="Pitch stays natural.">
          <Chips label="Playback speed" value={String(p.speed)} options={SPEEDS.map((s) => ({ id: String(s), label: s === 1 ? 'Normal' : `${s}×` }))} onChange={(value) => prefs.getState().setSpeed(Number(value))} />
        </Setting>
      </section>

      <section className="nx-card" aria-labelledby="set-visuals" data-testid="visual-settings">
        <h2 className="nx-h2" id="set-visuals">Visuals &amp; performance</h2>
        <Setting title="Spectrum style">
          <Chips<VisualizerStyle> label="Spectrum style" value={p.visualizer} options={[{ id: 'bars', label: 'Bars' }, { id: 'wave', label: 'Wave' }, { id: 'ring', label: 'Ring' }]} onChange={(value) => prefs.getState().setVisualizer(value)} />
        </Setting>
        <Setting title="Spectrum in the player bar"><Switch label="Spectrum in the player bar" checked={p.dockSpectrum} onChange={(value) => prefs.getState().setDockSpectrum(value)} /></Setting>
        <Setting title="Lyrics Mode backdrop" hint="What moves behind the lyrics in Lyrics Mode.">
          <Chips<LyricsBackdrop> label="Lyrics Mode backdrop" value={p.lyricsBackdrop} options={[{ id: 'particles', label: 'Particles' }, { id: 'aurora', label: 'Aurora glow' }, { id: 'plain', label: 'Still' }]} onChange={(value) => prefs.getState().setLyricsBackdrop(value)} />
        </Setting>
        <Setting title="Blur lines not being sung" hint="Soft depth effect on the surrounding lyrics."><Switch label="Blur lines not being sung" checked={p.lyricsDepthBlur} onChange={(value) => prefs.getState().setLyricsDepthBlur(value)} /></Setting>
        <Setting title="Performance" hint="Auto lowers effects by itself on slower computers. Low is the lightest.">
          <Chips<PerformanceMode> label="Performance" value={p.performance} options={[{ id: 'auto', label: 'Auto' }, { id: 'high', label: 'High' }, { id: 'balanced', label: 'Balanced' }, { id: 'low', label: 'Low' }]} onChange={(value) => prefs.getState().setPerformance(value)} />
        </Setting>
      </section>

      <section className="nx-card" aria-labelledby="set-library" data-testid="library-settings">
        <h2 className="nx-h2" id="set-library">Library</h2>
        {roots.length === 0 && <p className="nx-muted" style={{ margin: 0 }}>No music folders yet.</p>}
        {roots.map((root) => (
          <div key={root.id} className="nx-setting" data-testid="root-row">
            <div className="nx-setting-text">
              <span className="nx-h3 nx-ellipsis nx-text" title={root.path}>{baseName(root.path)}</span>
              <span className="nx-muted nx-ellipsis" style={{ fontSize: 12.5 }}>{root.path} · {plural(root.trackCount, 'song')}{root.available ? '' : ' · folder not available'}</span>
            </div>
            <div className="nx-setting-control">
              <button type="button" className="nx-btn nx-btn--small" disabled={scanPhase !== 'idle'} onClick={() => void library.getState().startScan(root.id)}>Scan</button>
              <button type="button" className="nx-btn nx-btn--small nx-btn--danger" aria-label={`Remove ${baseName(root.path)}`} onClick={() => actions.confirmRemoveRoot(root.id, baseName(root.path))}>Remove</button>
            </div>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button type="button" className="nx-btn nx-btn--primary" data-testid="settings-add-folder" onClick={() => void addFolderAndScan(library)}><Icon name="folder" size={16} /> Add folder</button>
          <button type="button" className="nx-btn" disabled={roots.length === 0 || scanPhase !== 'idle'} onClick={() => void library.getState().startScan()}>Scan all</button>
          {scanPhase === 'running' && <button type="button" className="nx-btn nx-btn--danger" onClick={() => void library.getState().cancelScan()}>Cancel scan</button>}
        </div>
        <Setting title="Watch folders for changes" hint="New songs appear automatically while Nova Player is open.">
          <Switch label="Watch folders for changes" checked={watching?.running === true} onChange={(value) => void (value ? library.getState().startWatching() : library.getState().stopWatching())} />
        </Setting>
        {lastScan !== undefined && <span className="nx-faint" style={{ fontSize: 12.5 }}>Last scan: {lastScan.status}.</span>}
      </section>

      <section className="nx-card" aria-labelledby="set-data">
        <h2 className="nx-h2" id="set-data">Data</h2>
        <Setting title="Recently played" hint={`${plural(historyCount, 'song')} remembered on this computer.`}>
          <button type="button" className="nx-btn nx-btn--small" onClick={() => actions.askClear()}>Clear history</button>
        </Setting>
        <Setting title="Reset preferences" hint="Restores the default look, audio and visual choices. Your library and playlists are not touched.">
          <button type="button" className="nx-btn nx-btn--small" data-testid="reset-prefs" onClick={() => { prefs.getState().resetAll(); theme.getState().setMode('dark'); theme.getState().setAccent('dynamic'); theme.getState().setReduceMotion(false); theme.getState().setLyricsSize(34); void collections; }}>Reset</button>
        </Setting>
      </section>

      <section className="nx-card" aria-labelledby="set-keys">
        <h2 className="nx-h2" id="set-keys">Keyboard shortcuts</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '10px 28px' }}>
          {SHORTCUT_HELP.map(([name, keys]) => (
            <div key={name} className="nx-setting" style={{ minHeight: 28 }}><span className="nx-muted">{name}</span><kbd className="nx-kbd">{keys}</kbd></div>
          ))}
        </div>
      </section>
    </div>
  );
}
