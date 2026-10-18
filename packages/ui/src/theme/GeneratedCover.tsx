import { useId } from 'react';

const PALETTES: readonly (readonly [string, string, string])[] = [
  ['#5b8cff', '#8b5cf6', '#22d3ee'],
  ['#f43f78', '#f59e0b', '#8b5cf6'],
  ['#10b981', '#22d3ee', '#5b8cff'],
  ['#f59e0b', '#ef4444', '#ec4899'],
  ['#8b5cf6', '#ec4899', '#38bdf8'],
  ['#14b8a6', '#84cc16', '#0ea5e9'],
  ['#6366f1', '#06b6d4', '#f472b6'],
  ['#fb7185', '#a855f7', '#3b82f6'],
];

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * A deterministic gradient cover for tracks, albums and artists with no artwork: the same name always
 * gives the same picture. Pure SVG, no network.
 */
export function GeneratedCover({ seed, size = '100%', rounded = 14 }: { seed: string; size?: number | string; rounded?: number }) {
  const id = useId().replace(/:/g, '');
  const h = hash(seed || 'nova');
  const [a, b, c] = PALETTES[h % PALETTES.length] as readonly [string, string, string];
  const angle = (h >> 3) % 360;
  const cx = 20 + ((h >> 7) % 60);
  const cy = 20 + ((h >> 13) % 60);
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" role="presentation" aria-hidden="true" data-testid="generated-cover" style={{ display: 'block', borderRadius: rounded }}>
      <defs>
        <linearGradient id={`g${id}`} gradientTransform={`rotate(${angle} .5 .5)`}>
          <stop offset="0" stopColor={a} />
          <stop offset="1" stopColor={b} />
        </linearGradient>
        <radialGradient id={`r${id}`} cx={`${cx}%`} cy={`${cy}%`} r="55%">
          <stop offset="0" stopColor={c} stopOpacity=".85" />
          <stop offset="1" stopColor={c} stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="100" height="100" fill={`url(#g${id})`} />
      <rect width="100" height="100" fill={`url(#r${id})`} />
      <circle cx={100 - cx} cy={100 - cy} r="26" fill="none" stroke="#fff" strokeOpacity=".18" strokeWidth="1.5" />
      <circle cx={100 - cx} cy={100 - cy} r="14" fill="none" stroke="#fff" strokeOpacity=".14" strokeWidth="1.5" />
    </svg>
  );
}
