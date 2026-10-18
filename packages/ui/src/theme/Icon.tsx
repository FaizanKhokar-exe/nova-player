import type { CSSProperties } from 'react';

/** Stroke icons (24px grid). Decorative: always `aria-hidden`; the button that holds one carries the name. */
const PATHS = {
  home: 'M3 11.5 12 4l9 7.500V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  tracks: 'M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zm12-2a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  albums: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  artists: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-8 9a8 8 0 0 1 16 0',
  genres: 'M4 6h16M4 12h16M4 18h10',
  queue: 'M3 6h13M3 12h13M3 18h8m8-6v6m-3-3h6',
  nowplaying: 'M2 12h3l2-7 4 14 3-10 2 5h6',
  lyrics: 'M4 6h16M4 11h10M4 16h16M4 21h8',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm7.400-3a7.400 7.400 0 0 0-.1-1.200l2-1.600-2-3.400-2.400 1a7 7 0 0 0-2-1.200L14.500 3h-4l-.4 2.600a7 7 0 0 0-2 1.200l-2.400-1-2 3.400 2 1.600a7.400 7.400 0 0 0 0 2.400l-2 1.600 2 3.400 2.400-1a7 7 0 0 0 2 1.200l.4 2.600h4l.4-2.600a7 7 0 0 0 2-1.200l2.400 1 2-3.400-2-1.600c.1-.4.1-.8.1-1.200z',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zm10 2-4.300-4.300',
  play: 'M7 4.500v15a1 1 0 0 0 1.500.9l12-7.500a1 1 0 0 0 0-1.700l-12-7.500A1 1 0 0 0 7 4.500z',
  pause: 'M7 4h3v16H7zM14 4h3v16h-3z',
  next: 'M5 4.500v15l11-7.500zM19 5v14',
  prev: 'M19 4.500v15L8 12zM5 5v14',
  shuffle: 'M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5',
  repeat: 'M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3',
  repeatOne: 'M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3M11 10l1.500-1v6',
  volume: 'M11 5 6 9H2v6h4l5 4V5zm8 0a10 10 0 0 1 0 14M15.500 8.500a5 5 0 0 1 0 7',
  mute: 'M11 5 6 9H2v6h4l5 4V5zm12 4-6 6m0-6 6 6',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2m0 18v2M4.200 4.200l1.400 1.400m12.800 12.800 1.400 1.400M1 12h2m18 0h2M4.200 19.800l1.400-1.400M18.400 5.600l1.400-1.400',
  moon: 'M21 12.800A9 9 0 1 1 11.200 3a7 7 0 0 0 9.800 9.800z',
  close: 'M18 6 6 18M6 6l12 12',
  upload: 'M12 16V4m0 0-4 4m4-4 4 4M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3',
  down: 'M12 5v14m0 0-6-6m6 6 6-6',
  heart: 'M12 20.500s-8-4.800-8-10.600A4.400 4.400 0 0 1 12 7.600a4.400 4.400 0 0 1 8 2.300c0 5.800-8 10.600-8 10.600z',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zm0-14v5l3 2',
  playlist: 'M3 6h13M3 11h13M3 16h7M18 11v8.500M18 19.500a2.500 2.500 0 1 1-2.500-2.500',
  plus: 'M12 5v14M5 12h14',
  trash: 'M4 7h16M10 11v6m4-6v6M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12M9 7V4h6v3',
  eq: 'M4 21v-7m0-4V3m8 18v-9m0-4V3m8 18v-5m0-4V3M1 14h6m2-6h6m2 8h6',
  speed: 'M12 14l4-4M3.300 17a9 9 0 1 1 17.400 0',
  timer: 'M10 2h4M12 14l3-3M12 22a8 8 0 1 0 0-16 8 8 0 0 0 0 16z',
  bars: 'M4 14v6M9 4v16M14 9v11M19 12v8',
  expand: 'M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7',
  chevronLeft: 'M15 18l-6-6 6-6',
  chevronRight: 'M9 18l6-6-6-6',
  chevronDown: 'M6 9l6 6 6-6',
  chevronUp: 'M6 15l6-6 6 6',
  image: 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM8.500 10a1.500 1.500 0 1 0 0-3 1.500 1.500 0 0 0 0 3zM21 16l-5-5-9 8',
  check: 'M5 12.500l4.500 4.500L19 7',
  sparkles: 'M12 3l1.800 5.200L19 10l-5.200 1.800L12 17l-1.800-5.200L5 10l5.200-1.800zM19 16l.8 2.200L22 19l-2.200.8L19 22l-.8-2.200L16 19l2.200-.8z',
  refresh: 'M20 11a8 8 0 1 0-2.300 5.700M20 4v7h-7',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13.500 6.500l4 4',
  disc: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zm0-6a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  nextUp: 'M4 6h12M4 12h8M4 18h8M17 11l4 3-4 3z',
  addQueue: 'M4 6h12M4 12h12M4 18h7M18 15v6m-3-3h6',
} as const;

export type IconName = keyof typeof PATHS;
const FILLED = new Set<IconName>(['play', 'next', 'prev', 'pause']);

export function Icon({ name, size = 20, style }: { name: IconName; size?: number; style?: CSSProperties }) {
  const filled = FILLED.has(name);
  const dots = name === 'more';
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={dots ? 3.4 : 2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" style={{ flex: 'none', ...style }}>
      <path d={PATHS[name]} />
    </svg>
  );
}
