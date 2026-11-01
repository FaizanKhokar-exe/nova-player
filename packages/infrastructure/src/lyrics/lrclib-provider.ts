import { parseLyrics } from '@nova/domain';
import type { LyricsCandidateDto } from '@nova/shared';

/**
 * Online lyrics TEXT lookup (v0.12.0), against the open LRCLIB catalogue (https://lrclib.net).
 *
 * This is the only network access in the whole application, it is made by the main process only, only
 * when the listener presses "Search", and it sends nothing but the title, artist and (optionally) album
 * and length of ONE song. The host is pinned: no other host is ever contacted. The response is treated as
 * untrusted: size-capped, shape-checked field by field, and never executed or rendered as markup.
 *
 * The network itself is a port (`fetchJson`) so the provider is testable without it.
 */

export const LRCLIB_HOST = 'lrclib.net';
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const MAX_CANDIDATES = 12;
const MAX_TEXT_CHARS = 200_000;

export type FetchText = (url: string, init: { readonly headers: Record<string, string>; readonly timeoutMs: number; readonly maxBytes: number }) => Promise<{ readonly status: number; readonly text: string }>;

export interface LyricsQuery {
  readonly title: string;
  readonly artist: string;
  readonly album?: string;
  readonly durationSec?: number;
}

export type ProviderResult =
  | { readonly status: 'ok'; readonly candidates: readonly LyricsCandidateDto[] }
  | { readonly status: 'offline' | 'error'; readonly candidates: readonly [] };

export interface LyricsProvider {
  search(query: LyricsQuery): Promise<ProviderResult>;
}

/** Lowercase, strip accents/brackets/feat. noise and punctuation: for comparing titles only. */
export function normaliseForMatch(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/\b(feat|ft|featuring)\b.*$/g, ' ')
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim();
}

function tokenSet(value: string): Set<string> {
  return new Set(normaliseForMatch(value).split(' ').filter((t) => t.length > 0));
}

/** Dice coefficient of word sets, 0..1. Two empty strings count as "no information" (0.5). */
export function wordSimilarity(a: string, b: string): number {
  const left = tokenSet(a);
  const right = tokenSet(b);
  if (left.size === 0 && right.size === 0) return 0.5;
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return (2 * shared) / (left.size + right.size);
}

/** How well a candidate agrees with what was asked for: title 0.5, artist 0.3, length 0.2. */
export function scoreCandidate(query: LyricsQuery, candidate: { title: string; artist: string; durationSec?: number }): number {
  const title = wordSimilarity(query.title, candidate.title);
  const artist = query.artist === '' ? 0.5 : wordSimilarity(query.artist, candidate.artist);
  let length = 0.5;
  if (query.durationSec !== undefined && candidate.durationSec !== undefined) {
    const gap = Math.abs(query.durationSec - candidate.durationSec);
    length = gap <= 2 ? 1 : gap <= 6 ? 0.6 : gap <= 15 ? 0.25 : 0;
  }
  return Math.round((0.5 * title + 0.3 * artist + 0.2 * length) * 1000) / 1000;
}

function str(value: unknown, max = 300): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/** One raw JSON entry to a candidate, or `undefined` when it is unusable. Never throws. */
export function toCandidate(raw: unknown, query: LyricsQuery): LyricsCandidateDto | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === 'number' && Number.isSafeInteger(record.id) ? record.id : undefined;
  if (id === undefined) return undefined;
  const title = str(record.trackName ?? record.name);
  const artist = str(record.artistName);
  if (title === '') return undefined;
  const plain = typeof record.plainLyrics === 'string' ? record.plainLyrics.slice(0, MAX_TEXT_CHARS) : '';
  const syncedText = typeof record.syncedLyrics === 'string' ? record.syncedLyrics.slice(0, MAX_TEXT_CHARS) : '';
  const syncedLines = syncedText.trim() === '' ? [] : parseLyrics(syncedText).lines.map((line) => ({ timeMs: line.timeMs, text: line.text }));
  const instrumental = record.instrumental === true;
  if (!instrumental && plain.trim() === '' && syncedLines.length === 0) return undefined;
  const durationSec = typeof record.duration === 'number' && Number.isFinite(record.duration) && record.duration > 0 && record.duration < 36_000 ? Math.round(record.duration) : undefined;
  const match = scoreCandidate(query, { title, artist, ...(durationSec !== undefined && { durationSec }) });
  return { id, title, artist, album: str(record.albumName), ...(durationSec !== undefined && { durationSec }), instrumental, plain, ...(syncedLines.length > 0 && { syncedLines }), match };
}

export function createLrclibProvider(fetchText: FetchText, userAgent: string): LyricsProvider {
  return {
    async search(query) {
      const params = new URLSearchParams();
      params.set('track_name', query.title);
      if (query.artist !== '') params.set('artist_name', query.artist);
      const url = `https://${LRCLIB_HOST}/api/search?${params.toString()}`;
      let response: { status: number; text: string };
      try {
        response = await fetchText(url, { headers: { 'User-Agent': userAgent, Accept: 'application/json' }, timeoutMs: 8000, maxBytes: MAX_RESPONSE_BYTES });
      } catch {
        return { status: 'offline', candidates: [] };
      }
      if (response.status === 404) return { status: 'ok', candidates: [] };
      if (response.status < 200 || response.status >= 300) return { status: 'error', candidates: [] };
      let parsed: unknown;
      try {
        parsed = JSON.parse(response.text);
      } catch {
        return { status: 'error', candidates: [] };
      }
      if (!Array.isArray(parsed)) return { status: 'error', candidates: [] };
      const candidates: LyricsCandidateDto[] = [];
      for (const item of parsed.slice(0, 60)) {
        const candidate = toCandidate(item, query);
        if (candidate !== undefined) candidates.push(candidate);
      }
      // Best agreement first; a ready-made timed text breaks ties; then the provider's own order (stable).
      const ranked = candidates
        .map((candidate, index) => ({ candidate, index }))
        .sort((a, b) => b.candidate.match - a.candidate.match || Number(b.candidate.syncedLines !== undefined) - Number(a.candidate.syncedLines !== undefined) || a.index - b.index)
        .slice(0, MAX_CANDIDATES)
        .map((entry) => entry.candidate);
      return { status: 'ok', candidates: ranked };
    },
  };
}

/** A provider that answers from a fixed JSON text (used by the end-to-end tests only, never in a normal run). */
export function createFixtureProvider(json: string): LyricsProvider {
  return createLrclibProvider(async () => ({ status: 200, text: json }), 'fixture');
}
