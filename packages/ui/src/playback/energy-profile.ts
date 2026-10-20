/**
 * A coarse "where is the music loud" profile of one song (loudness per slice of its length), used by the hover preview
 * on the seek bar. It is computed in the renderer from the audio the player is already playing: the one fetch of the
 * track's address made by the playback store (handed in by the store, never built here), decoded by Web Audio, then reduced to a few
 * hundred numbers. Nothing is stored on disk; the numbers are cached in memory per track.
 */

export const PROFILE_BUCKETS = 160;
/** Files larger than this are not decoded for a preview (a huge lossless file would take seconds and lots of memory). */
export const MAX_PROFILE_BYTES = 96 * 1024 * 1024;

/** Reduces decoded channels to `buckets` loudness values in 0..1 (RMS per slice, mixed across channels, scaled by a high percentile so one spike does not flatten the rest). */
export function bucketEnergy(channels: readonly Float32Array[], buckets: number = PROFILE_BUCKETS): number[] {
  const length = channels[0]?.length ?? 0;
  if (length === 0 || channels.length === 0) return [];
  const rms: number[] = [];
  for (let b = 0; b < buckets; b += 1) {
    const from = Math.floor((b * length) / buckets);
    const to = Math.max(from + 1, Math.floor(((b + 1) * length) / buckets));
    const stride = Math.max(1, Math.floor((to - from) / 400)); // sampling is plenty for a preview and keeps long songs fast
    let sum = 0;
    let n = 0;
    for (const channel of channels) {
      for (let i = from; i < to; i += stride) {
        const v = channel[i] ?? 0;
        sum += v * v;
        n += 1;
      }
    }
    rms.push(n === 0 ? 0 : Math.sqrt(sum / n));
  }
  const mean = rms.reduce((a, b) => a + b, 0) / rms.length;
  const high = Math.min(Math.max(...rms), mean * 2.4); // scaled so one loud spike does not flatten everything else
  if (high <= 0) return rms.map(() => 0);
  return rms.map((value) => Math.min(1, Math.sqrt(value / high))); // sqrt: quiet parts stay visible, like a waveform
}

export interface ProfileDeps {
  readonly fetchBytes: (url: string) => Promise<ArrayBuffer | undefined>;
  readonly decode: (bytes: ArrayBuffer) => Promise<readonly Float32Array[]>;
}

/** Real deps: the page's fetch and an offline Web Audio decoder. */
export function browserProfileDeps(): ProfileDeps {
  return {
    async fetchBytes(url) {
      const response = await fetch(url);
      if (!response.ok) return undefined;
      const declared = Number(response.headers.get('content-length') ?? 0);
      if (declared > MAX_PROFILE_BYTES) return undefined;
      const bytes = await response.arrayBuffer();
      return bytes.byteLength > MAX_PROFILE_BYTES ? undefined : bytes;
    },
    async decode(bytes) {
      const context = new OfflineAudioContext(1, 1, 44_100);
      const buffer = await context.decodeAudioData(bytes);
      return Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
    },
  };
}

/** Loads (once per track, remembered) the energy profile of the track behind `url`. Never throws: failure is `undefined`. */
export function createProfileLoader(deps: ProfileDeps = browserProfileDeps(), capacity = 24) {
  const cache = new Map<string, Promise<number[] | undefined>>();
  return (trackId: string, url: string): Promise<number[] | undefined> => {
    const hit = cache.get(trackId);
    if (hit !== undefined) {
      cache.delete(trackId); // refresh recency
      cache.set(trackId, hit);
      return hit;
    }
    const work = (async () => {
      try {
        const bytes = await deps.fetchBytes(url);
        if (bytes === undefined) return undefined;
        const profile = bucketEnergy(await deps.decode(bytes));
        return profile.length === 0 ? undefined : profile;
      } catch {
        return undefined;
      }
    })();
    cache.set(trackId, work);
    void work.then((value) => {
      if (value === undefined) cache.delete(trackId); // a failure may be retried later
    });
    while (cache.size > capacity) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    return work;
  };
}
