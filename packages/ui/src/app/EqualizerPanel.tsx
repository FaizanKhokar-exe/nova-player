import { EQ_BAND_LABELS, EQ_MAX_DB, EQ_MIN_DB, EQ_PRESETS, matchPreset } from '../audio/eq-presets.js';
import { usePrefs, useServices } from './services.js';

/** The equalizer: on/off, presets and ten band sliders. Shown in Settings and in the player bar's popover, so both always agree (one store). */
export function EqualizerPanel({ testIdPrefix = 'eq' }: { testIdPrefix?: string }) {
  const { prefs } = useServices();
  const enabled = usePrefs((s) => s.eqEnabled);
  const gains = usePrefs((s) => s.eqGains);
  const preset = matchPreset(gains);
  return (
    <div className="nx-eqpanel" data-testid={`${testIdPrefix}-panel`}>
      <div className="nx-eq-head">
        <span className="nx-muted">Boosts are balanced automatically so loud songs never distort.</span>
        <button type="button" role="switch" aria-checked={enabled} aria-label="Equalizer" className="nx-switch" data-testid={`${testIdPrefix}-switch`} onClick={() => prefs.getState().setEqEnabled(!enabled)} />
      </div>
      <div className="nx-chips" role="group" aria-label="Equalizer presets">
        {EQ_PRESETS.map((item) => (
          <button key={item.id} type="button" className="nx-pill" aria-pressed={preset === item.id} onClick={() => { prefs.getState().setEqGains(item.gains); prefs.getState().setEqEnabled(item.id !== 'flat' || enabled); }}>{item.label}</button>
        ))}
        {preset === 'custom' && <span className="nx-pill" aria-pressed="true">Custom</span>}
      </div>
      <div className="nx-eq" role="group" aria-label="Equalizer bands" style={{ opacity: enabled ? 1 : 0.5 }}>
        {EQ_BAND_LABELS.map((label, index) => (
          <div key={label} className="nx-eq-band">
            <output>{(gains[index] as number) > 0 ? '+' : ''}{gains[index]}</output>
            <input type="range" min={EQ_MIN_DB} max={EQ_MAX_DB} step={0.5} value={gains[index] as number} aria-label={`${label} Hz`} data-testid={`${testIdPrefix}-band-${index}`} onChange={(event) => { prefs.getState().setEqBand(index, Number(event.currentTarget.value)); prefs.getState().setEqEnabled(true); }} />
            <span>{label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
