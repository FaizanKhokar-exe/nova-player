import { memo, useMemo } from 'react';
import { formatClock } from '../library/format.js';

/** One bar per slice of the song; `lyric` is how many lyric lines start in that slice (0..1 after scaling). */
const Bars = memo(function Bars({ profile, lyric }: { profile: readonly number[] | undefined; lyric: readonly number[] }) {
  const count = profile?.length ?? lyric.length;
  return (
    <div className="nx-seekprev-bars" data-testid="seek-preview-bars" data-ready={profile !== undefined}>
      {Array.from({ length: count }, (_, i) => {
        const energy = profile?.[i];
        const vocal = lyric[i] ?? 0;
        return (
          <i key={i} className="nx-seekprev-bar" data-vocal={vocal > 0.05 ? 'true' : 'false'} style={{ height: `${Math.max(6, Math.round((energy ?? 0.18) * 100))}%`, ['--vocal' as string]: vocal.toFixed(2) }} />
        );
      })}
    </div>
  );
});

/** Lyric lines per slice, scaled 0..1 against the busiest slice. */
export function lyricDensity(lineTimesMs: readonly number[], durationMs: number, buckets: number): number[] {
  const counts = new Array<number>(buckets).fill(0);
  if (durationMs <= 0) return counts;
  for (const time of lineTimesMs) {
    const index = Math.min(buckets - 1, Math.max(0, Math.floor((time / durationMs) * buckets)));
    counts[index] = (counts[index] ?? 0) + 1;
  }
  const peak = Math.max(1, ...counts);
  return counts.map((c) => c / peak);
}

/** Floats above the seek bar while the pointer is over it: where the song is loud (bars) and where the words are (coloured bars), with the time under the pointer. */
export function SeekPreview({ fraction, profile, lineTimesMs, durationMs, analysing }: { fraction: number; profile: readonly number[] | undefined; lineTimesMs: readonly number[]; durationMs: number; analysing: boolean }) {
  const buckets = profile?.length ?? 80;
  const lyric = useMemo(() => lyricDensity(lineTimesMs, durationMs, buckets), [lineTimesMs, durationMs, buckets]);
  const clamped = Math.min(1, Math.max(0, fraction));
  const index = Math.min(buckets - 1, Math.floor(clamped * buckets));
  const energy = profile?.[index];
  const words = (lyric[index] ?? 0) > 0.05;
  return (
    <div className="nx-seekprev" role="presentation" data-testid="seek-preview" data-analysing={analysing}>
      <div className="nx-seekprev-chip" style={{ left: `clamp(48px, ${clamped * 100}%, calc(100% - 48px))` }}>
        <b>{formatClock(Math.round(clamped * durationMs))}</b>
        <span>{analysing ? 'Reading the song…' : energy === undefined ? '' : `${energy > 0.72 ? 'Loud' : energy > 0.4 ? 'Medium' : 'Soft'}${lineTimesMs.length > 0 ? (words ? ' · lyrics' : ' · instrumental') : ''}`}</span>
      </div>
      <Bars profile={profile} lyric={lyric} />
      <i className="nx-seekprev-cursor" style={{ left: `${clamped * 100}%` }} />
    </div>
  );
}
