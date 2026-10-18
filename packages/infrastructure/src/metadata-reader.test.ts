import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readBasicTags } from './metadata-reader.js';

const fixturesDir = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../tests/fixtures');

describe('readBasicTags', () => {
  it('reads tags from an MP3 fixture', async () => {
    const tags = await readBasicTags(path.join(fixturesDir, 'sample-track.mp3'));
    expect(tags.title).toBe('Fixture Title');
    expect(tags.artist).toBe('Fixture Artist');
  });

  it('reads tags from a FLAC fixture (unsupported by the old hand-rolled parser)', async () => {
    const tags = await readBasicTags(path.join(fixturesDir, 'sample-track.flac'));
    expect(tags.title).toBe('Fixture Flac Title');
    expect(tags.artist).toBe('Fixture Flac Artist');
  });
});
