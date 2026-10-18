import type Database from 'better-sqlite3';
import type { NovaDatabase } from '../database/index.js';

export interface PlaylistLimits {
  readonly maxPlaylists: number;
  readonly maxEntries: number;
}

export interface PlaylistRow {
  readonly id: string;
  readonly name: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly trackCount: number;
  /** Sum of the known durations; `undefined` when no track has one. */
  readonly durationSeconds: number | undefined;
  /** Up to four track ids for a mosaic cover - see `pickCoverTrackIds`. */
  readonly coverTrackIds: readonly string[];
}

export interface PlaylistEntryRow {
  readonly entryId: string;
  readonly trackId: string;
}

export type CreatePlaylistOutcome = { readonly status: 'created'; readonly added: number } | { readonly status: 'limit-reached' };
export type AddEntriesOutcome =
  | { readonly status: 'added'; readonly added: number }
  | { readonly status: 'not-found' }
  | { readonly status: 'limit-reached' };

/** A candidate for a mosaic cover: a playlist entry's track with what decides whether it makes a good tile. */
export interface CoverCandidate {
  readonly trackId: string;
  readonly album: string | undefined;
  readonly albumArtist: string | undefined;
  readonly hasArtwork: boolean;
}

/** Positions are moved out of the way by this much while a block of rows is re-numbered (more than any playlist can hold). */
const PARK_OFFSET = 1_000_000;
/** How many entries (from the start) are looked at to pick a cover: bounded so listing 200 playlists stays cheap. */
const COVER_SCAN_ROWS = 80;
const COVER_TILES = 4;

/**
 * Up to four track ids to build a playlist's mosaic cover from.
 *  1. Distinct ALBUMS first (a playlist of one album should not show four identical tiles), preferring tracks
 *     that carry embedded artwork, then the rest, each group in playlist order. A track with no album counts as
 *     its own album (singles).
 *  2. If fewer than four albums exist, the remaining tiles are filled with other distinct tracks in playlist order.
 * Pure, so it is unit-tested without a database.
 */
export function pickCoverTrackIds(candidates: readonly CoverCandidate[]): string[] {
  const ordered = [...candidates.filter((c) => c.hasArtwork), ...candidates.filter((c) => !c.hasArtwork)];
  const chosen: string[] = [];
  const albums = new Set<string>();
  for (const candidate of ordered) {
    if (chosen.length >= COVER_TILES) break;
    if (chosen.includes(candidate.trackId)) continue;
    const album = candidate.album?.normalize('NFC').trim().toLowerCase();
    const key = album === undefined || album === '' ? `track:${candidate.trackId}` : `album:${candidate.albumArtist?.trim().toLowerCase() ?? ''}|${album}`;
    if (albums.has(key)) continue;
    albums.add(key);
    chosen.push(candidate.trackId);
  }
  for (const candidate of ordered) {
    if (chosen.length >= COVER_TILES) break;
    if (!chosen.includes(candidate.trackId)) chosen.push(candidate.trackId);
  }
  return chosen;
}

/**
 * Playlists and their entries (migration 6). Takes an already-open database and never opens or closes a
 * connection. Every multi-row change runs in ONE transaction, so a failure part-way leaves the playlist exactly
 * as it was.
 *
 * Positions are 0-based and gap-free. `UNIQUE (playlist_id, position)` is checked row by row, so shifting a block
 * by one with a single UPDATE can collide with a not-yet-moved neighbour. The block is therefore first PARKED
 * far away (`+ PARK_OFFSET`, a single statement that cannot collide) and then given its final positions.
 */
export class SqlitePlaylistRepository {
  private readonly limits: PlaylistLimits;
  private readonly now: () => number;
  private readonly newId: () => string;

