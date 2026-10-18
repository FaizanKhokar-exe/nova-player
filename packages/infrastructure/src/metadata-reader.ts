import { parseFile } from 'music-metadata';

/**
 * Phase 0: proves `music-metadata` is wired up and correctly reads real
 * tagged fixture files (including formats the reference app's hand-rolled
 * parser could not read at all - FLAC/OGG). The full metadata-trust policy
 * (prefer clean filename over a suspicious tag, self-heal on load, etc.,
 * per the accepted architecture review) is Phase 1 domain logic layered on
 * top of this adapter, not implemented here.
 */
export interface BasicTags {
  readonly title: string | undefined;
  readonly artist: string | undefined;
  readonly album: string | undefined;
  readonly durationSec: number | undefined;
}

export async function readBasicTags(filePath: string): Promise<BasicTags> {
  const metadata = await parseFile(filePath);
  return {
    title: metadata.common.title,
    artist: metadata.common.artist,
    album: metadata.common.album,
    durationSec: metadata.format.duration,
  };
}
