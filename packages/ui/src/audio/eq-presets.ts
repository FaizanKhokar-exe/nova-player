/** The ten-band equaliser: centre frequencies (Hz) and the named presets (dB per band, -12..+12). */
export const EQ_BANDS = [31, 62, 125, 250, 500, 1_000, 2_000, 4_000, 8_000, 16_000] as const;
export const EQ_BAND_LABELS = ['31', '62', '125', '250', '500', '1k', '2k', '4k', '8k', '16k'] as const;
export const EQ_MIN_DB = -12;
export const EQ_MAX_DB = 12;

export interface EqPreset {
  readonly id: string;
  readonly label: string;
  readonly gains: readonly number[];
}

export const EQ_PRESETS: readonly EqPreset[] = [
  { id: 'flat', label: 'Flat', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { id: 'bass', label: 'Bass boost', gains: [7, 6, 5, 3, 1, 0, 0, 0, 0, 0] },
  { id: 'treble', label: 'Treble boost', gains: [0, 0, 0, 0, 0, 1, 3, 5, 6, 7] },
  { id: 'vocal', label: 'Vocal', gains: [-3, -2, -1, 1, 3, 4, 4, 2, 0, -1] },
  { id: 'rock', label: 'Rock', gains: [5, 4, 2, -1, -2, 1, 3, 4, 5, 5] },
  { id: 'pop', label: 'Pop', gains: [-1, 1, 3, 4, 3, 0, -1, -1, 1, 2] },
  { id: 'jazz', label: 'Jazz', gains: [3, 2, 1, 2, -2, -2, 0, 1, 2, 3] },
  { id: 'classical', label: 'Classical', gains: [4, 3, 2, 1, -1, -1, 0, 2, 3, 4] },
  { id: 'electronic', label: 'Electronic', gains: [6, 5, 1, 0, -2, 2, 1, 2, 5, 6] },
  { id: 'lounge', label: 'Late night', gains: [3, 2, 1, 0, 0, 0, -1, -2, -2, -3] },
];

export const clampDb = (value: number): number => (Number.isFinite(value) ? Math.min(EQ_MAX_DB, Math.max(EQ_MIN_DB, Math.round(value * 2) / 2)) : 0);

/** The preset id whose gains equal `gains`, or `custom`. */
export function matchPreset(gains: readonly number[]): string {
  return EQ_PRESETS.find((preset) => preset.gains.length === gains.length && preset.gains.every((g, i) => g === gains[i]))?.id ?? 'custom';
}

/**
 * Automatic headroom: boosting a band raises the loudest peaks and can clip. The pre-amp lowers everything by the
 * largest boost (never raises), so no preset ever distorts. Returns a linear gain (<= 1).
 */
export function preampFor(gains: readonly number[]): number {
  const boost = Math.max(0, ...gains);
  return 10 ** (-boost / 20);
}