  private readonly countPlaylists: Database.Statement<[]>;
  private readonly insertPlaylist: Database.Statement;
  private readonly selectSummaries: Database.Statement<[]>;
  private readonly selectSummary: Database.Statement<[string]>;
  private readonly selectCoverRows: Database.Statement<[string, number]>;
  private readonly updateName: Database.Statement;
  private readonly touch: Database.Statement;
  private readonly deletePlaylist: Database.Statement<[string]>;
  private readonly selectEntries: Database.Statement<[string]>;
  private readonly countEntries: Database.Statement<[string]>;
  private readonly trackExists: Database.Statement<[string]>;
  private readonly insertEntry: Database.Statement;
  private readonly selectEntryPositions: Database.Statement<[string]>;
  private readonly deleteEntry: Database.Statement<[string, string]>;
  private readonly parkFrom: Database.Statement<[number, string, number, number]>;
  private readonly setPosition: Database.Statement<[number, string]>;
  private readonly selectEntryIdsInRange: Database.Statement<[string, number, number]>;

  private readonly createTx: Database.Transaction<(name: string, trackIds: readonly string[]) => { id: string; outcome: CreatePlaylistOutcome }>;
  private readonly addTx: Database.Transaction<(playlistId: string, trackIds: readonly string[]) => AddEntriesOutcome>;
  private readonly removeTx: Database.Transaction<(playlistId: string, entryIds: readonly string[]) => boolean>;
  private readonly moveTx: Database.Transaction<(playlistId: string, entryId: string, toIndex: number) => boolean>;

