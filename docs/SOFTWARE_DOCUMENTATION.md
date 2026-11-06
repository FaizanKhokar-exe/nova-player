# Nova Player 2 — Software Documentation

Version 0.15.0 · for the owner / future contributors · written so we can sit down and decide **what to build next**.

> Honesty box: the app has been built and tested on **Linux (automated tests, a virtual display, synthetic audio)**. It has **not been run on a real Windows machine by a person**, the installer is **unsigned**, and **timing/beat quality on real music has never been measured** — only on synthetic signals. Sections marked ⚠ say where that matters.

---

## 1. What the product is

A local-first Windows desktop music player: you add folders, it builds a library, plays music, shows synced lyrics, draws live visuals, and (new) helps you **create** lyric timing yourself (Lyric Studio). Nothing leaves the computer except two optional things: lyrics search (lrclib.net, asks consent first). No accounts, no telemetry.

Design goals: premium look (Spotify layout + Apple-Music lyrics + Lark-style lyric mode), never freeze on big libraries, never modify the user's music, keyboard-first.

## 2. Feature inventory

| Area | What exists |
|---|---|
| Library | Add/remove folders, read-only scan, tag reading, watch for changes, rescan at launch, virtualized lists, Songs/Albums/Artists/Genres |
| Collections | Favorites (heart), Recently played, Playlists (create/rename/delete/add/reorder by drag) |
| Search | Ctrl+K over songs/albums/artists |
| Playback | Play/pause, next/prev, seek, volume, repeat (off/all/one), shuffle, speed 0.5–2× (pitch kept), sleep timer (minutes / end of track) with optional gentle fade, track-to-track fade |
| Audio | 10-band EQ + 10 presets, automatic headroom (preamp), master fade node |
| Queue | Drawer: played / now / next, drag + arrows, remove, clear |
| Lyrics | `.lrc` beside the song or attached; Now Playing panel; full-screen **Lyrics Mode** with beat-reactive particles/aurora; click a line to seek |
| Lyric styles | Animation Apple / Karaoke · sung lines Dim / Fade away / Hide · align left/center · case normal/UPPER/lower/Small-caps/Capitalize · font default/serif/rounded/mono · beat intensity Off/Subtle/Normal/Strong · depth blur |
| Lyric Studio | Find lyrics online (LRCLIB, consent) or paste; offline timing estimate; live editor (stamp with Enter, nudge, lock, audition, undo, shift all); "singing starts/ends here" markers; add / replace / remove lines; save `.lrc` next to the song (backup `.lrc.bak`) |
| Visuals | Spectrum bars/wave/ring from real audio, Visualizer layout, particles, performance modes Auto/High/Balanced/Low |
| Theme | Dark/light; colours from the playing cover; **Mood themes** Off / Tinted (default) / Immersive; wallpaper (PNG/JPEG ≤12 MB) with dim + blur |
| On-screen display (HUD) | Reactive volume pill (speaker waves follow level, glowing bar, number) and confirmations for play/pause, mute, shuffle, repeat, speed; respects Reduce motion |
| Song info | Edit title/artist/album (stored beside the library, file untouched): Tidy up, Find the right name (online), Reset |
| Equalizer | Also in the player bar (popover), same settings as Settings |
| RTL lyrics | Urdu/Arabic/Persian/Hebrew lines align and wipe right-to-left automatically |
| Shortcuts | Customizable keys for 12 actions; fixed: arrows, digits, F11, `?`, Ctrl combos |
| Desktop | Tray, media keys, notification on new track, remembered window, single instance, resume queue/position (paused) |

## 3. Architecture

```
apps/desktop            Electron shell
  src/main              main process: windows, tray, media keys, IPC registrars, lyrics provider wiring
  src/preload           narrow bridge: invoke(channel, payload) / subscribe(channel)
  src/renderer          Vite entry + theme.css (all styling)
packages/domain         pure rules: track identity, queue, shuffle, search, LRC parsing, sorting (no I/O)
packages/shared         typed IPC contracts (DTOs, channel list) — the only thing main and UI both import
packages/infrastructure SQLite (better-sqlite3) repositories + migrations, scanning, watching, metadata, media protocol, lyrics provider (LRCLIB), sidecar read/write
packages/ui             React 19 UI + zustand stores (playback, library, collections, prefs, theme, studio, ui)
tests/e2e               Playwright driving the real Electron app under xvfb
```

Rules enforced by tests (so they cannot rot):
- Renderer never touches the file system/Node; only the bridge. No paths in IPC DTOs (field-name test).
- **Renderer boundary test**: no LRC parsing words in UI code, no `.sort(`, `.splice(`, `localeCompare`, `Math.random`, `fetch(` in UI sources (one allowed file: `energy-profile.ts`). Sorting/parsing live in domain/main.
- `IPC_INVOKE_CHANNELS` is pinned by a test; every channel is validated in main before use.

### Audio graph
`<audio>` → 10 EQ filters → preamp gain → analyser → fade gain → destination. Visuals read the analyser; they never alter sound.

### Visual bus
One shared animation loop; beat analyzer turns FFT bins into `bass/mid/treble/level/beat/pulse`. Beat rule (v0.15): auto-gain (quiet tracks lifted up to ≈+18 dB, loud ones untouched) + bass kick + mid snare + **spectral flux** (broadband jumps, so bass-less phone-speaker mixes still pulse).

### Data
- SQLite `library/nova.db` in `%APPDATA%\Nova Player` (8 migrations: tracks, roots, scan state, playback session, collections, attached lyrics, custom media, track edits).
- `shell-state.json` window bounds.
- Preferences in the window's localStorage `nova.prefs.v1`; theme `nova.theme.v1`.
- Lyrics: sidecar `<song>.lrc` (user-visible), or inside the DB when the folder is not writable.

