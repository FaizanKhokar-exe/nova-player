# Nova Player — Rebuild Status

**Nova Player — production-grade desktop music player rebuild.**

This project is a from-scratch rebuild of a previous Nova Player implementation (a working but architecturally informal Electron/vanilla-JS app) into a maintainable, strictly-typed, thoroughly-tested, production-oriented Electron/React/TypeScript application. The rebuild follows an accepted architecture review and a phased implementation roadmap, executed phase by phase with full validation between phases.

**This file is the primary continuation document.** A future Claude session should read this file first, then the repository itself, before doing anything else. The repository and this file are the source of truth — not any prior chat transcript.

---

## CURRENT MILESTONE

```
CURRENT MILESTONE: PHASE 10 — COMPLETE — GREEN WITH CAVEATS (see the Phase 10 section)   (UI redesign: theming, lyrics, attach .lrc; v0.10.0)
   A Windows NSIS installer WAS BUILT (cross-built on Linux with Wine; unsigned) but has NOT been installed or run on real Windows.
NEXT STEP: run the installer on a real Windows 10/11 x64 machine using the checklist in RELEASING.md and record the result here.
           (No Phase 10 is defined; do not start unrelated work.)
```

```
Phase 0  — GREEN
Phase 1A — GREEN
Phase 1B — GREEN
Phase 1C — GREEN
Phase 1D — GREEN
Phase 1E — GREEN
Phase 2A — GREEN   SQLite foundation (lifecycle, migrations, initial schema)
Phase 2B — GREEN   TrackRepository port (domain) + SQLite implementation
Phase 2C — GREEN   Filesystem abstraction + safe path handling
Phase 2D — GREEN   music-metadata adapter + domain normalization bridge
Phase 2E — GREEN   Library scanning: incremental, progress, cancellation
Phase 2F — GREEN   Folder watching + reconciliation
Phase 2G — GREEN   Composition root, Electron main wiring, integration + validation
Phase 3  — COMPLETE — GREEN   Half 1: typed IPC + main-process application wiring · Half 2: minimal shell UI + Zustand renderer state
Phase 4  — COMPLETE — GREEN   Full playback: secure library media access, byte-range serving, queue-driven playback, player UI, persistence
Phase 5  — COMPLETE — GREEN   Library: All Tracks / Albums / Artists / Genres, deterministic sorting, real queue view + editing, library-aware playback, launch scan/watch policy, single virtualized list
Phase 6  — COMPLETE — GREEN   Lyrics + visual identity: sidecar .lrc lyrics (synchronized, click-to-seek), embedded artwork, Now Playing view, restyled shell
Phase 7  — COMPLETE — GREEN   Desktop shell: single window + single instance, system tray, media keys, track notifications, remembered window state, app icon; close = quit (hide-to-tray is opt-in only)
Phase 8  — COMPLETE — GREEN   Hardening: corrupt-row recovery, race-checked media opens, watcher/removeRoot races, controlled shutdown + fatal-error policy, window/IPC policy, playback position flush
Phase 9  — COMPLETE — GREEN WITH CAVEATS   Release / documentation: README + RELEASING, packaging fixes, unsigned NSIS installer built (Wine), packaged-app smoke test; NOT verified on real Windows
Phase 10 — COMPLETE — GREEN WITH CAVEATS   User-requested port of the earlier "Nova Player Desktop" look: glass dark/light UI, dynamic album-art theming, Apple-style lyrics, vinyl Now Playing, Settings, attach-your-own .lrc (migration 5, 2 new IPC channels); v0.10.0; NOT verified on real Windows
```

**Git state — read this.** The Phase 0–1E history below is the last history this file could see (HEAD `c75225f`). The Phase 2 work was done in working copies that had **no `.git` directory**, so **no Phase 2 commit exists or has been recorded here, and none was fabricated.** (A later checkpoint, `e0c780d`, "chore: checkpoint phase 1 complete", was reported by the project owner but never appeared in any file this project could inspect.) **The same is true of Phase 3 (both halves) and of Phase 4: no commit exists for them** (the working copies still had no `.git`; Phase 4 found none either and fabricated nothing). Whoever applies the Phase 2, 3 and 4 changes to the real repository should commit them there; a suggested split is `feat(infrastructure): Phase 2A SQLite foundation`, `... 2B ...`, `... 2C ...`, `feat(infrastructure): Phase 2D-2G metadata, scanning, watching, composition`, then `feat(ipc): Phase 3 half 1 typed IPC and application wiring`, then `feat(ui): Phase 3 half 2 minimal shell and renderer state`, then `feat(media): Phase 4 library media access and byte-range serving`, then `feat(playback): Phase 4 playback application, IPC and persistence`, then `feat(ui): Phase 4 playback store and player bar`, then `test(e2e): Phase 4 real playback coverage`.

Last known HEAD commit with a recorded message: `c75225f` — "feat(domain): Phase 1E - integration, cross-domain unit consistency fix, dedup fix"

Full history so far (oldest to newest):
```
bbb22d2  chore(phase-0): scaffold pnpm workspace, Electron+React+TS, IPC round trip, sqlite/metadata infra
a71112a  fix(nova-media): implement real HTTP byte-range handling; Phase 0 now fully green
3ddd80c  docs: update Phase 0 completion report - all 13 validation steps now green
c04fad4  feat(domain): Phase 1A - Track domain model + metadata normalization policy
daa1643  feat(domain): Phase 1B - queue model + playback rules
210bb59  feat(domain): Phase 1C - pure deterministic track search
1ca45ab  feat(domain): Phase 1D - pure LRC lyrics parsing and active-line lookup
c75225f  feat(domain): Phase 1E - integration, cross-domain unit consistency fix, dedup fix
```

No tags exist in the repository yet.

---

## PHASE 0 SUMMARY (scaffolding, verified working)