  constructor(
    database: NovaDatabase,
    options: { readonly now?: () => number; readonly newId?: () => string; readonly limits: PlaylistLimits },
  ) {
    const db = database.connection;
    this.limits = options.limits;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? (() => crypto.randomUUID());

    this.countPlaylists = db.prepare('SELECT COUNT(*) AS n FROM playlists');
    this.insertPlaylist = db.prepare('INSERT INTO playlists (id, name, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?)');
    const summaryColumns = `
      p.id AS id, p.name AS name, p.created_at_ms AS created_at_ms, p.updated_at_ms AS updated_at_ms,
      (SELECT COUNT(*) FROM playlist_entries e WHERE e.playlist_id = p.id) AS track_count,
      (SELECT SUM(t.duration_seconds) FROM playlist_entries e JOIN tracks t ON t.id = e.track_id WHERE e.playlist_id = p.id) AS duration_seconds
    `;
    // Newest-created first would reorder the sidebar as the user works; alphabetical (then creation) is stable and findable.
    this.selectSummaries = db.prepare(`SELECT ${summaryColumns} FROM playlists p ORDER BY p.name COLLATE NOCASE, p.created_at_ms, p.id`);
    this.selectSummary = db.prepare(`SELECT ${summaryColumns} FROM playlists p WHERE p.id = ?`);
    this.selectCoverRows = db.prepare(`
      SELECT e.track_id AS track_id, t.album AS album, t.album_artist AS album_artist, t.artwork_kind AS artwork_kind
      FROM playlist_entries e JOIN tracks t ON t.id = e.track_id
      WHERE e.playlist_id = ? ORDER BY e.position LIMIT ?
    `);
    this.updateName = db.prepare('UPDATE playlists SET name = ?, updated_at_ms = ? WHERE id = ?');
    this.touch = db.prepare('UPDATE playlists SET updated_at_ms = ? WHERE id = ?');
    this.deletePlaylist = db.prepare('DELETE FROM playlists WHERE id = ?');
    this.selectEntries = db.prepare('SELECT entry_id, track_id FROM playlist_entries WHERE playlist_id = ? ORDER BY position');
    this.countEntries = db.prepare('SELECT COUNT(*) AS n FROM playlist_entries WHERE playlist_id = ?');
    this.trackExists = db.prepare('SELECT 1 FROM tracks WHERE id = ?');
    this.insertEntry = db.prepare('INSERT INTO playlist_entries (entry_id, playlist_id, track_id, position) VALUES (?, ?, ?, ?)');
    this.selectEntryPositions = db.prepare('SELECT entry_id, position FROM playlist_entries WHERE playlist_id = ? ORDER BY position');
    this.deleteEntry = db.prepare('DELETE FROM playlist_entries WHERE playlist_id = ? AND entry_id = ?');
    // Parks every row of the playlist whose position lies in [lo, hi] at position + PARK_OFFSET.
    this.parkFrom = db.prepare('UPDATE playlist_entries SET position = position + ? WHERE playlist_id = ? AND position >= ? AND position <= ?');
    this.setPosition = db.prepare('UPDATE playlist_entries SET position = ? WHERE entry_id = ?');
    this.selectEntryIdsInRange = db.prepare('SELECT entry_id FROM playlist_entries WHERE playlist_id = ? AND position >= ? AND position <= ? ORDER BY position');

    this.createTx = db.transaction((name, trackIds) => {
      if ((this.countPlaylists.get() as { n: number }).n >= this.limits.maxPlaylists) return { id: '', outcome: { status: 'limit-reached' } as const };
      const id = this.newId();
      const at = this.time();
      this.insertPlaylist.run(id, name, at, at);
      const outcome = this.appendEntries(id, trackIds);
      return { id, outcome: { status: 'created', added: outcome.added } as const };
    });
    this.addTx = db.transaction((playlistId, trackIds) => {
      if (!this.playlistExists(playlistId)) return { status: 'not-found' } as const;
      const result = this.appendEntries(playlistId, trackIds);
      if (result.limitHit && result.added === 0) return { status: 'limit-reached' } as const;
      if (result.added > 0) this.touch.run(this.time(), playlistId);
      return { status: 'added', added: result.added } as const;
    });
    this.removeTx = db.transaction((playlistId, entryIds) => {
      if (!this.playlistExists(playlistId)) return false;
      let firstGap = Number.POSITIVE_INFINITY;
      const positions = new Map((this.selectEntryPositions.all(playlistId) as { entry_id: string; position: number }[]).map((row) => [row.entry_id, row.position]));
      for (const entryId of new Set(entryIds)) {
        const position = positions.get(entryId);
        if (position === undefined) continue; // stale / foreign entry id: ignored
        this.deleteEntry.run(playlistId, entryId);
        firstGap = Math.min(firstGap, position);
      }
      if (firstGap !== Number.POSITIVE_INFINITY) {
        this.renumberFrom(playlistId, firstGap);
        this.touch.run(this.time(), playlistId);
      }
      return true;
    });
    this.moveTx = db.transaction((playlistId, entryId, toIndex) => {
      if (!this.playlistExists(playlistId)) return false;
      const rows = this.selectEntryPositions.all(playlistId) as { entry_id: string; position: number }[];
      const from = rows.findIndex((row) => row.entry_id === entryId);
      if (from === -1) return true; // a stale entry id: nothing to move (the caller still gets the current playlist)
      const to = Math.min(Math.max(0, toIndex), rows.length - 1);
      if (to === from) return true;
      const lo = Math.min(from, to);
      const hi = Math.max(from, to);
      // The block [lo, hi] is rotated: the moved entry goes to `to`, everything between shifts one step the other way.
      const block = rows.slice(lo, hi + 1).map((row) => row.entry_id);
      const [moved] = block.splice(from - lo, 1) as [string];
      block.splice(to - lo, 0, moved);
      this.parkFrom.run(PARK_OFFSET, playlistId, lo, hi);
      block.forEach((id, index) => this.setPosition.run(lo + index, id));
      this.touch.run(this.time(), playlistId);
      return true;
    });
  }

  private time(): number {
    return Math.max(0, Math.trunc(this.now()));
  }

  private playlistExists(playlistId: string): boolean {
    return this.selectSummary.get(playlistId) !== undefined;
  }

  /** Appends tracks (unknown ones skipped) up to the entry limit. `limitHit`: at least one known track did not fit. */
  private appendEntries(playlistId: string, trackIds: readonly string[]): { added: number; limitHit: boolean } {
    let count = (this.countEntries.get(playlistId) as { n: number }).n;
    let added = 0;
    let limitHit = false;
    for (const trackId of trackIds) {
      if (this.trackExists.get(trackId) === undefined) continue;
      if (count >= this.limits.maxEntries) {
        limitHit = true;
        break;
      }
      this.insertEntry.run(this.newId(), playlistId, trackId, count);
      count += 1;
      added += 1;
    }
    return { added, limitHit };
  }

