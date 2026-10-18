/**
 * The audio file types Nova Player scans. Chosen from what the existing
 * `nova-media://` protocol can already serve (its content-type table) AND
 * what `music-metadata` parsed correctly in this repo's fixtures
 * (tests/fixtures/metadata). `.wma` is in the protocol table but is
 * deliberately NOT scanned yet: there is no verified fixture for it, and a
 * format we cannot test would only produce unreadable-file noise.
 */
export const SUPPORTED_AUDIO_EXTENSIONS: ReadonlySet<string> = new Set([
  '.mp3',
  '.flac',
  '.ogg',
  '.oga',
  '.opus',
  '.m4a',
  '.aac',
  '.wav',
]);

/** The lower-cased extension including the dot, or '' when there is none.
 *  A leading dot alone (".mp3", a hidden file) is not an extension. */
export function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(dot).toLowerCase() : '';
}

export function isSupportedAudioFile(fileName: string): boolean {
  return SUPPORTED_AUDIO_EXTENSIONS.has(extensionOf(fileName));
}