**Confirmed stack (exact versions currently in the repo's package.json files):**
- Electron `44.4.5`
- TypeScript `^6.0.3`, strict mode, via project references (`tsc -b`) — **deliberately pinned below the npm-latest 7.x line** because `typescript-eslint@8.70.1` does not yet support TS 7
- React `19.3.0`
- Vite `^7.3.6` — pinned to the 7.x line because `electron-vite@5.0.0`'s stable release does not yet support Vite 8
- `electron-vite` `5.0.0`
- `@vitejs/plugin-react` `^5.2.0` — pinned to 5.x because 6.x requires Vite 8
- Zustand `^5.0.15`
- `better-sqlite3` `13.0.3` (N-API build; ships prebuilt binaries for `win32-x64`/`win32-arm64`, confirmed working inside the real Electron main process, not just plain Node)
- `music-metadata` `11.16.1`
- `@tanstack/react-virtual` `^3.14.13`
- Vitest `^5.0.1` (config via `test.projects` in a root `vitest.config.ts` — the standalone `vitest.workspace.ts` file is NOT used; Vitest 5 does not auto-discover it)
- React Testing Library (`@testing-library/react` `^16.3.3`, `@testing-library/jest-dom` `^7.0.1`)
- Playwright (`@playwright/test`/`playwright` `^1.63.0`) driving the real Electron binary via `_electron.launch()` — confirmed working at Electron 44, no trace of the historical Electron-30+ regression
- `electron-builder` `26.15.3`
- pnpm workspace, plain (no Nx/Turborepo), pnpm `12.6.0`

**Architectural decisions established in Phase 0 and still in force:**
- Electron **main process is ESM** (`import`/`export`, built to ESM output by electron-vite)
- **Preload build output is CJS** (`.cjs` extension) even though its source is written in ESM syntax — a documented accommodation for Electron's sandboxed preload loader, not a reversal of the ESM decision
- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` on every `BrowserWindow`
- The **entire** renderer-facing API is one narrow `window.nova.invoke(channel, request)` function exposed via `contextBridge` — no raw `ipcRenderer`, no Node globals in the renderer (verified by an E2E test that checks `window.require`/`window.ipcRenderer`/`window.process` are all `undefined`)
- **Typed IPC contracts**: every channel's request/response shape is defined once in `@nova/shared`'s `IpcContract` and imported by both main and preload
- **`crypto.randomUUID()`** for all entity IDs — the `uuid` npm package is never installed
- **`better-sqlite3`** is the persistence engine (no schema implemented yet — that's Phase 2)
- **`electron-builder`** for packaging, **NSIS** target only (not Squirrel/`electron-winstaller` — that package's install script is explicitly denied in `pnpm-workspace.yaml`'s `allowBuilds`)
- Code **signing is entirely environment-variable-gated** in `apps/desktop/electron-builder.yml` (`CSC_LINK`/`CSC_KEY_PASSWORD`, or a commented-out `azureSignOptions` block for Azure Trusted Signing) — a build with none of these present produces a valid, working, unsigned installer by design, not by omission
- **No `publish` config exists at all** — per product decision, there is no fake or placeholder auto-update feed; `electron-updater` is not even installed yet. Wiring a real update channel is explicit future work.
- **Custom `nova-media://` protocol**, implemented and verified with REAL HTTP byte-range semantics (`packages/infrastructure/src/nova-media-protocol.ts`): validates the requested path against an allowlist, `fs.stat`s the real file, parses the `Range` header by hand (`parseByteRange`, RFC 7233: bounded/open-ended/suffix forms, EOF clamping, 416 for invalid ranges), and streams only the requested slice via `fs.createReadStream(path, { start, end })` bridged through `Readable.toWeb()` — **never buffers a whole file into memory**. This exists because Phase 0 proved that delegating to `net.fetch()` on a `file://` URL does NOT set `206`/`Content-Range`/`Accept-Ranges`, even though it does correctly slice the response body. The current Playwright E2E test (`tests/e2e/nova-media-seek.spec.ts`) drives a REAL `<audio>` element in the real Electron renderer and confirms actual `206` responses, correct `Content-Range` headers, a genuinely new ranged request triggered by seeking, and that `currentTime` measurably advances after seeking.
- Folder watching is planned as **native Windows `fs.watch(path, { recursive: true })` with debounce + periodic reconciliation**, not `chokidar` — not yet implemented (Phase 2 concern), but the decision and its rationale (Windows already supports recursive watching natively; chokidar's per-directory-watcher model is solving a macOS/Linux problem this Windows-only app doesn't have) is locked in.
- pnpm 12's install-script approval gate (`allowBuilds` in `pnpm-workspace.yaml`) has been reviewed deliberately, entry by entry, not blanket-approved. `better-sqlite3` is explicitly `false` (denied) — approving it makes pnpm attempt a real `node-gyp rebuild` that fails in this sandbox; the prebuilt N-API binary loads correctly regardless, since it's a plain package file, not gated by any install script.
- Electron `44.x`'s own binary download is **not** an automatic `postinstall` anymore (a real, current change from older Electron versions) — it's exposed as a `bin` entry (`install-electron`) that must be run explicitly once after `pnpm install`.

---

## PHASE 1 DOMAIN SUMMARY

All of Phase 1 lives entirely in `packages/domain/src/`. It has zero dependency on Electron, React, Zustand, DOM/browser APIs, Node filesystem APIs, `better-sqlite3`, `music-metadata`, IPC, or the network — verified both manually and by an automated `boundary.test.ts` that greps every domain source file for forbidden import specifiers and forbidden globals (`document.`, `window.`, `localStorage`, etc.), and confirms no `@nova/*` import beyond `@nova/shared`.

### Phase 1A — Domain Models + Metadata Policy
(`track-id.ts`, `text-normalization.ts`, `filename-fallback.ts`, `track.ts`, `deduplication.ts`, `global.d.ts`)

- **`TrackId`**: a branded UUID string. `createTrackId()` wraps `crypto.randomUUID()`; `isValidTrackId()`/`parseTrackId()` validate the v4-UUID shape. Deliberately NOT derived from filename or path — a file can be renamed/moved without losing its TrackId.
- **`Track`** entity: `id`, `sourcePath`, `title`/`titleSource`, `artist`/`artistSource` (`titleSource`/`artistSource` are `'tag' | 'filename' | 'unknown'`, anticipating the accepted architecture review's `tag_source` column and self-healing-metadata policy), `album`/`albumArtist`/`genre` (all optional, never synthesized when absent), `trackNumber`/`discNumber`/`year`/`durationSeconds` (sanitized — negative/non-finite/implausible values become `undefined`, never stored as-is), `artwork` (`{ kind: 'embedded' | 'external' | 'none' }`).
- **`RawTrackMetadata`**: a domain-owned input shape, deliberately independent of `music-metadata`'s actual output — a future infrastructure adapter translates into this.
- **`createTrack(input)`**: the metadata-resolution policy. Title/artist fallback chain: tag (if non-empty after whitespace normalization) → filename-derived → fixed documented constant (`"Untitled Track"` / `"Unknown Artist"`). Album/albumArtist/genre are left `undefined` when absent (grouping/display of untagged albums is explicitly deferred to a later library phase).
- **Filename fallback** (`filename-fallback.ts`): extension stripping without any `node:path` dependency (handles both `/` and `\` manually); a small, exact-match junk-token list (`stripJunkBracketGroups`) that only strips a bracket/paren group when its ENTIRE trimmed, comparison-normalized content matches a known junk phrase exactly (`"(Remix)"`, `"(feat. Drake)"`, `"(Live at Wembley)"` are all left alone); `parseArtistTitleFromFileName` only splits on `" - "` (space-hyphen-space), so hyphenated titles like `"Anti-Hero"`/`"T-Shirt"` are never destroyed.
- **Comparison normalization** (`text-normalization.ts`): `normalizeWhitespace` (trim + collapse, display-safe) and `normalizeForComparison` (also lowercased, comparison-only, never for display) — this is the ONE canonical normalization primitive, reused by filename-fallback, search, and lyrics-adjacent code.
- **Deduplication** (`deduplication.ts`): `computeDeduplicationKey({ title, artist, sizeBytes })` — normalized title + normalized artist + exact byte size. Explicitly NOT a replacement for TrackId; documented false-positive/false-negative limitations (different bitrate re-encodes won't be caught; no content hashing is attempted, by design).

### Phase 1B — Queue + Playback Rules
(`queue.ts`, `shuffle.ts`, `playback-decisions.ts`)

- **`QueueState`**: `{ tracks: readonly TrackId[], currentIndex, repeatMode, unshuffledTracks }`. Holds `TrackId` references, not full `Track` objects — resolving an ID to display metadata is a repository concern for a later phase. `tracks` is always the single active playback order (shuffle physically reorders it — there is no separate "shuffled order" array).
- **Operations** (all pure, all immutable, all tested for non-mutation of caller-owned arrays): `replaceQueue`, `appendToQueue`, `playNext`, `removeFromQueue`, `reorderQueue`, `jumpToIndex`, `setRepeatMode`, `getCurrentTrackId`. Every documented edge-case policy (invalid index → no-op or fallback to 0, removing the current track advances to what would have played next, reorder preserves current-track identity across the boundary) is exactly as coded and tested — see `queue.ts`'s doc comments for the precise policy per function.
- **Shuffle** (`shuffle.ts`): Fisher-Yates with an **injected `RandomSource`** (never calls `Math.random()` internally, so it's fully deterministic under test). Enabling shuffle keeps the current track current and shuffles the rest; the true original order is preserved across repeated re-shuffles via an `unshuffledTracks` snapshot; `append`/`playNext`/`removeFromQueue` keep that snapshot in sync while shuffled. One documented limitation: a manual `reorderQueue` performed while shuffled is NOT preserved once shuffle is disabled again.
- **Repeat modes**: `'off' | 'all' | 'one'`.
- **Playback decisions** (`playback-decisions.ts`): pure functions returning a `PlaybackDecision` union (`playIndex | restartCurrent | noNextTrack | noPreviousTrack | queueEmpty`) — domain decides WHAT should happen, never HOW. `decideOnTrackFinished` (repeat-ONE restarts), `decideOnNextPressed` (an explicit skip always advances, even under repeat-ONE — repeat-one only governs natural track-end, not an explicit skip), `decideOnPreviousPressed`.
- **Playback position unit is MILLISECONDS**, domain-wide, as of the Phase 1E integration fix (see below). `PREVIOUS_RESTART_THRESHOLD_MS = 3000` (the reference product's ~3-second previous-track-restart rule, carried forward exactly, just re-expressed in the canonical unit).

### Phase 1C — Search Domain Logic
(`search.ts`)

- **API**: `searchTracks(tracks, query) -> SearchResult[]`, where each result is `{ track (the original object, never a copy), match }`.
- **Searchable fields**: `title`, `artist`, `albumArtist`, `album`, `genre` — `albumArtist` was added beyond the brief's literal four fields specifically so compilation/featured-artist releases remain findable by the name a user actually knows the release by.
- **Normalization**: reuses Phase 1A's `normalizeForComparison` for both the query and every field — case-insensitive, whitespace-collapsing. Punctuation is matched literally (no accent folding, no typo tolerance, no fuzzy matching, no external search library).
- **Empty/whitespace-only query returns `[]`** — never an arbitrary slice of the library. Deciding what to show for an empty search box is the caller's job.
- **Field priority** (a documented product policy, not a claim of "best"): `title > artist > albumArtist > album > genre`. A match in an earlier field always outranks a later one regardless of match quality (exact > prefix > substring), which only orders matches within the same field.
- **Multi-word queries**: the whole normalized phrase is tried per field first; only if no single field contains it does every word need to appear somewhere across the track's fields (any order) — these "words" matches rank below every single-field match.
- **Deterministic ordering**: rank, then title (normalized, plain code-unit comparison — never locale-dependent), then artist, then TrackId; the underlying sort is stable so any remaining ties keep input order.
- **Performance**: a straightforward linear scan, no index — explicitly the correct scope for this phase; a throwaway (uncommitted) benchmark against 50,000 synthetic tracks completed in roughly 40–125ms in the sandbox.

### Phase 1D — Lyrics Domain Logic
(`lrc.ts`, `active-lyric.ts`)

- **`parseLyrics(text) -> { lines, metadata, offsetMs }`**. `LyricLine = { timeMs, text }` — always an integer number of milliseconds, never floating point.
- **Timestamp formats**: `[mm:ss]`, `.x`/`.xx`/`.xxx` fractions, and the `[mm:ss:xx]` colon-separated fraction form real-world files contain. Stacked leading timestamps (`[00:10.00][00:20.00]text`) produce one entry per tag; timestamps in the middle of a line are never treated as timing tags.
- **Metadata tags**: `ar`, `ti`, `al`, `by` are captured into `LyricsMetadata`; any other header tag is recognized and discarded, never shown as a lyric line.
- **Offset**: `[offset:N]` in milliseconds, **ADDED** to every timestamp (positive = later) — this matches the legacy Nova Player's actual behavior and is the OPPOSITE sign from the original LRC spec's description, so it's documented explicitly and pinned by tests. Applies file-wide regardless of where the tag appears; the last valid offset tag wins; a malformed value is ignored; a timestamp that would go negative clamps to 0.
- **Malformed-input tolerance**: plain text, `[broken]`, `[99:xx]`, `[]`, section labels like `[Chorus]`, and unknown headers are all skipped; parsing never throws; a non-string input returns an empty result.
- **Empty timed lines are PRESERVED** (`text: ''`) — a deliberate divergence from the legacy implementation (which dropped them), so a UI can clear the highlighted line during an instrumental gap instead of leaving the previous lyric lingering.
- **Inline word-timing markers** (`<mm:ss.xx>` and variants) are stripped from the text; no word-level timing is retained; a line that contains only markers becomes an empty timed line.
- **Ordering**: by final `timeMs`, then original (pre-offset) time, then source order. Nothing is de-duplicated — two lines sharing a timestamp are both kept, in source order.
- **`getActiveLyric(lines, currentTimeMs)`** / **`getActiveLyricIndex`**: binary search (lines must be pre-sorted, as `parseLyrics` guarantees) for the last line at or before the current time. Before the first line → `undefined`; exactly on a timestamp → that line; between lines → the earlier one stays active; after the final line → the final line stays active; several lines sharing the winning timestamp → the LAST of them (source order) is active.
- **`getLyricSeekTime(line)`** → `line.timeMs`, trivially — actually performing a seek is audio-layer work for a later phase.

### Phase 1E — Integration + Final Validation

Inspected all four domain areas together per the brief's required checks and found two genuine cross-cutting issues, both fixed (not speculative changes):

1. **Millisecond consistency.** `decideOnPreviousPressed`'s parameter and `PREVIOUS_RESTART_THRESHOLD_SECONDS` (`= 3`) were the only playback-position API in the whole domain using seconds; Phase 1D's lyrics use milliseconds throughout via `timeMs`. Renamed to `currentPositionMs` and **`PREVIOUS_RESTART_THRESHOLD_MS = 3000`** — behavior is unchanged (still 3 seconds), only the unit/name changed, so a single millisecond playback position can now be passed to both the queue and lyrics domains with zero conversion. All references repo-wide were confirmed updated (verified via grep — no leftover references to the old names).
2. **Canonical normalization.** `filename-fallback.ts`'s junk-phrase comparison used its own ad hoc `.trim().toLowerCase()` instead of Phase 1A's canonical `normalizeForComparison`, so — unlike every other comparison in the domain — it didn't collapse internal whitespace (a sloppily-tagged `"[ Official   Video ]"` wouldn't have matched). Fixed to reuse the canonical function; a regression test was added.
3. Added `integration.test.ts` (12 tests) exercising five required cross-domain scenarios (Track+Search ranking, Track+Queue identity through next/previous/reorder/repeat, Queue+Shuffle identity preservation, Lyrics+PlaybackTime unit consistency, Metadata+Search normalization) against real objects built through the actual Phase 1A–1D APIs, not new fixtures.
4. A grep-based performance sanity check confirmed no loop anywhere in the four domain areas is nested inside another loop over the tracks/lines collection — only small, bounded inner loops (5 search fields, a handful of removed queue indices).

**Validation result at the end of Phase 1E:** 356/356 tests passing, 0 lint errors (1 pre-existing, unrelated warning — see Known Limitations), 0 typecheck errors, desktop build succeeds, 4/4 Playwright E2E tests pass. Only `packages/domain` was changed during Phase 1E.

---

## PHASE 2 SUMMARY (persistence + filesystem infrastructure — verified)

All of Phase 2 lives in `packages/infrastructure` (plus two small additions to `packages/domain` and the Electron main wiring in `apps/desktop`). Each sub-phase was validated on its own before the next began. Dependency direction: **desktop main → infrastructure → domain**; the domain knows nothing about any of it.

### Phase 2A — SQLite foundation (`infrastructure/src/database/`)
- `openDatabase({ filePath })` → `NovaDatabase { connection, filePath, isOpen, getSchemaVersion(), close() }`. Explicit handle, no singleton. Creates parent folders, enables and verifies `foreign_keys`, WAL + `synchronous=NORMAL` for file databases; closes the connection if open/migration fails; `close()` is idempotent and (WAL) leaves a single self-contained file.
- Migrations: append-only list of `{ version, name, up(db) }` in `migrations.ts`, tracked in `schema_migrations`. Each runs in its own `BEGIN IMMEDIATE` transaction with its tracking row; failure rolls back and throws `MigrationError`. Refuses a database whose history the code does not recognise (newer app version / renamed migration) instead of guessing.
- Migration 1 (`initial-schema`): the `tracks` table (STRICT) mirroring the Phase 1 `Track` plus `size_bytes` and `dedup_key` (non-unique advisory index); CHECK constraints repeat the domain's sanitisation rules; artwork stored as reference (kind + optional path), never bytes.
- better-sqlite3 validated under **Electron's own runtime** (ABI 149 vs Node's 127) by `electron-runtime.test.ts` via `ELECTRON_RUN_AS_NODE`, using the prebuilt binary; the pnpm `allowBuilds` deny for `better-sqlite3` was NOT changed.

### Phase 2B — Track persistence boundary
- **Domain port** `packages/domain/src/track-repository.ts`: `TrackRepository` (`getById`, `list`, `insert`, `update`, `delete`, `findByDeduplicationKey`, plus 2E additions `listFileStates`, `runInTransaction`), `TrackRecord { track, sizeBytes, modifiedAtMs? }`, `TrackFileState`, `TrackRepositoryError` with codes `duplicate-track-id | duplicate-source-path | track-not-found | constraint-violation | corrupt-record`. Synchronous by design (better-sqlite3 transactions are sync).
- **Implementation** `SqliteTrackRepository(database, { pathKey? })` in `infrastructure/src/repositories/`: prepared statements built once, explicit column lists (no `SELECT *`), explicit row↔`Track` mapping (`track-row-mapping.ts`), SQLite errors translated to the domain error codes, raw faults rethrown untouched. Durations are seconds; NULL ↔ `undefined`.
- Identities stay separate: **TrackId** identifies a track; **source path** says where its file is (may change on `update`); **dedup key** is advisory only.

### Phase 2C — Filesystem + path policy (`infrastructure/src/filesystem/`)
- `FileSystem` (`createNodeFileSystem()`): async `exists`, `stat`, `statFile`, `readDirectory`, `realPath`. Requires absolute paths (never resolved against the cwd). `stat` returns `{ path, kind, sizeBytes, modifiedAtMs }` — mtime from **bigint** stats (exact whole milliseconds, rounded down). `readDirectory` is non-recursive, sorted by UTF-16 code-unit order, reports symlinks as `symlink` (never followed). One error type, `FileSystemError`, codes `not-found | access-denied | invalid-path | not-a-directory | not-a-file | outside-root | io-error`.
- Path policy (`path-policy.ts`), explicit `win32`/`posix` flavor so the Windows rules are tested on any host: `canonicalizePath` → `CanonicalPath` (the form stored as `sourcePath`), `pathComparisonKey` → `PathKey` (case-folded on Windows; for equality only), `isPathWithin` / `resolveWithin` (segment-based containment via `path.relative`, never string-prefix). Rejects relative, drive-relative, device paths, illegal characters, reserved names, trailing dot/space.

### Phase 2D — Metadata (`infrastructure/src/metadata/`)
- `createMusicMetadataReader()` → `MetadataReader.read(path)` → `{ status: 'ok', metadata: RawTrackMetadata } | { status: 'unreadable', reason }`; filesystem problems **throw** `FileSystemError`. This file and the Phase 0 probe `metadata-reader.ts` are the only importers of `music-metadata` (enforced by a test); no library type leaves the adapter.
- The adapter only maps tags (genre arrays joined with ", "; duration in seconds; embedded-artwork flag). **No fallbacks live there** — missing tags flow into the domain's `createTrack`, which owns filename fallback/normalization.
- `parseFile` "succeeds" on garbage/empty/tags-only files; the adapter treats "no audio format detected" as `unreadable` so a corrupt file never becomes an empty Track.
- Supported extensions (`supported-formats.ts`): `.mp3 .flac .ogg .oga .opus .m4a .aac .wav` (case-insensitive). `.wma` is deliberately not scanned (no verified fixture). Fixtures: `tests/fixtures/metadata/` (generated once with ffmpeg, committed, README documents the commands).

### Phase 2E — Library scanning (`infrastructure/src/scanning/`)
- `createLibraryScanner({ fileSystem, metadataReader, trackRepository, createTrackId?, concurrency=4, batchSize=100 })` → `scan({ root, scope?, signal?, onProgress? })` → `ScanResult` (`status: completed | cancelled`, counts `discovered/skipped/added/updated/removed/failed/possibleDuplicates`, `failures[]`, `removalWithheld`).
- **Migration 2 (`scan-state-and-path-key`)**: `tracks` rebuilt with `modified_at_ms` (incremental detection, 0 = unknown) and `source_path_key` (**UNIQUE** path comparison key; `source_path` keeps display case and is no longer UNIQUE). This resolves the Phase 2B "byte-exact `source_path` uniqueness" concern; the repository computes the key via an injectable `pathKey` (default: `pathComparisonKey`).
- **Reconciliation policy** (also documented on `LibraryScanner`): new file → read, fresh TrackId, insert · known file with identical size + mtime + stored spelling → skipped without reading · changed → re-read, **same TrackId** · stored track whose file is gone → removed, **except** inside any folder that could not be listed this time, after a cancel, or when the whole root has zero audio files (`removalWithheld: 'root-appears-empty'` — an unmounted drive must not wipe the library) · a missing/unreadable **root is a fatal `ScanError` that changes nothing** · a **moved/renamed file is a removal + an addition with a NEW TrackId** (no identity guessing; see limitations) · possible duplicates (same advisory dedup key) are saved as separate tracks and counted · symlinks/junctions are not followed.
- Bad files never abort a scan: unreadable media / filesystem / persistence failures become `ScanResult.failures`. Unexpected (non-domain) errors are fatal and roll back their batch.
- Work is bounded and batched: tag reads run with bounded concurrency; each batch commits in **one** transaction, each file a nested savepoint so one rejected track cannot undo its neighbours. Scans on one scanner never overlap (per-instance queue).
- Cancellation (`AbortSignal`): no new file starts, in-flight reads finish and are saved, nothing is removed, status `cancelled`; every committed batch is whole, so the database is always valid and a later scan resumes.
- Progress model: `ScanProgress` snapshots (`phase: discovering | reading | removing | completed | cancelled`, counts, `processed`, `total` (unknown until discovery ends), `currentPath`) — plain data, ready for IPC later. A throwing progress callback aborts the scan (not swallowed).

### Phase 2F — Folder watching (`infrastructure/src/watching/`)
- `createFolderWatcher({ scanner, watch?, debounceMs=1000, reconcileIntervalMs=10min, maxTargetedScopes=25, onReconciled?, onError? })` → `{ start(roots), stop(), reconcileNow(), isRunning }`. Native `fs.watch(root, { recursive: true, persistent: false })` (injectable `WatchFunction`); **no chokidar**.
- The watcher never parses tags or touches the database: raw events only mark paths dirty; after a quiet period the scanner reconciles just those paths (dirty paths inside a dirty folder are merged; too many → one whole-root scan; unknown path → whole root). Event paths pass through `resolveWithin`, so they cannot point outside the root.
- Periodic full incremental scan is the safety net for lost events and also re-establishes dead watches; a dead watch is reported (`onError`), closed, and followed by a full reconcile. Roots that cannot be watched at start are reported and retried.
- `stop()` is idempotent, clears timers, closes every watch, aborts the in-flight scan and waits for it.

### Phase 2G — Composition + Electron integration
- `createLibraryServices({ databasePath })` (`infrastructure/src/composition/`) wires database → repository → filesystem → metadata → scanner, and `createFolderWatcher()`. It does **not** expose the raw connection. `close()` stops watchers, aborts and awaits running scans, then closes the database; idempotent.
- `apps/desktop/src/main/index.ts` creates it on `app.whenReady()` at `app.getPath('userData')/library/nova.db` (a failure shows an error box and exits — never half-runs) and closes it in an orderly way in `before-quit`. (At the Phase 2 checkpoint no IPC channel exposed it; Phase 3 half 1 below adds the typed channels.) The renderer has no filesystem or database access.
- `nova-media://` containment now uses `isPathWithin` (fixes the Phase 0 case-sensitive string-prefix check; fails closed on paths the policy cannot interpret). Its handler/protocol design is otherwise unchanged.
- Integration tests (`composition/library-services.test.ts`) drive real disk + real SQLite + real `fs.watch`; Playwright `library-lifecycle.spec.ts` verifies the database is created under `userData`, the shutdown path runs (observed in main's output), and the file is left valid, WAL-free and reopenable.

---

## PHASE 3 — HALF 1: TYPED IPC + MAIN-PROCESS APPLICATION WIRING (verified)

**Phase 3 Half 1 — Typed IPC + Main-process application wiring is complete.** (Half 2 — the shell UI and renderer state that consume this boundary — is documented in the next section and is also complete.)

Path of a call: `renderer → window.nova.invoke/subscribe → preload bridge → typed contract (@nova/shared) → main IPC handlers → LibraryApplication → LibraryServices → Phase 2 infrastructure/domain ports`.

### Contract (`packages/shared`)
- Phase 0 channels (`app:ping`, `diagnostics:*`) are unchanged. `IpcContract` now extends `LibraryIpcContract`; `NovaBridge` gains `subscribe`. Runtime allowlists `IPC_INVOKE_CHANNELS` / `IPC_EVENT_CHANNELS` exist, each with a compile-time proof that it is complete.
- **Request/response channels (11)**, every one answering `IpcResult<T> = { ok: true, value } | { ok: false, error }`: `library:listRoots`, `library:addRoot`, `library:removeRoot`, `library:startScan`, `library:cancelScan`, `library:getScanState`, `library:listTracks` (optional `offset`/`limit`), `library:search` (`query`, optional `limit`), `library:startWatching`, `library:stopWatching`, `library:getWatcherStatus`.
- **Events (4)**, main → renderer, one-way: `library:scanProgress` (throttled), `library:scanFinished` (once per scan), `library:changed` (`reason`: scan | watcher | root-added | root-removed), `library:watcherStatus`. Long-running scan progress is pushed, not polled; `library:getScanState` exists for a renderer that (re)loads mid-scan.
- **Errors**: `IpcError { code, message, operation }` with stable codes (`invalid-request`, `forbidden`, `invalid-path`, `root-unavailable`, `root-not-directory`, `root-exists`, `root-overlaps`, `root-not-found`, `no-roots`, `scan-running`, `filesystem-error`, `internal`). Errors never travel as thrown `Error`s; anything unexpected becomes a generic `internal` error (details logged in main only — no stack, SQLite or Node text reaches the renderer).
- **DTO rules** (`library-ipc.ts`, imports nothing): plain serializable data; optional fields are absent keys (never null/undefined); `TrackDto` carries id/title/artist/album/albumArtist/genre/trackNumber/discNumber/year/durationSeconds(seconds)/artwork-kind — **no file path, no field provenance, no external-artwork path**. Root paths appear only for folders the user picked (`RootDto.path`, for display).
- **`library:addRoot` takes no path.** Main shows the OS folder picker and registers the pick, so the renderer cannot make main scan an arbitrary location.

### Preload (`apps/desktop/src/preload/`)
- `nova-bridge.ts` (Electron-free, unit-tested) builds `window.nova` = exactly `{ invoke, subscribe }`. `invoke` rejects any channel not in `IPC_INVOKE_CHANNELS`; `subscribe` rejects any channel not in `IPC_EVENT_CHANNELS`, passes the listener **only the payload** (never Electron's event object) and returns an unsubscribe function. `index.ts` just injects the real `ipcRenderer` into it. `contextIsolation`, `nodeIntegration:false` and the sandbox are unchanged.

### Main process (`apps/desktop/src/main/ipc/`, all Electron-free and unit-tested)
- `register-library-ipc.ts`: each handler checks the sender → validates the request → calls the one `LibraryApplication` → maps to a DTO. No business logic, no second service graph. `bridgeApplicationEvents` forwards application events to the four event channels.
- `validation.ts` (untrusted-input checks: shapes, ids, integer ranges, unknown keys rejected, no-argument channels accept only `undefined`), `ipc-errors.ts`, `dto-mappers.ts` (field-by-field; never spreads internal objects).
- `index.ts` wires it: creates `LibraryServices` (Phase 2) → `createLibraryApplication` → `registerLibraryIpc` + event bridge; `dialog.showOpenDialog` is the folder picker; senders are accepted only from one of our windows' main frame; shutdown (`before-quit`) is now **application.dispose() (aborts the scan, stops the watcher) → services.close() (database last)**. Nothing starts automatically: no scan or watcher runs until the renderer asks.

### Application layer (`infrastructure/src/application/`) and persistence
- `createLibraryApplication({ services })` over `LibraryServices` (it builds nothing of its own): roots (`listRoots` with availability/trackCount/watched, `addRoot`, `removeRoot`), scan jobs (`startScan` returns at once; `cancelScan`; `getScanState`; one scan at a time; roots scanned in sequence; per-root outcomes; progress throttled to ~100 ms within a phase, phase changes always pass), `listTracks` (stable title/artist/id order), `searchTracks` (the **Phase 1 domain `searchTracks`**, not reimplemented), watcher lifecycle/status, an event stream, and `dispose()`.
- Root rules: the folder must exist and be a directory; it is stored by its real on-disk path (`realPath`); the same folder (however spelled) is `root-exists`; a folder containing or inside an existing root is `root-overlaps`. Removing a root deletes the root **and the tracks inside it in one transaction** (refused while a scan runs); the user's files are never touched.
- **Migration 3 (`library-roots`)**: `library_roots(id, path, path_key UNIQUE, added_at_ms)`. New domain port `LibraryRootRepository` + `SqliteLibraryRootRepository` (same pattern as tracks); `LibraryServices` now also exposes `libraryRootRepository`.

### Tests and validation (Linux sandbox; see Validation Snapshot)
Application-layer tests (31, real SQLite/scanner/watcher), library-root repository tests, and in `apps/desktop` (new Vitest project `@nova/desktop`): validation, error mapping, DTO mappers (serializability / no-leak checks), handler dispatch + sender trust + error containment (fake registrar, plus real application for listing/search), the preload bridge (exact surface, allowlists, payload-only delivery), and compile-time contract tests. Real-Electron Playwright `library-ipc.spec.ts` (6 tests) drives everything through `window.nova` — renderer surface, roots (picker mocked in main), a full scan with progress/finished events, listing/search with no path leakage, incremental rescan, cancellation + resume, watcher lifecycle with a real file change, and persistence across restart.

### Known limitations of Half 1
- No library UI exists yet; the IPC surface is exercised only by tests. `window.nova.invoke` returns `IpcResult`s for the library channels but plain values for the Phase 0 diagnostic channels (kept unchanged on purpose).
- Each `library:search` / `library:listTracks` call loads the stored tracks from SQLite (no cache). Fine for thousands of tracks; revisit (cache invalidated by the `library:changed` event) if a very large library feels slow.
- `listTracks` returns title-sorted data; other sort orders, grouping (albums/artists) and paging beyond offset/limit are Half 2 / Phase 5 concerns.
- Track file paths are deliberately not exposed, so playback (Phase 4) needs its own safe way to obtain a media URL (e.g. a main-side id → `nova-media://` mapping, and `allowedRoots` extended to library roots). The media protocol's allowed roots are still only the fixtures folder.
- The folder picker itself (native dialog) cannot be driven by tests; E2E replaces `dialog.showOpenDialog` in the main process. The trusted-sender check (`senderFrame === sender.mainFrame` and a known window) is unit-tested with fakes and exercised implicitly by E2E, not attacked with a foreign frame.
- Overlapping/nested library roots are rejected rather than merged. Scan results keep at most 100 failures per root (`failureCount` is the true total). Scan history (`last`) is memory-only.
- All Linux-only caveats from Phase 2 still apply (real Windows, installer).

---

## PHASE 3 — HALF 2: MINIMAL SHELL UI + RENDERER STATE (verified)

**Phase 3 Half 2 — Minimal Shell UI + Renderer State is complete, which completes Phase 3.** The renderer now shows the real library through the Half 1 typed IPC. It is deliberately plain (inline styles, no design system): it exists to put the real backend on screen, not to be the final Nova Player UI. **No Half 1 backend, IPC contract, preload or main-process code was changed**, and no dependency, lockfile or pnpm-policy change was needed (Zustand, `@tanstack/react-virtual` and the testing libraries were already installed).

### Where it lives
- `packages/ui/src/library/` (the existing home of renderer UI + state): `library-store.ts` (Zustand store), `LibraryStoreProvider.tsx`, `LibraryShell.tsx` and the section components (`RootsSection`, `ScanSection`, `WatcherSection`, `SearchBox`, `TrackList`, `ErrorBanner`), `format.ts`, `styles.ts`. Exported from `@nova/ui`.
- `apps/desktop/src/renderer/src/main.tsx` is the renderer's composition point: `createLibraryStore(window.nova)` → `<App store>` → `<LibraryStoreProvider>` → `<LibraryShell>`. The page `<title>` is now "Nova Player" (the Phase 0 "scaffold" title was updated, with its assertion in `electron-launch.spec.ts`).
- The Phase 0 smoke components (`Phase0VirtualList`, `TrackTitle`, `phase0-counter-store`) and their tests remain in `@nova/ui`, unused by the app.

### Zustand renderer state (`createLibraryStore(bridge)`)
- A factory over a `NovaBridge` — no global instance; tests inject a fake bridge. One focused store (no playback/queue/lyrics state): roots (+ add/remove action state), tracks (+ load status/error), query + search slice, scan slice (`phase: idle | starting | running | cancelling`, latest `ScanProgressDto`, last `ScanResultDto`, error), watcher slice (status, busy, error), and a `connection` state for the first load.
- It is a thin mirror of main: it calls the typed `library:*` channels and listens to the four events; it estimates nothing and re-implements nothing (search runs in main via `library:search`). A rejected bridge call becomes a `{ code: 'unavailable' }` `UiError`; `IpcError`s from main are shown with their own plain-language message.
- `connect()` is **reference-counted**: it subscribes to exactly the four events once and shares one in-flight initial load, so React Strict Mode's mount/unmount/mount (and re-renders) neither duplicate subscriptions nor repeat requests; the provider's effect disconnects on unmount. Startup loads roots, tracks, scan state and watcher status in parallel; a section that fails shows its own error, and the whole shell reports "unreachable" (with retry) only if every request failed.
- Behaviour: one scan at a time (client-side guard on top of the backend's); an in-progress scan is recovered from `library:getScanState` after a window reload; events that overtake a reply are not overwritten by it; `library:changed` triggers a **coalesced** refresh of roots, tracks and any active search (the list stays on screen — no loading flash); search is debounced (200 ms) and **stale responses are discarded** (sequence-numbered); clearing the box cancels an in-flight search. No action ever sends a filesystem path (`addRoot` sends nothing — main shows the OS picker).

### UI
- **Library folders**: list with track count, `unavailable` and live `watching` badges; "Add folder…" (OS picker in main), per-folder Remove (disabled while a scan runs); add/remove errors shown and dismissible. The "watching" badge follows the live `library:watcherStatus` (found and fixed by the real E2E: the folder snapshot goes stale when the watcher starts).
- **Scan**: "Scan library" / "Cancel", status (Idle / Starting / Scanning / Cancelling), a native `<progress>` with the backend's real processed/total (indeterminate until the backend reports a total), the backend's counts, the current file **name**; the last result (completed / cancelled / failed) with totals, per-folder errors, up to five unreadable files **by name** with a "…and N more" count, and the "removals withheld" explanation.
- **Folder watching**: start/stop, Watching/Not watching, per-folder `watching`/`unavailable`, last reconcile summary and last problem.
- **Search**: a search box over `library:search`; searching / no results / error / "showing the first N of M" states; blank query shows the whole library without calling the backend.
- **Track list**: title, artist, album (+ album artist when it differs), genre, year, duration — from `TrackDto` only (**no file paths**; scan UI shows names, not full paths); virtualized with `@tanstack/react-virtual` (a 5,000-track list renders under 60 rows); loading / empty (two variants) / populated / error-with-retry states.

### Tests and validation (Linux sandbox; see Validation Snapshot)
- `@nova/ui`: store tests (initial state, loading/partial/total failure + reload, Strict-Mode-safe subscription lifecycle, roots add/cancel/error/remove, scan start/duplicate guard/progress/finished/failed/cancel/resync, watcher start/stop/event/errors, search success/none/loading/error/stale/debounce/clear, `library:changed` refresh incl. coalescing and failure, "never sends a path") and component tests that assert user-visible behaviour (empty/loading/error states, folders, scan running → progress → completed/cancelled/failed, watcher, tracks incl. no paths and virtualization, search, Strict-Mode subscription counts, no leak after unmount).
- Real-Electron Playwright `library-shell.spec.ts` (6 tests) drives the actual UI: shell + empty states, add folder (picker stubbed in main) → scan → tracks with real metadata → search (Unicode, no results, clear) → incremental rescan → remove folder; real scan progress + cancellation + resume (1,200 files); watcher start → file added/deleted on disk → UI follows → stop; persistence across restart; bridge surface unchanged. No fixed sleeps. Run 3× in a row: stable.

### Known limitations of Phase 3
- The shell is intentionally minimal: no sorting/grouping by album or artist, no column resizing or selection, no settings, no keyboard shortcuts beyond native controls, no dark mode, and only basic responsive layout (wrapping panels). Inline styles only — the real visual identity is later work.
- The track list loads the whole library into the renderer (fine for tens of thousands of tracks; revisit with paging if a library is huge); each search still reloads tracks in main (no cache).
- Nothing starts automatically after launch (no initial scan, no watcher): the user presses Scan / Start watching. Whether to auto-start is a product decision for a later phase.
- Search results show the backend's first 500 (the total is shown); there is no "load more".
- ~~Playback does not exist~~ — **solved in Phase 4** (see below): rows are playable, the renderer gets opaque media URLs, and `nova-media://` serves registered library roots.
- The native folder picker is only exercised in E2E via a stub in the main process; a real OS dialog was never driven. All Linux-only caveats from Phase 2 still apply (real Windows, installer, signing).

---

## PHASE 4 — FULL PLAYBACK (verified)

Phase 4 was done as one phase on top of the finished Phase 3, extending it without rewriting anything. Dependencies: **none added** (every `package.json` and `pnpm-lock.yaml` is byte-identical to Phase 3; the preload source is byte-identical too — the bridge is still exactly `invoke` + `subscribe`).

### The media-access boundary (the key problem, and how it was solved)
`nova-media://` was extended — **no second media mechanism and no HTTP server** — from a fixtures-only spike into the library's media boundary. It now has two URL shapes:
- **`nova-media://track/<TrackId>`** (library playback). The id is opaque; the renderer never learns a path. Main resolves it per request, with **nothing cached**, through `createMediaAccess` (`infrastructure/src/media/media-access.ts`), the single authority on "may this be heard?":
  1. the id must be a well-formed TrackId and the track must exist;
  2. its stored path must lie inside a library root registered **right now** (a removed root stops granting access immediately; sibling-prefix folders like `music2` and `..` escapes are refused by the shared `isPathWithin` policy);
  3. that root must still resolve (via `realPath`) to the folder that was registered — gone → `root-unavailable` (503, recovers when it returns); swapped for a link elsewhere → `root-changed` (403);
  4. the file's **real path** (links followed) must be inside the root's real path — a symlink/junction that leaves the library is `outside-root` (403), matching the Phase 2 scanner, which never follows links;
  5. it must be a regular file with an audio extension (`415` otherwise).
  The path finally opened is the verified real path. Every refusal carries an `X-Nova-Media-Denial` reason and **no path**.
- **`nova-media://local/<path>`** — the Phase 0 spike shape, kept only for the `diagnostics:getSeekSpikeMediaUrl` channel/E2E. Served only from an explicit `allowedRoots` list (the fixtures folder in an **unpackaged** run; **empty in a packaged app**). It can never reach a library file.
`parseNovaMediaUrl` is total (never throws) and accepts only those shapes: no credentials/port/fragment/extra segments; a track URL's only permitted query is exactly `?v=<1–9 digits>` (see "Retry" below). The id is validated after URL parsing.

### Byte ranges / seeking (`media/byte-range.ts`, `media/serve-media-file.ts`) — re-inspected, not assumed
GET and HEAD only (405 + `Allow` otherwise). 200 whole file; 206 + `Content-Range` for `start-end`, `start-` and `-suffix`; end beyond EOF is clamped; unit is case-insensitive; **416 + `Content-Range: bytes */size`** for unsatisfiable/malformed ranges (start ≥ size, `5-2`, `-0`, `abc`, empty file, absurd numbers); multi-range and non-`bytes` units are answered 200 with the whole file; a `Range` with `If-Range` is ignored (no validator is ever issued). The file is opened **first**, so 404/403 are real statuses (not a broken 200 body), then streamed from the open handle (never read into memory) and closed on end/cancel/never-read. Correct `Content-Length`, per-extension `Content-Type`, `Accept-Ranges`, `X-Content-Type-Options: nosniff`.
- Success: `Cache-Control: no-cache`. **Every refusal/failure: `Cache-Control: no-store`** — see the bug below.
- ~~Known TOCTOU gap~~ — narrowed in Phase 8 (see the Phase 8 section for exactly what is and is not closed).

### Who owns what
- **Main owns the queue.** The renderer must not reimplement queue logic (enforced by a test). `createPlaybackApplication` (`infrastructure/src/application/playback-application.ts`) wraps the **unchanged Phase 1 domain functions** (`replaceQueue`, `decideOnNextPressed`, `decideOnPreviousPressed`, `decideOnTrackFinished`, `enableShuffle`/`disableShuffle`, `setRepeatMode`, `jumpToIndex`, `removeFromQueue`). Randomness is injectable, so shuffle is deterministic in tests.
- **The renderer's `<audio>` element owns playback itself.** The renderer asks main what to play and plays what it is told.
- Application rules added on top of the domain (the only ones): `playTrack` queues the list the user is looking at (whole library, or the current search results) and re-applies the listener's repeat/shuffle modes (the domain's `replaceQueue` resets them by definition); Previous on the first track under the threshold **restarts** the track (the domain says `noPreviousTrack`; the app keeps the button useful); a track finishing with the queue exhausted is `stop` (stay on the last track, at 0, paused); a `trackFinished` report about a track that is no longer current is ignored.

### IPC (typed, extends Phase 3; `packages/shared/src/playback-ipc.ts`)
Nine invoke channels — `playback:getState/playTrack/next/previous/trackFinished/setRepeatMode/setShuffle/reportPosition/diagnoseSource` — and one event, `playback:stateChanged` (`library-changed` | `track-removed`). Same pattern as the library handlers: trusted-sender check → strict validation (`playback-validation.ts`: valid TrackIds only, whole-ms positions 0…2 147 483 647, no unknown keys) → application → DTO mapper (`playback-dto-mappers.ts`, field-by-field, path-free) → `IpcResult`. New error code `track-not-found`. `PlaybackStateDto` carries `current: { track: TrackDto, mediaUrl }`; **`TrackDto` is unchanged and has no path**. Every command answers with an outcome — `started` | `restart` | `stop` | `none` — telling the renderer what to do.

### Playback position and persistence (milliseconds throughout)
- Whole **milliseconds** everywhere in the domain, IPC and database. Seconds exist only at the renderer's media boundary (`toMs()` / `audio.currentTime = ms / 1000`).
- **Migration 4** (`playback_session`, appended; migrations 1–3 untouched): one singleton row — the queue as JSON ids in active order, the pre-shuffle snapshot (so shuffle survives a restart), current index, repeat mode, `position_ms`. New domain port `PlaybackSessionRepository` + `SqlitePlaybackSessionRepository`. Position is written on its own (`savePosition`, the frequent case) without rewriting the queue.
- On startup the saved session is **reconciled against the library** (tracks that left are dropped; if the current one left, the next becomes current at 0). A session that cannot be read is reported, cleared, and the app starts empty. A restored session is always **paused** — nothing autoplays.
- The renderer saves the position at most every 5 s while playing, and immediately on pause/seek/track change/disconnect.
- Not persisted (deliberate): volume and mute (they belong with the later Settings work).

### Renderer (`packages/ui/src/playback/`)
- `createPlaybackStore(bridge, audio)` — a factory (no global), separate from the library store; `connect()` is reference-counted (React Strict Mode safe: one set of 12 listeners). It listens to the **minimal event set** `loadedmetadata, durationchange, canplay, play, playing, waiting, pause, timeupdate, seeked, ended, error, volumechange` (test-enforced) and copies what the UI needs; nothing is simulated or polled.
- **High-frequency position lives in its own tiny store** (`positionStore`) that only the progress display subscribes to. A test proves a burst of `timeupdate` events causes **zero DOM mutations** in the track list or the bar. No IPC is made per tick; the library list is not reloaded.
- **Newest command wins** (a command sequence), so a slow answer for an earlier click can never overwrite a newer track; after any answer the element is reconciled to main's current track (self-healing when two quick Next presses are answered "started" then "none").
- Track switching, restore, restart (repeat one), stop, track-removed (pause + notice, or unload when nothing is left), library-changed (metadata refresh without touching audio), stale snapshots dropped by `revision`.
- UI: `PlayerBar` (title/artist, previous/play-pause/next, seek with elapsed/total, volume, mute, repeat Off/All/One, shuffle), playable rows (play button, double-click, Enter; the current row is highlighted, `aria-current`, and shows pause; clicking the current track toggles it), `data-state` = `empty|loading|playing|buffering|paused|error`. The seek bar quantises to whole seconds and, while being dragged, seeks **once on release**. Rows are memoised; the Phase 3 shell renders without a playback provider exactly as before.
- `main.tsx` creates the single hidden `<audio id="nova-audio">` (the one place an audio element is created; observable in E2E).

### Errors
Messages are user-facing and never contain a path, errno or internal denial. When the element's `error` fires, the renderer asks main to **diagnose** (`playback:diagnoseSource`): missing file, unplugged folder ("isn't available… Is the drive connected?"), inaccessible (also what escapes/swapped folders read as — no detail leaked), not in library, unsupported type; if main can open the file but the decoder fails, the message follows the element's `MediaError` code (unsupported / damaged / unreadable). `MEDIA_ERR_ABORTED` (our own source change) is ignored; a diagnosis for a track that is no longer loaded is discarded. "Try again" retries; playing another track clears the error — the library stays usable.
- **Retry needs a fresh address.** *(Found by the real E2E.)* Chromium's media layer remembers a **failed load per URL** and answers a retry of the identical URL without ever asking main — so after an unplugged drive was reconnected, "Try again" kept failing. Fix: after diagnosing a failure main hands out the same track as `nova-media://track/<id>?v=N` (N is a meaningless cache key, ignored when serving); "Try again" refetches the state from main, then reloads. All refusals are also `Cache-Control: no-store`. The renderer never builds a media URL (test-enforced).

### Library/watcher interaction
Responsibilities stay separate: the watcher only updates the library. Main subscribes to `library-changed` and calls `PlaybackApplication.reconcileLibrary()`, which prunes the queue and pushes `playback:stateChanged` only when something visible changed (revision-gated, idempotent). Search, scanning and the watcher keep working during playback (E2E-verified).

### Tests
- **Infrastructure** (`media/`, `application/`, `repositories/`): `media-access` (47, 1 skipped: valid/nested/Unicode, removal at runtime, orphan, prefix-sibling, `..`, absolute, NUL, unavailable root + recovery, root swapped for a link, **real symlink/dir-symlink escapes**, dangling link, directory-as-file, non-audio, access denied [root-skipped], non-FS errors rethrown); `media-url` (every malformed shape, dot-segment normalisation, the `?v=` rule); `handle-media-request` (exact bytes, every range form, 416 forms, empty file, If-Range, HEAD, 405, refusals incl. denied-root/unavailable/symlink-escape bytes never returned, no-store, spike shape); `playback-application` (initial state, play/next/previous/finished across repeat modes, shuffle determinism and restore, positions, persistence/restore/reconcile incl. real SQLite, library reconciliation, diagnose, URL versioning); `sqlite-playback-session-repository` (round trips, singleton, corrupt rows, migration upgrade from v3 on a real file).
- **Desktop main**: playback validation (untrusted input), DTO mappers (no path ever, absent-not-null), IPC handlers against the real `PlaybackApplication`, contract test (no path-like fields; every position is `…Ms`).
- **Renderer**: 88 store tests (against a scripted `FakeAudio` that mimics the media element: src-load reset, async `seeked`, `play` rejections) + 30 component tests (controls, loading/buffering/error states, progress/seek/drag, volume/mute, repeat/shuffle, current-row marking, the Profiler-style "no DOM change on `timeupdate`" test).
- **Boundary tests (new, permanent)**: `apps/desktop/src/main/renderer-boundary.test.ts` (renderer + `@nova/ui`: no Node/Electron/SQLite/tag-reader/domain/infrastructure imports; `@nova/shared` type-only; no `ipcRenderer/require/process/Buffer/localStorage/fetch/eval/innerHTML`; `window.nova` only at the entry; no `nova-media` literal, no `.src =` outside the store, no `sourcePath`, one audio element, no queue/shuffle logic) and `infrastructure/src/media/boundary.test.ts` (media layer is Electron-free; authorization precedes serving; no grant cache).
- **Real-Electron E2E** (`tests/e2e/playback.spec.ts`, 21 tests, tiny WAVs generated on the fly by `media-fixtures.ts` — no new binary fixtures): real playback on the real element; pause/resume; seek (real range requests); volume/mute; next/previous incl. the 3 s rule; ended → next; ended on last → stop; repeat all/one; shuffle (each track once, restore order); search/rescan/scroll during playback; search results become the queue; track deleted while playing; folder removed while playing; deleted file / unplugged drive **+ recovery** / undecodable file errors; protocol attacks via the real handler (ranges, 416, HEAD, 405, unknown/malformed/traversal ids, absolute and `local` paths, symlink escape, swapped root); bridge surface and no paths; **restart persistence** (modes, queue, position; paused, then resumes). Waits are on media/UI conditions, no fixed sleeps. Ran 3× in a row after the final fix: stable.
- **Mutation checks (22)**, each caught by a test then reverted: symlink containment dropped; removed root still granting; swapped root undetected; range end off-by-one; 416 disabled; track URL served without authorization; refusals cacheable; Previous = index−1; ended ignoring repeat; stale "ended" applied; position not persisted; library removal not reconciled; stale command responses applied; seconds sent as ms; ended not reported; listeners leak on reconnect; retry pauses instead of retrying; position leaking into the main store; removed track still shown playing; seek unclamped; IPC sender unchecked; path leaking into a DTO.

### Bugs found by the new tests (and fixed)
1. After a media error the element can still report `paused === false`, so the "Play" button (correctly labelled) would have called `pause()` instead of retrying — caught by a store test.
2. Chromium's failed-load memory made "retry after reconnecting a drive" fail silently — caught only by the real-Electron E2E (see Errors).

### Existing Phase 0–3 code touched (24 files; all else byte-identical)
Additive extensions: `shared` (`index.ts`, `library-ipc.ts`: new channels/event/error code), `domain/index.ts` (port export), `infrastructure` (`index.ts`, `application/index.ts`, `repositories/index.ts`, `composition/library-services.ts` + `database/migrations.ts`: migration 4, `nova-media-protocol.ts`: split into `media/*`, same exports + new), `main/index.ts` (composition), `main/ipc/validation.ts` (three helpers exported) and `ipc-errors.ts` (one line), `renderer/App.tsx`/`main.tsx`, `ui` (`index.ts`, `LibraryShell`, `TrackList`, `styles`, `format`). **Five pre-existing assertions updated for the new facts**, nothing weakened: the exact event-channel list (`ipc-contract.test.ts`), the schema version and source-file list (`electron-runtime.test.ts`, and `library-lifecycle.spec.ts`: version 3 → 4), the exact `LibraryServices` key set (`library-services.test.ts`), and one NUL-path protocol test that used a made-up host `media` (now correctly 400) and now uses `local` (`nova-media-protocol.test.ts`). Also not shipped any more: four generated `packages/ui/vitest.setup.{js,d.ts}(.map)` compiler outputs that earlier handoffs carried.

### Known limitations of Phase 4
- **Audible output was never verified** (no sound device in the validation sandbox). "Plays" means Chromium decoded the file and its media clock advanced, read from the real element. Format coverage of the real decoder was exercised with WAV only; MP3/FLAC/etc. rely on the Chromium build in Electron (no custom decoder, by design). `.wma` is in the protocol's content-type table but Chromium cannot decode it, so it surfaces as an honest error.
- Volume and mute are not persisted. The queue persists (Phase 5 added its view and editing). Next is disabled (not hidden) when the domain says there is nothing after the current track.
- The playing queue is a snapshot of the list at the moment of the click: tracks added to the library afterwards are not appended (tracks removed are pruned). A track played from a list that no longer holds it plays alone.
- No gapless/crossfade, no media-key/SMTC/system-tray integration, no global hotkeys, no scrubbing preview (all later phases). The seek bar is 1-second granular.
- A play position is saved at most every 5 s while playing (immediately on pause/seek/switch); a hard kill can lose up to ~5 s. The `pagehide` path is not relied on.
- The TOCTOU gap noted under byte ranges. A moved/renamed file is still a new TrackId (Phase 2), so a queued track that was moved is dropped on the next reconcile.
- Not verified: real Windows (NTFS junctions vs. the real-path containment check, drive removal behaviour, SMTC), a real OS folder dialog, installer/signing. The two skipped Vitest tests are the "access denied" tests (Phase 2's and Phase 4's media-access one) that need a non-root POSIX user; the sandbox runs as root.
- Prettier is not enforced by any script and several earlier files already deviated; Phase 4 did no reformatting pass.

---

## PHASE 5 — LIBRARY (verified)

Phase 5 turned the minimal Phase 3 shell into a usable library without touching the Phase 0–4 architecture: the same typed IPC, the same `LibraryApplication` / `PlaybackApplication`, the same Zustand stores, the same migration (**no schema change; migration 4 is still the latest and was not edited**). **No dependency was added or changed** (every `package.json` and the lockfile are byte-identical to Phase 4).

### Where the rules live (nothing moved into React)
- **Domain (pure, tested in `@nova/domain`)**: `track-sorting.ts`, `library-grouping.ts`, and `clearQueue` in `queue.ts`. They reuse Phase 1A's `normalizeForComparison` / `normalizeWhitespace`; no second normalization policy exists.
- **Application (`@nova/infrastructure`)**: `LibraryApplication` gained `listTracks(sort?)`, `getSummary()`, `listGroups(kind)`, `getGroup(kind, key, sort?)`, `startup()`. `PlaybackApplication` gained `playGroup`, `enqueue`, `getQueue`, `playQueueItem`, `removeFromQueue`, `moveQueueItem`, `clearQueue`, and the `playTrack` context now accepts a sort and an album/artist/genre.
- **Renderer**: only displays what main answers and sends requests. A boundary test fails the build if UI source sorts, groups, or splices a queue.

### Sorting (`track-sorting.ts`) — one implementation for every list and for queue creation
Fields: title, artist, album, albumArtist, genre, year, duration; ascending/descending. Text compares by `normalizeForComparison` in plain UTF-16 code-unit order (never locale-dependent). **A missing value (no album/genre/year/duration, or blank text) sorts LAST in BOTH directions.** Direction flips only the primary comparison; the tie-break chain is always ascending and always ends on the TrackId, so the order is total and independent of input order. A numbered track with no disc tag counts as disc 1; a track with neither number stays last. Default = title ascending (identical to the Phase 3 order).

### Grouping semantics (`library-grouping.ts`)
- **Artist**: the ALBUM ARTIST if present, else the track artist (keeps compilations and featured-artist tracks with their album). Artist strings are never split.
- **Album**: identified by (artist group, album title), so two "Greatest Hits" by different artists are two albums. A track with no album joins that artist's **"Unknown Album"** (one per artist, listed after known albums).
- **Genre**: multi-valued genre text is split on `,` and `;` (not `/` or `&`: "R&B/Soul" is one genre); a track appears in EACH of its genres, so genre counts can sum to more than the track count. No genre → "Unknown Genre".
- **Missing**: blank-after-normalization is missing; the Phase 1 "Unknown Artist" fallback and a really missing artist are ONE unknown group. Unknown groups are always last.
- **Case/whitespace**: one group; the display name is the most frequent whitespace-normalized spelling (ties: smallest by code-unit order), so it never depends on input order.
- Counts (tracks per group, albums per artist, total albums/artists/genres) come from main (`library:getSummary`, `library:listGroups`), so they cannot depend on renderer ordering.

### Why backend grouping (not a renderer selector)
The renderer may not import domain code, and the queue made from an album must contain exactly what the album view shows. So grouping runs in main from the same pure functions the queue uses; the renderer fetches the active kind's groups only. Cost: one extra IPC read per refresh of what is on screen, which is cheap relative to the list itself. Each call derives from `trackRepository.list()` (no cache); that is fine at the scale of the Phase 2/3 `listTracks` which already loads everything.

### IPC (extends Phase 3/4; 10 new invoke channels, no new event, no new transport)
`library:getSummary`, `library:listGroups`, `library:getGroup` (new error code `group-not-found`); `library:listTracks` takes an optional `sort`; `playback:playGroup`, `playback:enqueue` (exactly one of `trackId` / `group`; `next` | `last`), `playback:getQueue` (a window: offset/limit ≤ 1 000), `playback:playQueueItem`, `playback:removeFromQueue`, `playback:moveQueueItem`, `playback:clearQueue`. Group keys are opaque strings built by main (validated only for length). **Queue edits name the position AND the track id**; if the queue changed since the renderer looked, main does nothing and returns the current state, so a stale click cannot hit the wrong track. The preload bridge is unchanged (`invoke` / `subscribe`); `TrackDto` is unchanged; no path crosses the boundary (contract test).

### Queue semantics (domain rules; unit-tested)
- **Clear** (`clearQueue`): everything except the current track is removed and the current track keeps playing; repeat mode is kept; a shuffled queue keeps a one-track snapshot (so turning shuffle off does not resurrect cleared tracks). Clearing a queue with nothing to clear changes nothing.
- **Remove the current track**: the Phase 1 rule — what would have played next becomes current (position resets to 0); if it was the last track, the new last track becomes current (the queue does not wrap). Repeat/shuffle modes are untouched. The renderer follows main, keeping play/pause (a paused player loads the next track paused).
- **Reorder** never changes which track is current. **Play next** inserts after the current track; **add to queue** appends. Adding to an EMPTY queue makes the track current but paused (nothing autoplays). Duplicates are allowed.
- **Shuffle**: unchanged Phase 1B behavior (a play-next while shuffled is also appended to the unshuffled snapshot; a manual reorder is not preserved after shuffle is turned off).
- **Play from the library**: `playTrack` / `playGroup` build the queue in main from the list the user is looking at, in the order it is shown (a sort is part of the request); the listener's repeat/shuffle modes are re-applied.

### Queue + library changes — the deliberate policy
**The queue is a snapshot that changes only through user commands.** A scan/watcher change never appends to it (new files appear in the library, not in a queue the user already built) and never reorders it; it only **prunes tracks that no longer exist** (Phase 4 behavior, now documented and tested at all levels, including real-Electron E2E with the real scanner and watcher). A moved/renamed file is a new TrackId, so it leaves the queue. Library lists/counts refresh on `library:changed`.

### Launch policy (`LibraryApplication.startup()`, called from `main/index.ts` after the window exists)
1. No roots registered → nothing happens (no scan, no watcher).
2. Start the folder watcher over all roots (idempotent) — **before** the scan, so a file changed while the scan runs is not missed.
3. One incremental reconciliation scan over the roots that are **available right now**. An unplugged drive is skipped (not failed) and its tracks are never removed; it recovers on the watcher's retry or a manual scan. A scan is never started while another is running, so scans never overlap.
It runs in the background and returns at once; the UI stays usable and progress arrives as the existing events. An interrupted scan is simply finished by the next launch (scans are incremental and the database is always consistent). The restored playback session comes back paused, reconciled against the library (Phase 4). `NOVA_STARTUP_SYNC=off` is a **test hook only** (the Phase 0–4 E2E specs launch with it because they drive scanning by hand); there is no user setting (the settings system is later work).

### Renderer
- **Store** (`library-store.ts`): `view` (tracks | albums | artists | genres | queue), `sort`, `summary`, `groups` (active kind only), `selection`, `detail` (+ its own sort; natural order when `undefined`). Stale answers are discarded by sequence counters; a refresh keeps the list on screen (no loading flash), re-reads only what is showing (All Tracks is marked stale and reloaded when shown again), and a group that vanished returns to the list with a plain notice. Playback store: a queue **window** (a few tracks before the current one + upcoming, "Show more" in pages of 200) re-read only while the panel is open and only when main's revision moves — never on position ticks.
- **UI**: `LibraryNav` (counts), `GroupBrowser` / `GroupDetail`, `SortControl`, `TrackTable`, `QueuePanel` (current, upcoming, earlier, modes, playback state, remove / move up-down / native drag-and-drop / jump / clear), all error and empty states (empty library, unavailable folders, no results, empty queue, retry buttons; no paths or internal text).
- **Search** (unchanged backend search, relevance order) is **global**: while the box has text its results replace the main list wherever you are; clearing returns you to the view and open album/artist/genre; choosing a view clears the search.

### Virtualization decision (the `useVirtualizer` advisory)
Investigated, not muted: the lint rule says React Compiler cannot memoize a component using `useVirtualizer()` and will skip it (already the safe behavior). **This project does not run React Compiler** (no babel plugin in the build), so there was no runtime effect. Resolution: (1) deleted the unused Phase 0 spike list (`Phase0VirtualList` + its test) — the second call site; (2) every real list (tracks, search results, albums/artists/genres, a group's tracks) now goes through ONE component, `library/VirtualRows.tsx`, with exactly one targeted `eslint-disable-next-line react-hooks/incompatible-library` plus a written justification; (3) a boundary test pins "exactly one `useVirtualizer` call site and exactly one suppression, for that one rule". A hand-written wrapper around `Virtualizer` was rejected: it would re-implement the library's own hook to silence a message. Virtualization itself (still `@tanstack/react-virtual`) was kept: only rows in view are in the DOM.

### Performance
Playback position lives in its own store and is read only by the progress display; track rows are memoised and receive only `isCurrent`/`isPlaying`, so a `timeupdate` burst re-renders nothing in a list (Phase 4 test kept; Phase 5 adds a mutation-checked guard that a list subscribing to position fails). Grouping/sorting run in main, never per tick. The queue panel never loads more than a 1 000-row window.

### Tests
Domain +37 (sorting, grouping, clearQueue + editing/mode rules), infrastructure +37 (listing, groups, summary, startup policy incl. unavailable roots / no double scan / restart reconcile; playGroup, enqueue, getQueue, edits, stale edits, library-change policy), desktop +31 (validation: kinds, keys, sorts, unknown keys, bounds, enqueue exclusivity, indices, trust, stable errors, path-free DTOs; boundary rules), UI +49 net (50 new, 1 deleted with `Phase0VirtualList`) (store: views, sort, selection, stale responses, refresh, errors/retry; components: nav, groups, detail, sort, actions, search+view, empty states, queue display/edit/drag/clear/window; playback store: queue window, edits vs. the audio element). **E2E +15 real-Electron specs** on a deterministic tagged-WAV library (`library-fixture.ts`; tags written as RIFF INFO chunks and read by the real scanner): browsing, sorting (missing-last), search, play track/album/artist/genre, queue edit (remove, buttons, real drag-and-drop, jump, remove-the-playing-track, clear, next/previous), library changes (scan and the real watcher), launch policy (restart reconcile, unavailable folder, interrupted scan, no roots).
**Mutation checks:** 35 deliberate breaks (sorting, grouping, clearQueue, stale-edit guard, enqueue position, group-play sort, startup availability/watch/overlap, validation, DTO path-safety, store sort/refresh/vanished-group/queue-window, nav search-clear, list virtualization, position subscription, drag-drop, Clear-enabled, and the launch policy at E2E level) — every one caught after two test gaps found by the first round were closed (unknown keys on `library:getGroup`; duplicate same-revision state event re-reading the queue). One invalid mutant (a non-reactive read) was replaced by a real one.

### Existing Phase 0–4 code touched
Additive: `shared` (`index.ts`, `library-ipc.ts`, `playback-ipc.ts`, new `browse-ipc.ts`), `domain` (`index.ts`, `queue.ts`, new `track-sorting.ts`, `library-grouping.ts`), `infrastructure` (`library-application.ts`, `playback-application.ts`, both `index.ts`), `desktop/main` (`index.ts` startup call, `ipc/validation.ts`, `playback-validation.ts`, both register files, new `browse-validation.ts`, `browse-dto-mappers.ts`), `ui` (`library-store.ts`, `LibraryShell.tsx`, `styles.ts`, `playback-store.ts`, `index.ts`; `TrackList.tsx` rewritten around `TrackTable`/`VirtualRows`; new components). **Deleted:** `Phase0VirtualList.tsx` and its test.
**Existing assertions updated because Phase 5 intentionally changed the behavior (nothing weakened, nothing skipped):** the playback channel list (+7), the registered-library-channel count (11 → 14) and playback count (9 → 16), the library store's startup call list now includes `library:getSummary` (3 tests), the library play context now carries its sort (1 test), and the library-shell E2E comment about "nothing starts by itself" (that spec launches with the startup policy off). Two row-button labels were renamed in the app ("Play next: X") because "Play X next" collided with existing "Play X" locators. `tests/e2e/helpers.ts` launches with `NOVA_STARTUP_SYNC=off` unless `startupSync: true`.

### Known limitations of Phase 5
- **Audible output is still unverified** (no sound device): E2E "plays" = Chromium decoded the file and its media clock advanced. E2E fixtures are WAV only (tags via RIFF INFO; there is no album-artist tag in that format, so album-artist grouping is covered by domain/application tests, not E2E).
- **Not verified:** real Windows behavior (NTFS junctions, removable drives, the watcher's retry timing for a returning drive), a real OS folder dialog, installer/signing.
- Groups and counts are computed per request from the full track list (no cache). Fine at current scale; revisit (a cached index invalidated on `library:changed`) for very large libraries.
- Genre splitting on `,`/`;` is a heuristic (a real genre containing a comma is split); artist strings are never split.
- The queue panel shows a window (a few tracks before the current one, then 200 upcoming with "Show more"); it is not a fully virtualized view of a 50 000-track queue. Drag-and-drop uses the browser's native events (no library) and moves one item at a time; the move buttons are the keyboard path.
- Search results are in relevance order (no sort control while searching); search always covers the whole library, never just the open album/artist/genre.
- Volume/mute persistence, lyrics, visual identity, tray/media keys, settings: not done (later phases). Prettier is still not enforced and Phase 5 did no reformatting.
- No `.git` exists in the working copy: no Phase 5 commit or hash.

---

## PHASE 6 — LYRICS + VISUAL IDENTITY (verified)

Phase 6 added synchronized lyrics, real artwork and a Now Playing experience on top of the finished Phase 0–5 architecture, without rewriting any of it: same typed IPC, same `PlaybackApplication` / media-access security, same Zustand stores, native `<audio>` still owns playback, main still owns the queue. **No schema change (migration 4 is still the latest), no new external dependency.** The only manifest change is a **workspace link**: `@nova/ui` now depends on `@nova/domain` (`workspace:*`, lockfile updated) — see "Renderer ↔ domain" below.

### Lyrics — one domain, no second parser
- **Domain reused unchanged**: `parseLyrics` (main), `getActiveLyricIndex` and `getLyricSeekTime` (renderer, through one adapter). Times are canonical **integer milliseconds** end to end (the file's `[offset:]` is already applied by the parser); no seconds appear except at the native `<audio>` boundary, no second clock exists. A new `lyrics-contract.test.ts` pins the exact semantics the IPC/UI depend on (ms + offset, sort and tie order, boundary activation, empty-line and multi-timestamp behavior, never-throws on garbage).
- **Sidecar policy** (`infrastructure/media/track-sidecars.ts`, deterministic and conservative): the lyrics of `<dir>/<name>.<audio ext>` are `<dir>/<name>.lrc`, else `<dir>/<name>.LRC` (that order; first hit wins). The track must first pass the same `MediaAccess.resolveTrack` door as the audio (registered root, still the folder that was registered, real path inside it, a real audio file). The sidecar's **real path** (links followed) must stay inside the track's real root, otherwise it is treated as absent (a `.lrc` that is a link out of the library is ignored). No recursive search, no other file names, no renderer-supplied paths. Files over 1 MiB are `unreadable` (and are never read whole; reads are bounded). UTF-8; BOM and malformed lines are the parser's job.
- **Results are statuses, never errors**: `found` (≥1 timed line) · `empty` (readable, no timed lines) · `none` (no sidecar) · `unavailable` (track file/root unreachable) · `unreadable` (sidecar cannot be read: too large, not a file, no permission). Only an invalid id or an unknown track is an IPC error (`invalid-request` / `track-not-found`). Nothing is cached, so removing a root stops access at once.
- **IPC** (2 new invoke channels in the existing contract, no new event, preload unchanged): `track:getLyrics {trackId}` → `{status, lines:[{timeMs,text}]}`; `track:getArtwork {trackId}` → `{status, dataUrl?}`. Validation: exact shape, valid TrackId, unknown keys rejected, sender trust, stable errors; lines are copied field by field; **no path in any request or response** (the shared-contract path-free test now covers `track-detail-ipc.ts`).

### Artwork
- The track model already carried an artwork *kind* (`embedded`/`none`) but no bytes. Phase 6 adds the bytes through the same door: `track:getArtwork` resolves the track through `MediaAccess`, reads the first embedded picture with `music-metadata` (inside the existing metadata adapter, so the "only the adapter imports music-metadata" boundary still holds), accepts only jpeg/png/gif/webp/bmp (so **no SVG**, no HTML), refuses empty or > 5 MiB pictures, and returns a `data:` URL. A track whose artwork kind is `none` is never even asked for. Any reader failure means "no artwork"; it never affects playback.
- **Stale protection**: switching tracks drops the previous cover and lyrics immediately, and every answer carries the sequence of the request that asked, so a late answer for a previous track is discarded (both unit-tested with out-of-order promises and mutation-checked). The `<img>` is keyed by the image, a decode failure falls back to the mark, and a deliberate fallback (gradient + ♪) shows while loading / when absent.
- External (sidecar) cover files (`cover.jpg`) are **not** implemented (the scanner never produced the `external` kind); documented limitation.

### Renderer ↔ domain (the one narrowed boundary)
The renderer used to import nothing from `@nova/domain`. Re-implementing the lyric search in React would have been a second implementation of a Phase 1D rule, so the boundary was narrowed to exactly one exception: **`packages/ui/src/nowplaying/lyric-sync.ts` imports `getActiveLyricIndex` and `getLyricSeekTime` from `@nova/domain` and nothing else**, enforced by `renderer-boundary.test.ts` (only that file; only those two names; no `parseLyrics`; no other UI source parses LRC or searches lyric lines). Parsing stays in main.

### Renderer / stores
- `nowplaying/now-playing-store.ts`: follows the playback store's current track (the one authority for "what is current"), owns only the lyrics and artwork slices, reference-counted connect, `retryLyrics()`. No queue, no playback state, no second track copy.
- `usePlaybackPositionSelector(selector)` (new hook): derives a primitive from the position store, so `LyricsPanel` re-renders **only when the active line changes**, and only the two rows whose flag changed re-render (rows are memoised). Isolation is now **counted with React `Profiler`** (not just observed in the DOM): 300 position updates inside one line cause 0 commits of the lyric panel and 0 of the track list.
- `LyricsPanel`: every state — nothing playing, loading, lines (with ♪ for empty timed lines), none, empty, unavailable, unreadable, and a quiet "couldn't be loaded · Try again" for a failed lookup (never styled as an error, never touches playback). **Click-to-seek** calls the existing `seekMs` on the playback store (the single path to the audio element). **Scrolling**: the active line is centred with one smooth `scrollTo` per change of line (not per position update); after the user scrolls by hand auto-follow waits 4 s; a new track re-mounts the list at the top.
- `NowPlayingView` + `Artwork` + `PlayerThumb`: cover, title, artist, album · year, playback state, "Track N of M · View queue", elapsed / duration; the player bar gained the small cover that opens Now Playing. The `LibraryView` gained `nowplaying`; the nav gained a "Now Playing" tab (only when both stores exist, so the library-only shells keep working); the library-admin sidebar is hidden on that view so it gets the full width.

### Visual identity
A restrained, consistent pass rather than a template: brand mark + wordmark header, refined palette (indigo accent `#4a45d6`, softer neutrals), 12 px radii with a hairline shadow, system-ui typography with a clear hierarchy (primary: cover + title + transport; secondary: progress; tertiary: album/queue/lyrics). Fixed in the pass after inspecting the running app (screenshots at 1280×820, 760, 560 and tall): a stray page scrollbar (default body margin on top of a 100vh shell), a sidebar crowding Now Playing, "+ Queue" wrapping onto two lines, and table headers 3 px off their rows. **Window**: `minWidth 560 / minHeight 480` (below that the layout cannot stay usable); Now Playing is fluid — cover and lyrics side by side, stacking at the minimum width; extra height goes to the lyrics. E2E checks no horizontal overflow, no overlap, readable lyrics at 1280×800, 760×900, the 560 minimum, and 1100×1300.

### Tests (all counts exact; measured from the final ZIP's fresh extraction, see the validation snapshot)
- **Domain** +6 (`lyrics-contract.test.ts`). **Infrastructure** +23 (`track-sidecars.test.ts`: association, precedence, offset/BOM/empty/multi-timestamp/malformed, size limit, directory-as-sidecar, permissions, symlink out/in, track-link-out, removed root, unavailable root, invalid id/unknown track, no paths; artwork: real embedded PNG read from a real file, none, type allow-list, size limit, reader failure, same access rules). **Desktop** +35 (IPC validation, trust, stable errors, path-free DTOs, data-URL media type, field-by-field line copy; boundary tests for the domain exception). **UI** +38 (store: following, reset, stale answers, failures/retry, lifecycle; components: every state, boundary-exact activation, pause/seek/restart/switch, click-to-seek, scrolling, artwork, Now Playing, player thumb, no-store fallback; Profiler isolation).
- **E2E +8 real-Electron specs** (`nowplaying-lyrics.spec.ts`; deterministic: tagged WAVs, WAV with an embedded PNG in an `id3 ` chunk, and small `.lrc` fixtures in `tests/fixtures/lyrics/` — normal, offset, malformed, empty lines, multiple timestamps, empty file): Now Playing metadata + advancing playback + lyrics that follow it + click-to-seek on the real `<audio>`; switching tracks (offset applied, malformed tolerated, ♪ breaks, multi-timestamp); none / empty / oversized / **escaping-symlink** sidecars give calm states; lyrics appearing for a file added later; real artwork + no stale cover; library → Now Playing → queue → controls staying in sync; restart restoring the session and lyrics (paused); window sizes. The 54 existing Phase 0–5 specs pass **unmodified**.
- **Mutation checks: 32 deliberate breaks, all caught** — lyric precedence, sidecar containment (also at E2E level), "none" vs "empty", wrong-name association, size limit, artwork type allow-list and size limit, invalid-id handling, denied-access handling, parse-failure handling, IPC unknown keys / media type / field copying, active-line boundary (±1 ms), seek time (also E2E), stale lyrics after a switch, stale answers (lyrics and artwork), previous cover kept while loading, broken-image fallback, album metadata, position-leak (Profiler), click-to-seek removed, auto-scroll ignoring the user, no-lyrics state, store not following playback, artwork requested for tracks without any, refetch on every update, frozen (non-reactive) active line, queue position. Five gaps were found by the first round and closed: IPC unknown keys, data-URL media type, field-by-field line copy, stale-answer ordering (the fake `hold` could not reorder answers; replaced by controlled promises), and render-count isolation (a DOM observer cannot see a re-render that changes nothing). One mutant was invalid (a non-reactive read) and was replaced. After the runs the tree was re-verified (typecheck, lint, all tests).

### Existing Phase 0–5 code touched
Additive: `shared` (`index.ts`, new `track-detail-ipc.ts`), `infrastructure` (`index.ts`; new `media/track-sidecars.ts`, `media/fs-readers.ts`; `metadata/music-metadata-reader.ts` gained `readEmbeddedPicture`), `desktop/main` (`index.ts`: wiring + window minimum size; `ipc/ipc-errors.ts`, `playback-validation.ts`, `register-playback-ipc.ts`), `desktop/renderer` (`App.tsx`, `main.tsx`, `index.html` body margin), `ui` (`library-store.ts` view type, `LibraryNav`, `LibraryShell`, `TrackList` (nowrap actions, header alignment), `GroupBrowser` (nowrap), `styles.ts`, `PlayerBar` (thumb), `PlaybackStoreProvider` (selector hook), `index.ts`, `package.json`/`tsconfig.json` (domain link)). **Existing assertions updated because Phase 6 intentionally changed the behavior:** the exact playback-channel list and count (16 → 18, two `track:*` channels; the registered-handlers test filters `track:` too), `renderer-boundary.test.ts` (domain-import rule narrowed to the single lyric adapter, with its own exactness tests). Nothing weakened or skipped; no existing E2E spec was edited.

### Known limitations of Phase 6
- **Audible output remains unverified** (no sound device); E2E "plays" means Chromium decoded the file and its media clock advanced. Fixtures are WAV only, including the embedded cover (an `id3 ` chunk); other formats' embedded pictures are exercised only at the unit level (an ID3-tagged MP3).
- **Not verified:** real Windows behavior (NTFS junctions/removable drives for sidecars, real DPI/scaling), a real OS folder dialog, installer/signing.
- Lyrics: `.lrc` sidecars only — no lyrics embedded in tags (USLT/SYLT), no `.txt`, no per-word (enhanced) highlighting, no cloud lookup. The sidecar is looked up when a track becomes current; adding one while it plays shows on the next play (no watcher on sidecars). A track played twice in a row (same id) keeps its lyrics (no refetch).
- Artwork: embedded pictures only (first one), shown as `data:` URLs (≤ 5 MiB); no `cover.jpg` sidecar, no thumbnails/caching, so a large cover is re-read when its track becomes current. The fixture cover is a 1×1 PNG (stretched).
- The Now Playing view shows "Track N of M" but not the upcoming track's title (the queue window is only loaded while the queue view is open).
- Visual identity is a restrained first pass (system fonts, inline styles, light theme only); no dark theme, no animation system, no settings. Narrow windows stack Now Playing and the page scrolls.
- Window minimum size (560×480) is the only shell change; real shell integration (tray, media keys, window state) is Phase 7. Volume/mute persistence is still deferred to Settings. Prettier is still not enforced. **No `.git`** exists: no Phase 6 commit or hash.

---

## ARCHITECTURE BOUNDARIES

Phase 1 (all of `packages/domain`) is **pure domain logic** and must remain independent of:

- Electron
- React
- Zustand
- DOM / browser APIs
- Node filesystem APIs
- `better-sqlite3` / any database
- IPC
- the network
- external UI libraries

This is enforced by an automated test (`packages/domain/src/boundary.test.ts`), not just a convention — it scans every domain source file for forbidden import specifiers and forbidden global tokens, and still passes after Phase 2 (the Phase 2 additions to the domain are `track-repository.ts` — a pure port + error type — and nothing else).

Phase 2 infrastructure boundaries (all verified by grep/tests at the Phase 2 checkpoint):

- `better-sqlite3` is imported only inside `packages/infrastructure` (`database/`, `repositories/`, Phase 0 diagnostics); the domain port exposes no driver types.
- `music-metadata` is imported only by `metadata/music-metadata-reader.ts` and the Phase 0 probe (test-enforced).
- Only `apps/desktop/src/main`, the preload and `nova-media-protocol.ts` import `electron`; nothing in the new Phase 2 code does.
- The renderer, preload and `packages/ui` import no infrastructure, filesystem, database or metadata code. The shared IPC contract is unchanged.
- No module-level mutable state or singletons in the Phase 2 code; the only process-level holder is `libraryServices` in Electron main (Phase 4 adds one more: `playbackApplication`, created and disposed beside it).

Phase 4 boundaries (test-enforced — see `renderer-boundary.test.ts` and `media/boundary.test.ts`):

- The renderer reaches the backend only through `window.nova` (`invoke`/`subscribe`), touches `window.nova` only in the renderer entry, creates exactly one `<audio>` element, builds no `nova-media` URL, and contains no queue/shuffle logic. Queue rules run in `packages/domain`, behind `PlaybackApplication` in main.
- The media layer (`infrastructure/src/media/`) is Electron-free; only `nova-media-protocol.ts` imports Electron's `protocol`. Library media is authorized per request against the *currently registered* roots; no grant is cached.

---

## LOCKED ARCHITECTURAL DECISIONS

A future session should not casually reconsider any of the following without new evidence:

- **One repository**, not the reference app's two-repo sync architecture
- **Desktop-only application** — no browser/File-System-Access-API fallback code path
- **TypeScript strict mode**, enforced via project references (`tsc -b`, not isolated per-package `--noEmit`, which does not correctly resolve cross-package composite references)
- **Domain / infrastructure / UI separation**, with `packages/domain` having zero framework or I/O dependency
- **Typed IPC contracts** defined once in `@nova/shared`, consumed identically by main and preload
- **Zustand** for renderer state — real, separate factory stores: the library store (Phase 3) and the playback store (Phase 4); high-frequency playback position lives in its own tiny store
- **`better-sqlite3`** for persistence (implemented in Phase 2A/2B; schema is append-only migrations)
- **`music-metadata`** for tag reading (adapter implemented in Phase 2D) — replaces the reference app's hand-rolled binary ID3/MP4 parser
- **`@tanstack/react-virtual`** for the eventual virtualized track list (not the reference app's hand-rolled windowing)
- **Playwright driving the real Electron binary** for E2E — confirmed working at Electron 44
- **Vitest** for unit/component tests
- **Native Windows recursive `fs.watch` + debounce + periodic reconciliation** for folder watching — not `chokidar` (implemented in Phase 2F)
- **`nova-media://` custom protocol with hand-built HTTP byte-range support** — NOT a `file://` fallback; `net.fetch()` on `file://` was proven in Phase 0 to not set proper `206`/`Content-Range` semantics. Library tracks are addressed only by opaque `nova-media://track/<TrackId>` and authorized per request against registered roots; never expose a path-based URL for library files, never add a second media mechanism or HTTP server
- **Main owns the queue; the `<audio>` element owns playback.** Position is whole milliseconds in the domain, IPC and database; seconds exist only at the renderer's media boundary
- **`crypto.randomUUID()`** for all entity IDs — the `uuid` package is never installed
- **No direct renderer filesystem access** — all I/O happens in the main process behind the typed IPC boundary
- **No global singleton architecture** (the reference app's `NovaLibrary`/`NovaPlayerCore`/etc. pattern is explicitly rejected)
- **No monolithic `app.js`**-style controller
- **No hand-rolled binary metadata parser**
- **No browser/Electron duplicate ingestion pipelines** (the reference app's dual `addFiles`/`addNativeEntries` paths are explicitly rejected)
- **No second parallel persistence system** (no `localStorage`/IndexedDB split alongside SQLite)
- **No automatic updater until explicitly implemented** — `electron-updater` is not even installed yet; no fake/placeholder update feed will ever be introduced
- **M3U/M3U8 playlist export/import is planned but NOT an initial requirement** unless the roadmap explicitly says otherwise when that phase arrives
- **GSAP should be used selectively**, not as a universal animation dependency — each proposed animation should be justified against plain CSS first

---

## KNOWN LIMITATIONS / DEFERRED

- **Pre-existing Prettier formatting drift** in `queue.ts`, `shuffle.ts`, `track.ts`, and three test files (`boundary.test.ts`, `deduplication.test.ts`, `search.test.ts`) — accumulated across Phases 1A–1C, not fixed since it's cosmetic and out of scope for the phases that found it. A dedicated formatting pass is reasonable future cleanup, not urgent.
- **Playback position is a plain `number`** (whole milliseconds) with no branded type. Phase 4 wired real playback time end to end: the seconds→ms conversion exists in exactly one place (`toMs` in the playback store), IPC rejects non-integer/negative positions, and a contract test asserts every position field ends in `Ms` — so a branded type has not proved necessary.
- ~~**The Windows NSIS installer has never actually been built or run**~~ — **partly resolved in Phase 9**: the unpacked build and the NSIS installer were built (installer cross-built on Linux with Wine), and the packaged Linux app passes a smoke test. The installer has **still never been installed or run on real Windows** (see the Phase 9 section). (Original text: The Windows NSIS installer has never actually been built or run — the validation environment throughout Phase 0–1 has been Linux-only sandboxes with no Wine available. `pnpm --filter @nova/desktop run build:unpack` (an unpacked `electron-builder --dir` build, no signing/NSIS required) has also not been attempted. This needs a real Windows machine or CI runner before Phase 2 or later phases can consider packaging validated.)
- **Code signing remains entirely environment-gated** — no certificate or Azure Trusted Signing account has been configured or tested; the pipeline is designed to support it but nothing has exercised that path for real. **Still true after Phase 9**: the installer is unsigned and Windows will show a SmartScreen warning.
- **Real release/update infrastructure is intentionally deferred** — no update feed, no `electron-updater` usage anywhere yet. **Still true after Phase 9** (`publish: null`; `electron-updater` is not a dependency).
- **Phase 2 has not been exercised on real Windows.** The Windows path rules are pure string logic tested on any host, but NTFS case-insensitivity, 8.3 short names via `realPath`, junction behaviour, reserved names on disk, and — importantly — **recursive `fs.watch` on Windows (ReadDirectoryChangesW: event bursts, buffer overflow, locked/in-use files, network/removable drives)** were only verified on Linux. The periodic reconciliation is the designed safety net for anything the OS drops. Also exercised only on Linux: the Electron lifecycle E2E (under xvfb).
- **A moved or renamed file gets a new TrackId** (removal + addition). No fuzzy identity matching exists by design. Once playlists/history reference TrackIds (Phase 5+), a relink strategy (e.g. a same-scan exact dedup-key match, or a persisted content fingerprint) must be decided deliberately.
- **Stored dedup keys depend on the domain's current normalization.** If `normalizeForComparison` ever changes, existing `dedup_key` values go stale and need a recompute migration.
- ~~A corrupt stored row makes `list()` / `listFileStates()` throw~~ — **resolved in Phase 8**: unreadable rows are removed and reported when the library opens (reads stay strict).
- **External artwork (cover.jpg / folder.jpg) is not detected.** Only embedded artwork is recorded (`hasEmbeddedArtwork`); the domain supports external artwork, but a scanner policy for it (and how it interacts with incremental scanning, since adding a cover does not change the audio file's mtime) is undecided.
- Library roots are persisted since Phase 3 (since Phase 5 the main process watches and runs one reconciliation scan at launch; see the Phase 5 section). `.wma` is not scanned. `modifiedAtMs` is whole milliseconds (sub-millisecond edits are not detected); on FAT/exFAT the OS itself only keeps 2 s resolution.
- **A scan reports a progress snapshot on every step**; a future UI/IPC layer should throttle.
- **`music-metadata` reads the whole embedded cover into memory per file** (needed to know it exists); acceptable at bounded concurrency, worth revisiting for very large libraries.
- (Resolved in Phase 5) The `useVirtualizer` React Compiler advisory: the Phase 0 list was deleted and the one remaining call site carries a single justified suppression; lint is 0 errors / 0 warnings. Historical note: it was informational, not an error, and has been present since Phase 0 — worth revisiting once Phase 5's real virtualized track list is built.

---

## DO NOT REDO COMPLETED WORK

A future Claude session must **NOT**:

- Restart Phase 0
- Rebuild the domain layer from scratch
- Replace the chosen architecture without new evidence
- Replace `better-sqlite3`
- Replace the IPC architecture
- Introduce a second repository architecture
- Recreate Phase 1A–1D functionality
- Redo Phase 2A–2G (database lifecycle/migrations, repository port + SQLite implementation, filesystem/path policy, metadata adapter, scanner, watcher, composition root) — extend via NEW migrations and new code, do not rewrite
- Rewrite working domain code purely for style (see Known Limitations re: Prettier drift — leave it unless explicitly asked)
- Edit a shipped migration — add a new one at the end of `MIGRATIONS`
- Add `chokidar`, another metadata parser, an ORM, a second filesystem abstraction, or a global service singleton
- Redo Phase 3 half 1 (IPC contract, preload bridge, handlers, DTO mappers, `LibraryApplication`, library-roots persistence) — extend it, do not rewrite; never widen the preload surface beyond `invoke`/`subscribe`, never expose a path-taking `addRoot`, never put file paths in track DTOs without a deliberate decision
- Redo Phase 3 half 2 (the library store, shell components, their tests) — extend them in later phases; keep the renderer free of Node/Electron/infrastructure imports and keep paths out of DTOs and UI
- Redo Phase 4 (media access/`nova-media://` track URLs, `PlaybackApplication`, playback IPC, migration 4, the playback store and player bar, the E2E) — extend it; never add a path-based URL for library files, never move queue rules into the renderer, never edit migration 4 (add migration 5)
- Redo Phase 6 (the sidecar lyrics/artwork service and `track:*` IPC, the now-playing store, `LyricsPanel`/`NowPlayingView`, the lyric domain adapter, the Phase 6 specs) — extend it, do not rewrite; lyrics reuse the Phase 1D domain, parsing stays in main
- Redo Phase 5 (grouping/sorting domain, the browse/queue IPC, `startup()`, the library store views, `VirtualRows`, queue panel, the Phase 5 specs) — extend it, do not rewrite; the queue-is-a-snapshot policy and the single `useVirtualizer` call site are deliberate
- Redo Phase 7 (the `main/shell/` modules, the `shell:command` event, the E2E hook) — extend it; no generic command channel, no second playback path
- Redo Phase 8 (the lifecycle policy, window policy, verified media open, library recovery) — extend it
- **Start Phase 9 (Release) or later phases before being explicitly instructed to**

---

## PHASE ROADMAP

```
Phase 0 — Scaffolding / CI                         COMPLETE
Phase 1 — Pure Domain Core                         COMPLETE
Phase 2 — Persistence + Filesystem Infrastructure  COMPLETE
Phase 3 — Typed IPC + Minimal Shell UI            COMPLETE
Phase 4 — Full Playback                            COMPLETE
Phase 5 — Library                                  COMPLETE
Phase 6 — Lyrics / Visual Identity                 COMPLETE
Phase 7 — Desktop Shell                            COMPLETE
Phase 8 — Hardening                                COMPLETE
Phase 9 — Release / Documentation                  COMPLETE — GREEN WITH CAVEATS (installer built, not verified on real Windows)
```

---

## PHASE 7 — DESKTOP SHELL (COMPLETE — GREEN)

*(Corrected once after the first Phase 7 hand-off: notifications were added, and the close-to-tray default was reverted to close = quit. This section describes the corrected state.)*

**What was built.** The roadmap line was "system tray, media keys, window state, notifications/shell integration". All of it is implemented: a single main window and a single running instance, a system tray, the three OS media keys, **track-started notifications**, remembered window size/position/maximized, an **opt-in** hide-to-tray on close, a real packaged app icon, and the Windows AppUserModelID.

**Close policy (reconciled).** **Default: closing the window QUITS the app, exactly as in Phases 0–6.** Hide-to-tray exists only as an opt-in: `closeToTray: true` in `<userData>/shell-state.json`, honoured only while a tray icon is active. There is **no settings screen and no user-accessible switch** for it, so for an ordinary user close = quit always; the opt-in is a capability for a future settings screen (later work), not a shipped behaviour change. Tests cover the default, an explicit `false`, invalid values (all quit) and the opt-in (hide, same-window Show, no duplicates). Tray "Quit" always exits.

**Notifications.** Event model finding: `PlaybackApplication` previously emitted events only for library changes; a started track was only visible as a command *reply* to the renderer, so it was not a reliable main-side signal. Fix, reusing the existing `subscribe` architecture (no second event source): a new application event `{ type: 'track-started', state }` (`playback-application.ts`), emitted from the single `started()` helper that every start path uses (play track / play group / queue jump / Next / Previous-back / a track ending into the next). It is **not** emitted for a restart of the same track (repeat one, Previous past the threshold), stop-at-end, stale clicks, queue edits, mode/position changes, or a restored session at launch. It is **not** forwarded to the renderer (`bridgePlaybackEvents` filters it). `shell/track-notifier.ts` consumes it: title + "artist — album" body (title falls back to "Unknown title"; control characters/line breaks flattened, lengths bounded; never a path or id); the same track is never announced twice in a row; nothing is shown while the window has focus; an unsupported platform (`Notification.isSupported()` false) or a notification the OS refuses is contained and logged; one live notification at a time (a new one replaces the old); clicking it shows the window; `start()` subscribes once, `dispose()` unsubscribes (called first in shell shutdown). Electron `Notification` is used with `silent: true` and the packaged app icon. No setting, no dependency, no new IPC. Known limitation: the signal means "main started a track"; if the file then fails to play, a notification may already have been shown.

**Layout (all in `apps/desktop/src/main/shell/`, each unit-tested with injected ports):** `shell-state.ts` (window state + `closeToTray` opt-in, sanitised on read, atomic write to `<userData>/shell-state.json`, **no migration**; migration 4 untouched) · `window-manager.ts` (THE window: show/restore/focus, hide-on-close only when opted in, geometry) · `tray-controller.ts` (Show · Play / Pause · Next · Previous · Quit; click shows; idempotent) · `media-keys.ts` (`MediaPlayPause`/`MediaNextTrack`/`MediaPreviousTrack`; failures per key logged, never fatal) · `command-dispatcher.ts` (the one path to the player) · `track-notifier.ts` · `app-shell.ts` (idempotent `start()`/`dispose()`) · `electron-shell.ts` (Electron adapters). `main/index.ts`: `requestSingleInstanceLock()` (second launch shows the running window and exits), `second-instance`/`activate` → `shell.show()`, `before-quit` → `beginQuit()` + `dispose()` first (idempotent; the event fires twice by design), AppUserModelID `com.novaplayer.desktop`.

**How shell commands reach playback.** Tray item / media key → `dispatch(command)` → typed `shell:command` event → the renderer playback store runs its existing `togglePlay()` / `next()` / `previous()` (the on-screen button actions), so Next/Previous call `playback:next` / `playback:previous` with the **real position** and main applies the queue rules. No second playback controller; main never touches the audio element or renderer state.

**IPC / security.** One new **event** channel (main → renderer), `shell:command` (`toggle-play | next | previous`); **no new invoke channel**, so no new renderer-originated surface. The bridge is still exactly `invoke` + `subscribe` (E2E asserts it, and that `invoke('shell:command')` is refused). `track-started` never leaves main. No paths/handles reach the renderer. `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` unchanged; Electron 44.4.5; no new dependency. One existing exact-event-list type assertion (`ipc-contract.test.ts`) gained `'shell:command'`, and one assertion in `playback-application.test.ts` ("added tracks are not appended") was narrowed to `state-changed` events because its setup `playTrack` now correctly emits `track-started`; its intent (a reconcile pushes no state event) is unchanged. Nothing was deleted, skipped or weakened.

**Lifecycle guarantees.** One window; one tray icon; media keys registered once; one notifier subscription; a second launch cannot create a second window/DB connection; `dispose()` stops notifications, releases media keys, removes the tray, saves window state — once; `window-all-closed` policy unchanged (quit unless darwin; Windows-only product, no macOS support added).

**Packaging.** `resources/icon.png` (256 px) and `resources/tray.png` ship via `extraResources` + `win.icon`; `resourcePath()` reads from `process.resourcesPath` when packaged. **The installer was NOT built in Phase 7** (historical; it was built in Phase 9 — see the Phase 9 section; the packaged-path branch is now exercised by the Phase 9 packaged smoke test on Linux, not on Windows).

**Test hook.** `NOVA_E2E_SHELL_HOOKS=1` (set only by the E2E launcher) exposes the shell (tray menu, dispatch, notifier history) and a first-show promise on main-process globals; unreachable from the renderer.

**Validation (Linux sandbox, Node 22, pnpm 12.6.0, Xvfb).**
```
Baseline (Phase 6 ZIP, before any change): typecheck/lint/build clean; Vitest 1866 passed | 3 skipped; E2E 62/62.
Working tree, final: typecheck 0 errors · lint 0 errors/0 warnings (--max-warnings 0) · build OK.
Vitest: 1950 passed | 3 skipped (1953), 73 files — domain 378 · infrastructure 846 (+3 skipped) · desktop 430 · ui 296. (+84 vs Phase 6.)
        The 3 skipped are the same 3 as Phase 6 (non-root POSIX chmod tests).
E2E (real Electron, Xvfb): 75/75 — 62 existing Phase 0–6 specs + 13 in desktop-shell.spec.ts.
Repeated runs: desktop-shell.spec.ts x5 = 65/65; the four lifecycle-sensitive tests x25 = 100/100.
   A flake was found and fixed during repeats: tests that hid/closed the window right after launch raced the window's first
   `ready-to-show` (isVisible() is already true before it on Linux, and the first show then brought the window back). It was a
   test-timing defect, not an app defect (a user cannot click close before the first frame). Fix: a deterministic first-show promise
   in the test hook that the specs await. Re-verified as above.
Mutation checks (each applied, tested, reverted; tree re-verified): round 1 lifecycle, 18 mutants (duplicate tray / media keys, Play-Pause->Next in tray and
   key binding, Show creating a second window, shutdown not releasing keys/tray, hide-on-close never/always, quit not lifting hide, listeners doubled,
   arbitrary command names, renderer Next->Previous, Play/Pause ignored, off-screen position accepted, shell:command dropped from the bridge allowlist,
   single-instance lock removed, tray click handler removed, Show wired to a no-op) — 18/18 caught.
   round 2 notifications + close default, 14 mutants (no dedupe, double subscription, reacts to state-changed, ignores focus, OS failure not contained,
   shows when unsupported, no fallback title, never unsubscribes, shell not disposing the notifier, started() not emitting, restart emitting,
   bridge forwarding track-started, close-to-tray default flipped to ON, truthy values accepted) — 14/14 caught; plus the default-flip mutant was caught by the
   real-Electron "DEFAULT: closing quits" test. (An interrupted earlier run once left a mutant applied; a verification pass found and restored it.)
Fresh-extraction validation (candidate ZIP extracted into a clean directory; `pnpm install --frozen-lockfile`; Electron binary fetched with the package's own
   install.js because pnpm skips install scripts): typecheck 0 errors · lint 0 warnings · build OK · Vitest 1950 passed | 3 skipped (1953), 73 files
   (domain 378 · infrastructure 846+3 skipped · desktop 430 · ui 296) · full E2E 75/75 (all 62 existing + 13 new specs).
   The repeated-run checks (shell spec x5, lifecycle tests x25) were run on the working tree, not re-run in the fresh copy.
   The final ZIP differs from the validated candidate only in this status document (this results block replaced a placeholder); verified by diff.
```

**Real-platform checks.**
- *Verified in real Electron under Xvfb:* window creation; real `Tray` creation and its real menu items clicked; real `globalShortcut.isRegistered` for the three keys; hide/show/close/quit and process exit codes; default close = quit; opt-in hide-to-tray; second-instance hand-over; persisted bounds; real `<audio>` reacting to tray commands; the notifier receiving real `track-started` events from the real playback path, with the right title/body, no paths, no duplicates, none at launch with a restored session.
- *NOT verified:* **a notification actually displayed** — `Notification.isSupported()` is **false** in this sandbox (no desktop notification service; an attempt with a stand-in D-Bus service did not change that), so the real-Electron notification test ran its unsupported-environment branch (nothing attempted, nothing thrown); the "shown" branch and the Electron adapter's `new Notification(...).show()`, click handling and replacement are covered by unit tests with a fake port and by code review only. **On Windows still to check by hand:** a toast appears for a new track while the window is not focused (and not while focused), clicking it brings the window forward, the toast shows the app icon and name, Focus Assist / Do-not-disturb behaviour; a physical media-key press; the tray icon's appearance in the notification area; taskbar identity (AppUserModelID); minimize/restore with a real window manager (unit tests only); the installer build; audible output.

**Known limitations / risks.** `closeToTray` has no UI (opt-in only through the state file); the tray menu's "Play / Pause" label is static; a shell command sent while the renderer is still loading is dropped; media keys can be owned by another app (logged, not retried); no Windows SMTC / lock-screen media overlay (`globalShortcut` only); a track-started notification can precede a playback failure.

**Next was: Phase 8 — Hardening** (now done, see below).

---

---

## PHASE 8 — HARDENING (COMPLETE — GREEN, with caveats)

**Method.** Audit first, then reproduce, then fix. Nothing was changed without a failing test, a real-Electron reproduction, or a code trace; areas found correct were left alone (listed below).

### IMPORTANT: the supplied "Phase 7" ZIP was not exactly the documented Phase 7 state
`NOVA_REBUILD_STATUS.md` documented Vitest 1,950 passed / 3 skipped (73 files). The actual archive measured **2,072 passed / 15 failed / 3 skipped (80 files)** because it also contained an unfinished earlier Phase 8 attempt (files dated after the Phase 7 document, none wired into `main/index.ts`): `main/lifecycle.ts`(+test), `main/shell/window-policy.ts`, `main/shell/app-location.ts`, `main/ipc/register-diagnostics-ipc.ts` (each with passing tests), `media/verified-open.ts`, and three test files written ahead of any implementation (`media/media-hardening.test.ts`, `composition/library-recovery.test.ts`, `application/library-application-hardening.test.ts` = the 15 failures). The archive also shipped `node_modules`, build output and `test-results/` (excluded from the Phase 8 ZIP). These files were treated as **unreviewed candidate work**: every one was read, its tests were judged against the code, the missing implementations were written, the unwired modules were wired, and the result was mutation-checked. Phase 7 behaviour itself was not failing (typecheck, lint clean; E2E 74/75 with one pre-existing flaky test, below).

### Baseline (measured, Linux, Node 22.22, pnpm 12.6.0 per `packageManager`, Xvfb)
Typecheck 0 errors · lint 0 warnings · build OK · Vitest 2,072 passed / 15 failed / 3 skipped (80 files; the 15 are the unwired-hardening tests) · E2E 74 passed / 1 failed (`library-shell` "real scan progress and cancellation": fails ~1 run in 4 on the untouched app — see finding 12).

### Findings and fixes
| # | Finding (component) | Evidence | Sev. | Status | Fix | Regression coverage |
|---|---|---|---|---|---|---|
| 1 | One unreadable stored track row makes `list()`/`listFileStates()` throw; the track list, every scan and queue restore fail on every launch (repositories, composition) | Documented limitation + `library-recovery.test.ts` failing (5) | High (availability) | Confirmed | `SqliteTrackRepository.removeUnreadableRecords()` run by `createLibraryServices` at open: all-or-nothing transaction, removes only unreadable rows, reports id+reason via `onDiagnostic` (logged by main); reads stay strict; the file is untouched so the next scan re-adds it; readable rows keep their TrackIds; a failed repair is reported and the app still opens | library-recovery (6), repository unit test, E2E "damaged library database" (tamper the real file, relaunch with the real launch policy) |
| 2 | Playback position lost when the window is closed while playing (up to the 5 s checkpoint) (ui store, main) | Real-Electron spec: closed at 3.8 s, restored at 0.14 s on the unmodified build | Medium (data loss) | Confirmed | `flushPosition()` on `pagehide` (not while a restored position is still pending) | store tests (3), provider test, E2E |
| 3 | Even with (2), `app.quit()` (tray Quit, OS) closed the database BEFORE the window sent its last save (main shutdown order) | Second E2E failed after fix 2 | Medium | Confirmed | `cleanup()` closes the windows (bounded) before stopping the application layer and closing the database | E2E `app.quit()` spec (mutation-caught) |
| 4 | Second/third quit request slips past the cleanup and can end the process mid-cleanup (main `before-quit`) | Code trace (`services === undefined` → return) | Medium | Confirmed by code | `createShutdownCoordinator`: every request held until the one cleanup finishes, bounded to 10 s | `lifecycle.test.ts` (unit), E2E multi-quit (see mutation note) |
| 5 | Uncaught exception / unhandled rejection / startup failure after the DB is open: Electron's default is to carry on in an unknown state; a half-started app kept the DB open (main) | Code trace | Medium | Confirmed by code; E2E now proves the new behaviour | `createFatalErrorHandler` + `installProcessErrorPolicy` wired: log, close library, tell the user, exit 1; `startApplication` failure routed to it; `loadURL/loadFile` rejections now caught (they would otherwise become fatal) | E2E (3 specs: exception, rejection, startup failure incl. "closed BEFORE the dialog") + lifecycle unit tests |
| 6 | TOCTOU between media authorization and open; a FIFO swapped in hangs the open; directory/pipe handling (media serving) | `media-hardening.test.ts` failing (8), real symlinks/FIFOs | Medium–High (local attacker with write access inside a library folder) | Confirmed | `openAuthorizedFile`: `O_NOFOLLOW` + `O_NONBLOCK`, regular-file check on the open handle, then the authorized path must still resolve to itself AND be the same device/inode as the open file; wired into `serveMediaFile` (`verifyStable` for library tracks) | media-hardening (9), verified-open (3, incl. swapped-and-swapped-back directory), all mutation-caught |
| 7 | Lyrics sidecar a FIFO blocks the lookup for ever; a link swapped in after the real-path check is followed (`readFileBounded`) | Failing test | Medium | Confirmed | `O_NONBLOCK`+`O_NOFOLLOW`, regular-file check | fs-readers (4), media-hardening |
| 8 | An unexpected fault while authorizing/serving a media request rejects the protocol handler (media protocol) | Failing tests | Medium | Confirmed | `handleNovaMediaRequest` contains it: bare 500, `no-store`, `internal-error`, detail only to `onError` (logged in main); a throwing sink is ignored | media-hardening (2) |
| 9 | `removeRoot` while the watcher is reconciling that root leaves orphan tracks (cannot be played or removed) (library application) | `library-application-hardening.test.ts` failing (2) | Medium (corruption) | Confirmed | Stop the watcher (and await its in-flight scan) first, delete in one transaction, restore the watcher over the remaining roots even if the delete fails; refuse if a manual scan started meanwhile | hardening tests (5) |
| 10 | Watcher start/stop interleaving (a root added while another caller starts the watcher) leaks a second running watcher (library application) | New deterministic test fails on the unmodified code (duplicate watch handles left open) | Medium (resource leak, duplicate scans) | Confirmed | All watcher operations run through one serial queue; no start after `dispose` | watcher-lifecycle (4) |
| 11 | `shell.openExternal(anyUrl)` for every `window.open`; no navigation lock; no permission handler; Phase 0 IPC channels had no sender check/validation and `diagnostics:getSeekSpikeMediaUrl` returned a source-checkout path in a packaged app; the trusted-sender check accepted any frame of our windows regardless of page (Electron window/IPC) | Code trace; E2E (a second window with our preload and another page is refused only after the fix) | Medium (defence in depth: the renderer is first-party code) | Confirmed | `applyWindowPolicy` wired (http/https only, no credentials; navigation, redirects and `<webview>` blocked); permission requests/checks refused; `isTrustedSenderFacts` also requires the sender frame to be the application page; diagnostics channels validated + trusted-sender checked and the spike channel disabled when packaged; CSP gained `object-src/base-uri/form-action 'none'`; `render-process-gone` is logged | window-policy/app-location/diagnostics/trusted-sender unit tests; 5 real-Electron specs; CSP boundary test |
| 12 | `library-shell` E2E "scan progress and cancellation" asserted "N tracks" although a cancel that lands during discovery legitimately leaves 0 saved (test) | Failed 1 in 4 on the untouched build; passes 6/6 after | Low (test timing, not an app defect) | Confirmed | Assertion accepts the bare "Tracks" heading as well; intent unchanged. This is the ONLY pre-existing test edited | — |
| 13 | Corrupt `position_ms` (not a safe integer) made the whole saved session unreadable (session repository) | Trace + test | Low | Confirmed | Position falls back to 0; queue kept | session repository test |

### Audited and found correct (left unchanged)
Byte-range parsing and 416/206/200 rules; file handles/descriptors after cancel, EOF, HEAD, 416, empty file and refused opens (new `/proc/self/fd` test: no descriptor outlives a request); path containment and root-swap checks in `MediaAccess`; preload surface (still exactly `invoke`+`subscribe`, allowlists); `contextIsolation`/`nodeIntegration:false`/`sandbox:true`; request validation and DTO field-by-field mapping; scanner cancellation/transactions (a cancel keeps whole batches); folder watcher (timers, idempotent stop); migrations (none added; migration 4 is still the latest); queue-is-a-snapshot and Phase 4 queue semantics (no change); duplicate event listeners (one subscription per bridge/shell; store `connect()` is reference counted).

### Architecture decisions
No new dependency, no schema change, no new IPC channel or preload surface, no change to the queue/playback ownership. New Electron-free, unit-tested modules: `main/lifecycle.ts`, `main/ipc/trusted-sender.ts`, `main/shell/{window-policy,app-location}.ts`, `main/ipc/register-diagnostics-ipc.ts`, `media/verified-open.ts`. Policy (also at the top of `lifecycle.ts`): recoverable failures are contained and logged where they happen; an uncaught exception, unhandled rejection or startup failure is fatal (library closed, user told, exit 1, never "carry on"); every quit waits for one bounded cleanup. A test-only env hook `NOVA_E2E_FAIL_STARTUP=1` was added (like `NOVA_STARTUP_SYNC`).

### Changed / added files (relative to the supplied archive)
Changed: `main/index.ts`, `main/shell/electron-shell.ts`, `renderer/index.html`, `renderer-boundary.test.ts`, `application/library-application.ts` (+ its hardening test extended), `composition/{index,library-services}.ts`, `infrastructure/src/index.ts`, `media/{fs-readers,handle-media-request,serve-media-file}.ts`, `repositories/sqlite-{track-repository,playback-session-repository}.ts` (+ tests extended), `ui/playback/{PlaybackStoreProvider.tsx,playback-store.ts,playback-store.test.ts}`, `tests/e2e/library-shell.spec.ts` (finding 12). Added: `ipc/trusted-sender{,.test}.ts`, `application/library-application-watcher-lifecycle.test.ts`, `media/{fs-readers,media-handle-cleanup,verified-open}.test.ts`, `PlaybackStoreProvider.test.tsx`, `tests/e2e/hardening.spec.ts` (12 specs). Removed from the archive: `node_modules`, build output, `test-results/`. Unchanged: migrations, the preload, the shared IPC contract.

### Mutation checks (31 mutants; each applied, tested, reverted; tree re-verified: typecheck, lint, full Vitest)
28 caught at first or after closing gaps; 3 survive and are explained: (a) `readFileBounded` regular-file check removed — equivalent in practice (a directory fails to read, a FIFO is non-blocking; kept as defence); (b) `dispose()` not awaiting the watcher queue — equivalent, a queued start is also stopped by the `disposed` guard; (c) bypassing the shutdown coordinator in `before-quit` is NOT caught by real-Electron specs (the cleanup still finishes before the process dies in this environment); that logic is covered by `lifecycle.test.ts`, not by an end-to-end proof. Gaps found by the first round and closed with new tests: link at the last component by itself, directory swapped and swapped back, a scan starting while the watcher is stopped.

### Validation (see the final block for exact numbers)
```
Working tree (final): typecheck 0 errors · lint 0 errors/0 warnings (--max-warnings 0) · build OK
Vitest: 2112 passed | 3 skipped (2115), 86 files, 0 failed — domain 378 · infrastructure 884 (+3 skipped) · desktop 550 · ui 300
        (+162 passed vs the documented Phase 7 baseline of 1950; the 3 skipped are the same non-root POSIX chmod tests.)
E2E (real Electron, Xvfb): 87/87 — 75 Phase 0-7 specs + 12 in hardening.spec.ts. Baseline was 74/75 (one flaky test, finding 12).
Repeated runs (working tree): hardening.spec.ts x5 = 60/60; the de-flaked library-shell cancel test x6 = 6/6.
Mutation checks: 31 mutants, 28 caught, 3 survivors explained above (none unexplained).
Fresh-extraction validation: the candidate ZIP was extracted into a clean directory (extraction diffed identical to the source tree it was built from),
  `pnpm install --frozen-lockfile`, Electron binary fetched with `install-electron`, then typecheck 0 errors · lint 0 warnings · build OK ·
  Vitest 2112 passed | 3 skipped (86 files, per-project counts as above) · full E2E 87/87.
  NOT re-run in the fresh copy (working tree only): the repeated-run checks and the mutation checks.
  The final ZIP differs from the validated candidate only in this status document (this block replaced a placeholder, and one tool-version phrase); verified by diff.
Not verified: real Windows, installer/signing, audible output, a displayed notification, a real OS folder dialog.
```

### Unresolved risks / limitations (not claimed solved)
- **Windows is unverified**: `O_NOFOLLOW`/`O_NONBLOCK` do not exist there (flags are 0), so on Windows the post-open path/identity comparison is the only check, and NTFS junction/reparse behaviour, file-index semantics (`ino`) and removable-drive behaviour were never tested. The symlink/FIFO tests are POSIX-only and skip on Windows.
- A hard link or bind mount created inside a library folder by someone with write access there is not detected (it reads no more than the original).
- Lyrics/artwork: the real-path containment check still has a gap for an INTERMEDIATE directory swapped between the check and the read (only the last component is `O_NOFOLLOW`); artwork is opened by `music-metadata` by path. Impact is limited to returning parsed lyric lines / an embedded picture of another local file.
- The renderer's last position save on `pagehide` is best effort (a hard kill, power loss or crash can still lose up to ~5 s). Only a graceful close/quit is covered.
- A crashed renderer is logged but not reloaded; the window stays blank until closed.
- Scan/watcher DTOs still carry paths of files inside user-chosen library folders and raw watcher error text (display purpose, not a privilege boundary).
- Two pre-existing environment skips remain (non-root POSIX chmod tests; sandbox runs as root); no real notification, audible output, Windows, installer or OS folder-dialog verification.
- `idField` in validation checks only length 36, not UUID shape (harmless: lookups then miss).
- No `.git`: no commit or hash exists for Phase 8.

**Next was: Phase 9 — Release / Documentation** (now done, see the Phase 9 section).

---

## PHASE 9 — RELEASE / DOCUMENTATION (COMPLETE — GREEN WITH CAVEATS)

**Verdict: GREEN WITH CAVEATS.** Documentation is complete and a Windows NSIS installer was built, but the installer was **never installed or run on real Windows** and is **unsigned**. Nothing below claims otherwise. Phase 8 results quoted elsewhere in this file were **not** re-run as Phase 8 evidence; everything in the "Phase 9 evidence" block below was run fresh in Phase 9 (Linux sandbox, Node 22.22.0, pnpm 12.6.0, Xvfb).

### Audit of the Phase 8 packaging configuration (before any change)
- Identity/version: `appId com.novaplayer.desktop`, `productName Nova Player` in `electron-builder.yml`, but `apps/desktop/package.json` was `0.0.0` with no description/author, **no `productName`**, and no installer script. No README existed.
- `electron-builder --dir` (the documented `build:unpack`) **had never been run**. Running it failed immediately: electron-builder tried to **rebuild better-sqlite3** with node-gyp (needs Electron headers from electronjs.org and a C++ toolchain; blocked here, and MSVC would be required on Windows). better-sqlite3 13 already ships `prebuilds/win32-x64.node` etc. and sets `gypfile: false`, so the rebuild is unnecessary.
- First successful unpacked build: `app.asar` contained 1210 entries including **717 files under `node_modules/@nova/*`** (pnpm lists the workspace packages as dependencies) with **compiled `*.test.js` files and source maps**, plus copies of react/react-dom/zustand/@tanstack that Vite had already bundled. Nothing there is used at runtime (`out/main` imports only electron, better-sqlite3, music-metadata and node built-ins; the preload only `electron`).
- The packaged app's name was **`@nova/desktop`** (Electron reads `productName || name` from the asar's package.json), so user data would have been created in `%APPDATA%\@nova\desktop`.
- A trailing comment in `electron-builder.yml` wrongly said `electron-updater` is a dependency (it is not).
- With no `publish` setting, the NSIS build **wrote the installer and then crashed** ("Cannot read properties of null (reading 'provider')") while generating update info.
- Audited and found fine: icons (`resources/icon.png` 256 px, `tray.png` 32 px) ship via `extraResources` and `resourcePath()` reads `process.resourcesPath` when packaged; `asarUnpack` for better-sqlite3 present; shortcuts/install-dir options present; no secrets or local paths in the asar (checked: no `/home/claude` string, no `.env/.pem/.pfx`).

### Changes (relative to the supplied Phase 8 ZIP)
| File | Change |
|---|---|
| `apps/desktop/electron-builder.yml` | `npmRebuild: false`; `files` exclusions (`@nova/**`, react, react-dom, scheduler, zustand, @tanstack, better-sqlite3 `deps/**` + `src/**`, `**/*.map`); `publish: null`; explicit `nsis.deleteAppDataOnUninstall: false`; corrected the `electron-updater` comment. `asarUnpack`, icons, signing (env-gated, unchanged) untouched. |
| `apps/desktop/package.json` | `version 0.9.0`, `productName "Nova Player"`, `description`, `author`, script `dist:win`. No dependency change (lockfile untouched; `pnpm install --frozen-lockfile` still succeeds). |
| `README.md` (new) | User documentation. |
| `RELEASING.md` (new) | Toolchain, commands, packaging (Windows and Linux/Wine), signing without secrets, validation levels, manual Windows checklist. |
| `playwright.packaged.config.ts`, `tests/packaged/packaged-smoke.spec.ts` (new) | Separate packaged-app smoke test (3 tests); **not** part of the default `playwright test` run. |
| `NOVA_REBUILD_STATUS.md` | This update. |

No application source, no migration (migration 4 is still the latest), no IPC surface, no dependency and **no existing test** was changed. The new smoke test imports helper functions from `tests/e2e/` but does not modify them. Phase 8 hardening is untouched. Product decision: the app version is `0.9.0` (a release candidate), the root workspace package stays private `0.0.0`. Side effect: a development profile created by `electron-vite dev` now lives under the product name (`Nova Player`) instead of `@nova/desktop`; there was never a packaged build, and E2E uses `--user-data-dir`.

### The packaged-app smoke test (`tests/packaged/packaged-smoke.spec.ts`)
Launches the **unpacked Linux build** with no `NOVA_*` test hooks. (1) `app.isPackaged`, `getAppPath()` ends in `app.asar`, name is `Nova Player`, version equals `package.json`, `icon.png`/`tray.png`/`app.asar` and the unpacked better-sqlite3 prebuilds exist in `process.resourcesPath`, the page loads (title, heading, empty library) from an `app.asar` URL (so the trusted-sender / app-URL comparison works inside the asar). (2) Adds a real folder through the UI, scans, plays a track over `nova-media://track/…` (clock advances), restarts, and finds the library again. (3) Static scan of the asar: no `*.test.js`, `*.spec.js`, `*.map`, `.env/.pem/.pfx`, no `/home/claude` or home-directory strings.
Mutation checks (applied, tested, reverted; config restored and verified): **(a)** removing the `@nova` exclusion → test 3 **failed** (caught). **(b)** removing `asarUnpack` → all 3 tests still passed (**survived**): electron-builder auto-unpacks `.node` addons, so the explicit `asarUnpack` is redundant but harmless; it was kept (vendor-recommended, documents intent) and the survivor is recorded rather than hidden.

### Installer build (what actually happened)
1. NSIS cross-build on Linux first failed: `spawn wine ENOENT` — electron-builder produces the NSIS uninstaller by running a 32-bit Windows program. `apt-get install wine` initially "could not locate" the package until `apt-get update`; 64-bit-only Wine then failed (`failed to load syswow64 ntdll`); after `dpkg --add-architecture i386` + `wine32:i386` and a **fresh Wine prefix** the build succeeded. Those installs changed the sandbox only, not the repository.
2. `xvfb-run -a pnpm --filter @nova/desktop run dist:win` → **exit 0**: `apps/desktop/dist-installer/Nova Player Setup 0.9.0.exe`, **117,455,885 bytes**, SHA-256 `ee11ea5bfe3c06043ffa57c10bffa56f3a858b5561549a333931dba8d5aa3450`, plus `.blockmap` and `win-unpacked/`. (Not byte-reproducible; the hash is of that one build. **The installer is not in the ZIP** — build output is excluded; rebuild with `dist:win`.)
3. Static inspection of that file: PE32 NSIS-3 Unicode installer; **no Authenticode signature** (security directory size 0 for both the installer and `Nova Player.exe`); `Nova Player.exe` carries the product name and version 0.9.0 resources; the installer contains `Uninstall Nova Player.exe` and the 7z app payload (108 files; `app.asar` 2,067,123 bytes; unpacked better-sqlite3 present; `win-unpacked/.../prebuilds/` has all 8 prebuilds including `win32-x64.node`).
4. **Under Wine (not Windows):** `win-unpacked/Nova Player.exe` started, printed "DevTools listening", and created `%APPDATA%\Nova Player\library\nova.db`; with `--user-data-dir` a copy showed all four migrations applied (`initial-schema`, `scan-state-and-path-key`, `library-roots`, `playback-session`). That shows the **win32-x64 better-sqlite3 binary loads from `app.asar.unpacked` and the database opens** on a Windows API layer, and confirms the `Nova Player` data folder name. The window itself was not inspected (the DevTools HTTP endpoint did not answer under Wine), no audio, no UI interaction.
5. **Silent install under Wine was attempted and did not complete** (exit 2): the installer's "is the app running" check calls PowerShell, which Wine only stubs. This is inconclusive about the installer, **not** a pass.

### Phase 9 evidence (all run fresh in Phase 9)
```
Fresh extraction of the Phase 8 ZIP (baseline, before any change):
  pnpm install --frozen-lockfile ............ OK        npx install-electron ................ OK
  pnpm typecheck (tsc -b) ................... 0 errors   pnpm exec eslint . --max-warnings 0 . 0 errors / 0 warnings
  pnpm build ................................ OK         pnpm exec vitest run ................ 86 files, 2112 passed | 3 skipped (2115)
  xvfb-run -a pnpm exec playwright test ..... 87 passed (2.6 min)
Final working tree (after all Phase 9 changes, same commands):
  typecheck 0 errors · lint 0 errors/0 warnings · build OK · Vitest 86 files, 2112 passed | 3 skipped (2115) · E2E 87 passed (2.6 min)
Packaging:
  pnpm --filter @nova/desktop run build:unpack ........ OK (Linux unpacked; asar 2.0 MB, 282 entries, 0 test/map files; unpacked better-sqlite3 17 MB)
  xvfb-run -a pnpm exec playwright test -c playwright.packaged.config.ts ... 3 passed
  xvfb-run -a pnpm --filter @nova/desktop run dist:win ........... exit 0 (Wine), installer as above
```
(The 3 skipped Vitest tests are the same three non-root-POSIX chmod tests as before.)
ZIP integrity and the fresh-extraction re-run of the final archive are recorded below in "Final archive".

### Categorised results
| Item | Category |
|---|---|
| Archive integrity, fresh extraction, frozen install, typecheck, strict lint, build, Vitest, E2E (87) | **Passed** |
| Unpacked electron-builder build (Linux) and packaged-app smoke test (3) | **Passed** |
| NSIS installer build (Wine, unsigned) | **Passed (built)** |
| Installer static inspection (PE, metadata, payload, no signature) | **Passed** |
| Windows build starts, opens/migrates SQLite under Wine | **Passed under Wine only — not evidence for real Windows** |
| Silent install under Wine | **Blocked** (Wine PowerShell stub) — inconclusive |
| Install, shortcuts, launch, uninstall on real Windows; audible playback; toast; tray; media keys; SmartScreen behaviour; install over an existing install | **Requires real Windows validation / Not tested** |
| Code signing | **Not configured** |
| Auto-update | **Not implemented** (documented) |
| macOS / Linux / Windows-ARM | **Not supported** (documented) |

### Remaining risks
- Installer never installed/run on real Windows: shortcuts, per-user vs all-users choice, UAC, uninstall behaviour (`deleteAppDataOnUninstall: false` is configured, not observed), reinstall-over-existing, running-app detection.
- Unsigned: SmartScreen warning; some antivirus products dislike unsigned NSIS installers.
- Audible output, notifications, tray, media keys and recursive file watching on Windows were never exercised on real Windows (see Phase 4–8 caveats, unchanged).
- The unpacked-app smoke test is Linux-only; it does not prove the Windows app behaves identically.
- Wine-built installer: valid file, but a Windows-native build is the supported release path.
- `RELEASING.md` instructions for building on Linux/Wine reflect what worked here (Ubuntu 24.04, Wine 9.0 + wine32).

### Next recommended action
Take the installer (rebuild with `dist:win` on Windows or Wine) to a real Windows 10/11 x64 machine, walk through the checklist in `RELEASING.md`, and record the results in this file. Only then can the release be described as verified on Windows. Decide separately whether to obtain a code-signing certificate.

### Final archive
`nova-player-repo-phase9-complete.zip` — 293 files (Phase 8 ZIP: 289; +4 new files, 2 modified, the status document updated; nothing removed, no Phase 0–8 file lost; verified by `diff -rq` against the Phase 8 extraction). Contains source, tests, lockfile, packaging config, resources and docs; contains **no** `node_modules`, `out/`, `dist*/`, `dist-installer/`, coverage, `test-results`, caches, `.git`, logs, `*.exe`, scratch or machine-specific files. The exact ZIP size is given in the hand-off report (it cannot be stored inside the archive it describes).
Validated from a **fresh extraction of the candidate ZIP**: `unzip -t` clean · `pnpm install --frozen-lockfile` OK · typecheck 0 errors · `eslint . --max-warnings 0` 0/0 · build OK · Vitest 86 files, 2112 passed | 3 skipped · E2E 87 passed · `build:unpack` OK + packaged smoke 3 passed · `dist:win` (Wine) exit 0 → `Nova Player Setup 0.9.0.exe`, 117,455,885 bytes, SHA-256 `7e0e00598f63fc5e05dfe64dd113a3a101ea8479fb28f92340f11571b645a050` (same size as the earlier build, different hash: builds are not byte-reproducible).
The final ZIP differs from that validated candidate only in this paragraph of this status document (verified by diff).

---

## VALIDATION SNAPSHOT

Run at the Phase 6 checkpoint **from a freshly extracted copy of the handoff ZIP** (Linux sandbox, Node 24, pnpm 12.6.0, `pnpm install --frozen-lockfile`, Electron binary fetched, E2E under xvfb).

```
Vitest (full suite):  1866 passed | 3 skipped (1869) across 65 files — 0 failed
                      per project: @nova/domain 378 · @nova/infrastructure 839 (+3 skipped) · @nova/desktop 358 · @nova/ui 291
                      (skipped: the two Phase 4 access-denied tests + the Phase 6 unreadable-sidecar chmod test; all need a non-root POSIX user.)
Typecheck (tsc -b):   0 errors
Lint:                 0 errors, 0 warnings (--max-warnings 0)
Desktop build:        succeeds (main, preload, renderer), no bundler warnings
Playwright/Electron:  62/62 passing under xvfb — the 54 existing Phase 0–5 specs (unmodified) + 8 new Phase 6 specs
                      (nowplaying-lyrics.spec.ts); the Phase 6 spec also passed 3 consecutive extra runs (no flakes).
Mutation checks:      32 deliberate breaks of Phase 6 behavior — all caught, all reverted, tree re-verified afterwards.
Boundary/security:    renderer-boundary.test.ts (the domain exception is exactly lyric-sync.ts / two names), shared
                      contracts path-free (browse + track-detail), sidecars contained to the track's root (symlink out is
                      ignored, E2E + unit), removed/unavailable roots stop access, only the metadata adapter imports
                      music-metadata, no new dependency.
Not verified:         audible output; real Windows; installer/signing; a real OS folder dialog.
Phase 6 snapshot above; the Phase 7 snapshot is in the Phase 7 section; the Phase 9 evidence block (Vitest 2112 | 3 skipped, E2E 87, packaged smoke 3, NSIS build) is in the Phase 9 section.
```

No Git commit exists for Phase 2, 3, 4, 5, 6 or 7 (see "Git state" at the top of this file).

---

*Updated at the Phase 9 (complete, green with caveats) checkpoint. If this file and the repository ever disagree, trust the repository and update this file.*

---

## Phase 10 — UI redesign: theming, lyrics, attach a .lrc (v0.10.0)

**Why.** The user showed their earlier vanilla-JS "Nova Player Desktop" (glass dark/light UI, dynamic album-art
theming, Apple-style lyrics) and asked for the rebuild to look and behave like it. Scope chosen by the user:
look + theming + lyrics (no favourites / playlists / recently played / visualizer), and lyrics may also be attached
from a chosen `.lrc` file. The engine (library, queue, playback, hardened IPC, installer) is unchanged.

**Deliberate changes to earlier rules (not silent).**
- Phase 9's "no new IPC / no migrations / no new dependencies" no longer applied: the user asked for the feature.
  Added **migration 5** (`attached_lyrics`, FK `ON DELETE CASCADE` to `tracks`), repository, and IPC channels
  `track:attachLyrics` and `track:detachLyrics`. **No new npm dependency** (palette extraction, tween, icons and
  generated covers are own code; fonts are the old app's woff2 files, bundled by Vite and loaded from the app itself).
- Pinned lists updated on purpose: the IPC channel list (18 -> 20), the library-services key list, the Electron-runtime
  `SOURCES` list (`attached-lyrics-schema`), and the E2E migration check (`v: 4` -> `v: 5`).
- `renderer-boundary.test.ts` was **narrowed, not removed**: (a) `localStorage` is allowed in exactly one file,
  `packages/ui/src/theme/theme-store.ts` (appearance choices only; guarded; no library data), (b) `.src =` is allowed
  additionally in `packages/ui/src/theme/palette.ts` (off-screen `Image` decoding a data: URL main sent; never the
  audio element). The no-`.sort(` rule was kept: the palette code avoids `.sort`.
- The 4-second "user scrolled" grace in the lyrics panel was replaced by the old app's behaviour: scrolling by hand
  detaches the view, a **Jump to now** button appears, and following never resumes by itself (only the button, or the
  next track). The existing test ("not yanked away after a wheel scroll") still passes unchanged.
- Now Playing lyrics column height: `min(520px, ...)` -> `max(320px, calc(100vh - 230px))` so a tall window still
  gives the extra height to the lyrics (the existing window-size E2E asserts this).

**What was built.**
- Backend: attach reads the file in main (file dialog in main; the renderer never sees a path), strict UTF-8 with a
  windows-1252 fallback, 1 MiB limit, refuses files with no timed lines, stores the text in SQLite; attached lyrics win
  over a sidecar; detach restores the sidecar. Outcomes: `attached | cancelled | empty | unreadable | too-large | unavailable`.
- Theme: CSS custom-property tokens (`theme.css`), dark/light, five swatches + custom colour + **Album art** (dynamic:
  own hue-bucket palette extractor on a 48x48 canvas, `clampVivid`, ~0.9 s eased tween, per-cover cache), lyric size,
  reduce-motion. Choices persist in `localStorage` (guarded; works with storage blocked).
- Shell: glass sidebar (icons, counts, library folders / scan / watcher as compact cards), topbar with view title and
  search, player dock; views Tracks / Albums / Artists / Genres / Queue / Now Playing (vinyl, spins only while playing) /
  **Lyrics** / **Settings**; generated SVG covers when a track has no artwork. All previous test ids and accessible names kept
  (new: `nav-lyrics`, `nav-settings`, `view-title`, `lyrics-jump`, `lyrics-actions`, `lyrics-attached-note`, ...).

**Validation actually run (Linux, this environment).**

| Check | Result |
|---|---|
| `pnpm typecheck` | clean |
| `eslint . --max-warnings 0` | clean |
| `pnpm test` (all Vitest projects) | 90 files, **2192 passed, 3 skipped**, 0 failed |
| Playwright E2E against real Electron (Xvfb) | **93 passed** (6 new in `theme-lyrics.spec.ts`) |
| Packaged (unpacked, asar) smoke | 3 passed |
| NSIS installer cross-built with Wine | `Nova Player Setup 0.10.0.exe`, 117,626,220 bytes, SHA-256 `39da180574b763549bfb33bfac117a65d819c768b397e74b80ca9a81452e6073`; PE certificate table size 0 = **unsigned** |
| Screenshots of the new UI (real Electron, dark and light, with an embedded cover and a `.lrc`) | taken and reviewed by eye; compared with the old app's look |

New unit tests: palette maths, theme store (persistence, corrupt/blocked storage, clamping), `ThemeController`,
past/current/future lyric states, jump-to-now (never auto-resumes), attach / replace / remove / every refusal message /
stale answer after a track change.

**Caveats (honest).**
- The installer was **never installed or run on real Windows**; unsigned (SmartScreen warning). The manual checklist in
  RELEASING.md has new lines for theming, lyrics and fonts.
- Fidelity to the old app is by design intent and by eye on Linux screenshots only; fonts, blur (`backdrop-filter`) and
  display scaling are unverified on Windows. Audible output is still not verified by a person.
- Not ported (out of the chosen scope): favourites, playlists, recently played, visualizer, drag-and-drop of files, 
  generative-cover choice per album, the old app's animation library (GSAP; replaced by CSS and a small tween).
- The library-folder cards live in the sidebar under the navigation (so every earlier test and flow keeps working);
  the old app had a separate settings page for them.
- A `.lrc` attached to a track is keyed by track id: if the file is moved or renamed the app treats it as a new track
  (existing limitation), so the attachment is dropped with the old track record.
- Dynamic accents from a cover are computed in the page from the cover data main already sends; a cover that is grey or
  fully transparent falls back to the default blue accents.

## Phase 11 — "Nova Player 2": UI rebuilt from scratch on the tested engine (v0.11.0)

**Why:** the v0.10.0 UI missed the brief (thumbnails not showing, awkward clicking, few options, no spectrum, weak
theming, no wallpaper, tofu boxes for Urdu/Hindi titles, clipped queue, translucent dock). Decision (user): keep the
tested engine (domain, infrastructure, IPC, playback rules) and rebuild the **entire renderer UI** with a new design
system (`nx-` classes in `apps/desktop/src/renderer/src/theme/theme.css`).

**Backend additions (main + shared contract):**
- Migration **6**: `favorites`, `play_history`, `playlists`, `playlist_entries`.
- **18 new IPC channels** (all validated in `apps/desktop/src/main/ipc/collections-validation.ts`, sender-checked):
  `favorites:list|ids|set`, `history:list|clear`, `playlists:list|create|rename|delete|get|addTracks|removeEntries|moveEntry`,
  `playback:playList`, `track:getThumbnail`, `wallpaper:get|choose|clear`. `IPC_INVOKE_CHANNELS` pinned lists updated
  accordingly. `playback:enqueue` now takes exactly one of `trackId | group | source`; `PlaybackContext` accepts `kind:'list'`.
- Thumbnails: main-side resizer (Electron `nativeImage`) + cache; the renderer never sees a path.
- `nova-media://` responses now carry CORS headers and the protocol is `corsEnabled`, which Web Audio
  (`createMediaElementSource`) needs for the spectrum/equalizer; the `<audio>` element sets `crossOrigin='anonymous'`
  **before** any `src` (`apps/desktop/src/renderer/src/main.tsx`).
- Wallpaper: PNG/JPEG only, <= 12 MiB, >= 800x450, <= 10,000 px a side, stored as a <= 1920x1080 JPEG in
  `<userData>/wallpaper/wallpaper.jpg`, delivered as a data URL. Header sniffing is in `image-header.ts`.

**Renderer (packages/ui/src):** `app/` (shell, dock, sidebar, topbar, queue drawer, Now Playing, Lyrics, overlays, views),
`audio/` (10-band EQ + presets, analyser, beat detector, speed + sleep timer controls), `visuals/` (one shared animation
loop, frame governor / performance modes, spectrum canvases, particle field), `collections/`, `media/` (thumbnail cache,
wallpaper store), `prefs/`. Old UI components and their tests were removed (LibraryShell, PlayerBar, NowPlayingView,
LyricsPanel, QueuePanel, GroupBrowser, etc.).

**Deliberate changes to existing tests (not silent weakening):**
- `renderer-boundary.test.ts`: `prefs-store.ts` joins `theme-store.ts` as the only other file allowed `localStorage`
  (display preferences only); the single `useVirtualizer` call site is now `app/TrackList.tsx` (was `library/VirtualRows.tsx`);
  the "no list component reads the position store" rule now names the new components; the sanity check names `app/Dock.tsx`.
  To satisfy the existing "no shuffle logic / no `Math.random` / no `.sort(` / no `.splice(` in the renderer" rules the new
  code was changed (seeded jitter for particles, index arrays built without sorting, `copyWithin` in the thumbnail queue) - the rules themselves are unchanged.
- `register-playback-ipc.test.ts`: two channels moved to the collections registrar (`COLLECTIONS_OWNED`); count unchanged (20).
- `theme-store`: lyric size default 26 -> 34 and range 18-40 -> 22-52 (Apple-style big lyrics); its test updated.
- E2E: `library-shell`, `library-browse`, `library-queue`, `nowplaying-lyrics`, `theme-lyrics` specs tested the removed UI and
  were **retired**; their behaviours are covered by the new `nova2.spec.ts` (queue, search, sorting, groups, lyrics, EQ/speed,
  wallpaper, dynamic theming, favourites/playlists) plus the unit/component tests. `desktop-shell`, `hardening`,
  `library-startup`, `playback` were **ported** to the new UI (same assertions, new selectors; the scan/watcher status
  labels that no longer exist are checked through main's `library:getScanState` and the Settings switch). `library-fixture.ts` helpers were rewritten.

**Real bugs found by the e2e while porting (fixed):** the volume slider stretched/shrank the player bar at 1200 px and
covered the play button; repeat/shuffle were disabled until a song loaded; playback errors had no persistent, dismissible
surface (now an alert strip with Try again / Dismiss).

**Validation (Linux, this container):** `tsc -b` clean; `eslint . --max-warnings 0` clean; Vitest all projects pass
(2316 passed, 3 skipped); Playwright against real Electron under Xvfb: **74 passed**. The spectrum is proven to read real
analyser data (`data-live="true"`; the 440 Hz test tone shows as a peak in screenshots).

**Not verified (be honest):** audible output (no sound device); the installer has **not** been run on real Windows and is
**unsigned**; Web Audio/Spectrum behaviour on real Windows audio devices; performance on low-end hardware (the Performance
setting and frame governor exist but were not benchmarked on slow machines).

## Phase 12 — first real-Windows feedback batch (v0.11.1)

The user installed 0.11.0 on a real Windows PC and reported the first batch. Changes:
- **Layout bugs (root causes):** sidebar and Home pages were flex columns whose children could shrink, so the sidebar footer
  overlapped "PLAYLISTS" and Home sections squashed into each other (tiles overlapping). Children are now `flex: none` and the
  playlist list scrolls. `scrollbar-width: thin` on `.nx-shelf` overrode the styled `::-webkit-scrollbar` (white native bar): removed;
  scrollbars are now thin accent-tinted pills. Collapsed sidebar: uniform 44 px icon buttons, icon-only footer actions, tooltips.
- **Interaction:** a single click on a song row plays it (Ctrl/Shift-click still select; heart/⋯ unaffected; double-click handler removed).
  The player bar is tinted from the cover accent and clicking its empty area opens Now Playing. The "using the .lrc you attached / remove"
  control is now a tiny badge on the cover (`LyricsBadge`).
- **Tooltips:** one delegated `Tooltips` layer shows the name (+ shortcut via `data-keys`) of every icon-only control on hover/keyboard focus.
- **Window:** native menu removed (`Menu.setApplicationMenu(null)`, `removeMenu`, `autoHideMenuBar`). Fullscreen on double-click of empty
  space and F / F11 uses the page's Fullscreen API; this needed ONE permission exception: `fullscreen` is now granted to our own page only
  (all other permission requests are still refused; the hardening e2e for notifications/geolocation still passes). The pointer hides after 2.5 s
  idle in Now Playing or fullscreen. Windows taskbar thumbnail buttons Previous / Play-Pause / Next (`thumbar.ts`, `thumb-*.png`) go through the
  existing shell-command path; Windows-only and **not verifiable on Linux**.
- **Keyboard:** `shortcuts.ts` (pure, unit-tested) adds seek (←/→, Shift = 15 s), volume (↑/↓), 0–9 jump, N/P, S, R, H (favourite), Q, F, [ ], Ctrl+, / ?;
  the Settings list is generated from the same table.
- **CI test fixed:** `library-application-hardening.test.ts` "keeps watching the REMAINING folders…" asserted the order of watched roots, which is
  storage-defined and differed on GitHub's Linux runner; it now compares as sets (same intent: which folders are watched/closed, and that a failed removal starts nothing new).
- New e2e (nova2.spec.ts): row click plays, dock click expands, no menu, tooltips, sidebar/Home no-overlap geometry (incl. collapsed + short window),
  shortcuts, fullscreen + idle cursor.