### IPC (≈60 channels, grouped)
`app:` · `diagnostics:` · `library:` (roots, scan, list, search, groups, watcher) · `playback:` (state, play, next/prev, repeat, shuffle, queue ops, playList) · `track:` (lyrics, artwork, thumbnail attach/detach, editInfo/resetInfo) · `lyrics:search`, `lyrics:save` · `favorites:` · `history:` · `playlists:` · `wallpaper:`.

## 4. Lyric Studio — how timing works (and its limits)

1. Audio is decoded offline to 16 kHz mono (+ side channel for stereo).
2. Voice band filter 250–3500 Hz; stereo **centre emphasis** (instruments only in the sides are turned down); level normalised both globally and over a ~10 s local window (so dense, loud songs still show dips between lines).
3. Onsets + phrases (hysteresis gate) are found.
4. Each line gets a weight from its syllables (script-aware; Roman Urdu supported). A Viterbi dynamic programme picks one start per line so each line's share of *voiced* time matches its weight, preferring starts on onsets / after pauses.
5. Lines you locked, or your **singing starts / ends** markers, constrain the solution. Found-online timing for another recording is shifted/stretched onto yours (calibration).
6. Starts snap to the nearest onset (with ≈120 ms tap-lag compensation when you stamp live).

⚠ **Limit:** this finds "loud in the voice band", not "a voice". On real songs with loud instruments the first estimate can be off; that is why every line has a confidence, low ones are flagged, and the markers + live stamping exist. Real accuracy needs either a vocal-separation model (large download) or more user hints. Measuring needs a set of real songs with hand-timed `.lrc` files — we have none yet.

## 5. Settings reference

Appearance: theme, colour source, **mood** · Wallpaper: enable, dim, blur · Playback: speed, EQ, track fade, gentle sleep timer · Lyrics: backdrop, depth blur, line animation, sung lines, align, case, font, beat intensity, online search consent · Performance mode · Shortcuts editor · Library folders.

## 6. Keyboard

Space play/pause · N/P next/previous · M mute · S shuffle · R repeat · H favorite · Q queue · L lyrics mode · F fullscreen · [ ] speed · ←/→ seek 5 s (Ctrl 15 s) · ↑/↓ volume · 0–9 jump to % · Ctrl+K search · Ctrl+, settings · Alt+←/→ back/forward · Esc close. Letter keys are re-mappable in Settings. In Lyric Studio: Enter stamp, ↑↓ select, ←→ nudge, A audition, L lock, Ctrl+Z undo.

## 7. Build, test, release

- Dev stack: Electron 44, React 19, TypeScript 6 (strict), electron-vite, Vitest, Playwright, electron-builder (NSIS), pnpm workspace.
- Checks: `pnpm exec tsc -b`, eslint, vitest per package, Playwright e2e (needs a rebuild of the renderer first, runs under `xvfb-run`).
- Windows installer: copy the project into the GitHub repo → Actions → **Windows installer** → artifact `Nova-Player-Setup` (unsigned; see RELEASING.md).

## 8. Privacy

Local only. Network: (1) lyrics search to `lrclib.net` (host-pinned, HTTPS, no redirects, 8 s timeout, 4 MiB cap) **only after consent**; nothing else. Window is sandboxed, context-isolated, CSP restricted. A future update check would be the second network use (planned, switchable).

## 9. Known gaps / honest list

1. Not verified on real Windows; unsigned (SmartScreen warning). 2. Audible output never confirmed by a human. 3. Lyric timing and beat quality only validated on synthetic signals. 4. No auto-update, no Help/FAQ/About, no first-run welcome. 5. No mood-from-music (energy/tempo) — mood comes from cover colours only. 6. Lyrics only from `.lrc`/online search, not embedded tags. 7. Single window, English UI only. 8. Moving/renaming a file makes a new track identity. 9. Closing the window quits (tray-hide is opt-in, no UI).

## 10. Options for the future (to discuss)

| Idea | Value | Effort | Notes |
|---|---|---|---|
| Help / FAQ / About / welcome | production feel | S | plan in `docs/NEXT_PHASE_PLAN.md` |
| Auto-update via GitHub Releases | everyone gets new versions | M | public repo; disclose network use; switchable |
| Licence + brand + donations (Ko-fi/Sponsors) | free earning path | S | supporter perks = cosmetic only |
| Measured timing quality | the biggest open risk | M | collect ~10 songs + hand-made LRC, score error in ms, tune |
| Vocal separation model (local, optional download) | much better timing | L | big download, CPU heavy |
| Word-by-word karaoke (enhanced LRC) | premium lyrics | M–L | needs per-word timing |
| Mood from music (energy/tempo → theme motion) | unique | M | uses existing energy profile |
| Gapless playback, crossfade between songs | polish | M | needs second audio element |
| ReplayGain / loudness normalisation | consistency | M | |
| Mini-player / always-on-top, Windows media overlay | desktop feel | M | |
| Playlist import/export (M3U), smart playlists | library power | M | |
| Cover/artist art lookup (online) | nicer library | M | second network use |
| Multi-language UI (Urdu/Hindi/Arabic RTL) | reach | L | |
| Microsoft Store package | no SmartScreen | M | small one-time fee |
| Code signing | trust | $ | free only via open-source programmes |
| Last.fm scrobbling | social | S–M | needs account/keys |

## 11. Version history (short)

0.11 spectrum/beat · 0.12 Lyric Studio · 0.13 styles, shortcuts, fades · 0.14 mood themes · **0.15** magnet removed + "Sung lines", reactive volume/action HUD, premium Karaoke wipe, beat detector for quiet/phone tracks, Studio markers + stereo-centre analysis, this document.
