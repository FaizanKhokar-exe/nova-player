import { describe, expect, it } from 'vitest';
import { computeDeduplicationKey } from './deduplication.js';

describe('computeDeduplicationKey', () => {
  it('produces the same key for identical normalized metadata', () => {
    const a = computeDeduplicationKey({ title: 'One More Time', artist: 'Daft Punk', sizeBytes: 5_242_880 });
    const b = computeDeduplicationKey({ title: 'One More Time', artist: 'Daft Punk', sizeBytes: 5_242_880 });

    expect(a).toBe(b);
  });

  it('is insensitive to case differences in title/artist', () => {
    const a = computeDeduplicationKey({ title: 'One More Time', artist: 'Daft Punk', sizeBytes: 5_242_880 });
    const b = computeDeduplicationKey({ title: 'ONE MORE TIME', artist: 'daft punk', sizeBytes: 5_242_880 });

    expect(a).toBe(b);
  });

  it('is insensitive to whitespace differences in title/artist', () => {
    const a = computeDeduplicationKey({ title: 'One More Time', artist: 'Daft Punk', sizeBytes: 5_242_880 });
    const b = computeDeduplicationKey({
      title: '  One   More Time  ',
      artist: '  Daft Punk',
      sizeBytes: 5_242_880,
    });

    expect(a).toBe(b);
  });

  it('produces a different key for a different title', () => {
    const a = computeDeduplicationKey({ title: 'One More Time', artist: 'Daft Punk', sizeBytes: 5_242_880 });
    const b = computeDeduplicationKey({
      title: 'Harder Better Faster Stronger',
      artist: 'Daft Punk',
      sizeBytes: 5_242_880,
    });

    expect(a).not.toBe(b);
  });

  it('produces a different key for a different artist', () => {
    const a = computeDeduplicationKey({ title: 'One More Time', artist: 'Daft Punk', sizeBytes: 5_242_880 });
    const b = computeDeduplicationKey({ title: 'One More Time', artist: 'Some Cover Band', sizeBytes: 5_242_880 });

    expect(a).not.toBe(b);
  });

  it('produces a different key for a different file size (e.g. a different bitrate encode)', () => {
    const a = computeDeduplicationKey({ title: 'One More Time', artist: 'Daft Punk', sizeBytes: 5_242_880 });
    const b = computeDeduplicationKey({ title: 'One More Time', artist: 'Daft Punk', sizeBytes: 9_000_000 });

    expect(a).not.toBe(b);
  });

  it('is a pure function of title/artist/size alone - independent of any TrackId', () => {
    // This is really documentation-as-a-test: computeDeduplicationKey does
    // not take a TrackId at all, so two Tracks with different IDs but
    // identical title/artist/size necessarily produce the same key - which
    // is the entire point of this being a separate concept from TrackId.
    const key1 = computeDeduplicationKey({ title: 'One More Time', artist: 'Daft Punk', sizeBytes: 5_242_880 });
    const key2 = computeDeduplicationKey({ title: 'One More Time', artist: 'Daft Punk', sizeBytes: 5_242_880 });

    expect(key1).toBe(key2);
  });
});
