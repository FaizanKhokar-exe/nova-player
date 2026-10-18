import { createTrack, createTrackId, type Track, type TrackRecord } from '@nova/domain';

let counter = 0;

/** A fully resolved domain Track built through the real `createTrack`
 *  policy; `overrides` replace individual fields afterwards. */
export function makeTrack(overrides: Partial<Track> = {}): Track {
  counter += 1;
  const base = createTrack({
    id: createTrackId(),
    sourcePath: `C:\\Music\\Artist ${counter} - Song ${counter}.mp3`,
    raw: { title: `Song ${counter}`, artist: `Artist ${counter}` },
  });
  return { ...base, ...overrides };
}

export function makeRecord(overrides: Partial<Track> = {}, sizeBytes = 4_000_000): TrackRecord {
  return { track: makeTrack(overrides), sizeBytes };
}

/** A track with every optional field populated. */
export function makeFullTrack(overrides: Partial<Track> = {}): Track {
  return makeTrack({
    album: 'The Album',
    albumArtist: 'Various Artists',
    genre: 'Rock',
    trackNumber: 7,
    discNumber: 2,
    year: 1999,
    durationSeconds: 215.123456789,
    artwork: { kind: 'external', path: 'C:\\Music\\cover.jpg' },
    ...overrides,
  });
}

/** The repository tests use Windows-style fixture paths on any host and are
 *  about mapping/persistence, not path policy, so they key paths by their
 *  exact text. Path-key behaviour is tested separately. */
export const EXACT_PATH_KEYS = { pathKey: (sourcePath: string): string => sourcePath };