  /** Makes positions gap-free again from `from` on (after rows before the end were deleted). */
  private renumberFrom(playlistId: string, from: number): void {
    const ids = (this.selectEntryIdsInRange.all(playlistId, from, PARK_OFFSET - 1) as { entry_id: string }[]).map((row) => row.entry_id);
    if (ids.length === 0) return;
    this.parkFrom.run(PARK_OFFSET, playlistId, from, PARK_OFFSET - 1);
    ids.forEach((id, index) => this.setPosition.run(from + index, id));
  }

  private toRow(row: { id: string; name: string; created_at_ms: number; updated_at_ms: number; track_count: number; duration_seconds: number | null }): PlaylistRow {
    const covers = this.selectCoverRows.all(row.id, COVER_SCAN_ROWS) as { track_id: string; album: string | null; album_artist: string | null; artwork_kind: string }[];
    return {
      id: row.id,
      name: row.name,
      createdAtMs: row.created_at_ms,
      updatedAtMs: row.updated_at_ms,
      trackCount: row.track_count,
      durationSeconds: row.duration_seconds ?? undefined,
      coverTrackIds: pickCoverTrackIds(
        covers.map((cover) => ({
          trackId: cover.track_id,
          album: cover.album ?? undefined,
          albumArtist: cover.album_artist ?? undefined,
          hasArtwork: cover.artwork_kind !== 'none',
        })),
      ),
    };
  }

  /** Every playlist, by name (case-insensitive). */
  list(): PlaylistRow[] {
    return (this.selectSummaries.all() as Parameters<SqlitePlaylistRepository['toRow']>[0][]).map((row) => this.toRow(row));
  }

  get(playlistId: string): PlaylistRow | undefined {
    const row = this.selectSummary.get(playlistId) as Parameters<SqlitePlaylistRepository['toRow']>[0] | undefined;
    return row === undefined ? undefined : this.toRow(row);
  }

  entries(playlistId: string): PlaylistEntryRow[] {
    return (this.selectEntries.all(playlistId) as { entry_id: string; track_id: string }[]).map((row) => ({ entryId: row.entry_id, trackId: row.track_id }));
  }

  /**
   * Creates a playlist (the name is already validated) holding `trackIds` (unknown ones skipped, at most
   * `maxEntries`). `limit-reached` when there are already `maxPlaylists`; nothing is written then.
   */
  create(name: string, trackIds: readonly string[] = []): { readonly id: string; readonly outcome: CreatePlaylistOutcome } {
    return this.createTx(name, trackIds);
  }

  /** `false` when there is no such playlist. */
  rename(playlistId: string, name: string): boolean {
    return this.updateName.run(name, this.time(), playlistId).changes > 0;
  }

  /** `true` when a playlist was deleted (its entries go with it). */
  delete(playlistId: string): boolean {
    return this.deletePlaylist.run(playlistId).changes > 0;
  }

  /** Appends tracks at the end; unknown ids are skipped, duplicates are kept. */
  addTracks(playlistId: string, trackIds: readonly string[]): AddEntriesOutcome {
    return this.addTx(playlistId, trackIds);
  }

  /** Removes entries by id (unknown ids ignored) and closes the gaps. `false` when there is no such playlist. */
  removeEntries(playlistId: string, entryIds: readonly string[]): boolean {
    return this.removeTx(playlistId, entryIds);
  }

  /**
   * Moves one entry so it ends up at `toIndex` (clamped to the playlist). `false` when there is no such
   * playlist; an unknown entry id changes nothing.
   */
  moveEntry(playlistId: string, entryId: string, toIndex: number): boolean {
    return this.moveTx(playlistId, entryId, toIndex);
  }
}
