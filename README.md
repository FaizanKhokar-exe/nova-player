# Nova Player

Nova Player is a local-first desktop music player for Windows. You point it at folders of music
files on your own computer; it builds a searchable library, plays your music, keeps a queue, shows
synced lyrics and cover art, and stays out of the way (tray icon, media keys, remembers where you
left off).

Everything stays on your machine. See [Privacy and data](#privacy-and-data).

> **Release status (read this first).** Version 0.11.2 (the "Nova Player 2" redesign) is a **release candidate**. It has been
> built into a Windows installer and exercised in a Linux test environment (see
> [Release status in detail](#release-status-in-detail)), but it has **not yet been installed and run
> on a real Windows machine**, and the installer is **unsigned**. Expect a Windows security warning
> (see [Installing](#installing-windows)).

## What it does

- **Premium UI** - a Spotify-style layout (sidebar, home, player bar) with Apple-Music-style lyrics. Dark and light
  themes; the whole interface takes its colours from the **cover art of the playing song** (or a fixed swatch).
  Covers show everywhere (lists, albums, queue, player); songs without artwork get a unique generated cover, and
  Urdu / Hindi / Arabic / CJK titles render properly (no empty boxes).
- **Library** - add music folders; Nova Player scans them (read-only), reads tags, and shows **Songs, Albums,
  Artists and Genres**. Folders are watched for changes and re-checked at every launch. Big libraries use a
  virtualized list; thumbnails are made once and cached.
- **Home, Favorites, Recently played, Playlists** - heart any song, see what you played lately, build playlists
  (create / rename / delete / add from the right-click or **...** menu / reorder by dragging).
- **Search** - one search box (Ctrl+K) over songs, albums and artists.
- **Playback** - play/pause, next/previous, seek, volume, repeat, shuffle, **playback speed (0.5x-2x, pitch kept)**
  and a **sleep timer** (minutes, or at the end of the song).
- **Equalizer** - 10 bands, 10 presets, with automatic headroom so boosts do not distort.
- **Queue drawer** - what played, what plays now, what is next; drag or use the arrows to reorder, remove, clear.
- **Lyrics** - time-synced lyrics from a `.lrc` next to the song (same name) or one you attach. In **Now Playing**
  they sit beside the cover: the line being sung fills left to right, lines further away fade and blur. **Lyrics
  Mode** is a separate full-screen layout where particles (or an aurora glow) move **with the beat** behind big lyrics.
  Click a line to jump there.
- **Real audio spectrum** - bars / wave / ring in the player bar and Now Playing, and a **Visualizer** layout, all
  drawn from the live audio (not fake animation). A single shared animation loop keeps it light; **Performance**
  (Auto / High / Balanced / Low) lowers effects on slower computers.
- **Custom wallpaper** - Settings -> Wallpaper. Limits: **PNG or JPEG**, up to **12 MB**, at least **800 x 450**
  pixels and at most 10,000 pixels on a side. It is saved as a 1920 x 1080 copy inside Nova Player's own data (your
  original is untouched), with adjustable darkening and blur so text stays readable. Remove it any time.
- **Desktop integration** - system tray, media keys, a notification when a new track starts, remembered window
  size/position, one running instance.
- **Resume** - the queue, modes and position come back at the next launch (paused, never auto-playing).

Keyboard: Space play/pause, Ctrl+Left/Right previous/next, Ctrl+K search, L lyrics, M mute, Alt+Left/Right back/forward, Esc close.

Supported audio files: `.mp3`, `.flac`, `.ogg`, `.oga`, `.opus`, `.m4a`, `.aac`, `.wav`.

## Supported platforms

| | Status |
|---|---|
| Windows 10/11, 64-bit (x64) | **Intended target.** Installer built; **not yet verified on real Windows.** |
| Windows on ARM, 32-bit Windows | Not built, not supported. |
| macOS, Linux | Not supported. (The test suite runs on Linux; that is a test environment, not a supported product.) |

There is **no auto-update**: to upgrade, install the newer installer over the old one.

## Installing (Windows)

1. Get `Nova Player Setup <version>.exe` (see [RELEASING.md](RELEASING.md) to build it yourself).
2. Run it. Because this build is **not code-signed**, Windows SmartScreen will likely show
   *"Windows protected your PC"*. Choose **More info -> Run anyway** if you trust where you got the
   file. A signed release would not show this warning.
3. The installer is not one-click: it lets you choose the install folder, and creates a Desktop
   and a Start Menu shortcut named **Nova Player**.

## Launching and adding your music

1. Start **Nova Player** from the Start Menu or Desktop shortcut.
2. On first run click **Add music folder** and pick the folder that holds your music (more folders later under
   Settings -> Library). It is scanned straight away; Nova Player never modifies, moves or deletes your files.
3. Browse Home / Songs / Albums / Artists / Genres, or search. Hover a song and press play, double-check the
   player bar at the bottom, and open **Now Playing** (the expand button or the song cover) for lyrics and the spectrum.
4. Changes in the folder are picked up automatically, and the library is re-checked at each launch.

If a folder is on a drive that is unplugged, Nova Player says the folder is unavailable and recovers
when the drive returns. Removing a folder from the library only removes it from Nova Player's
database; your files are untouched.

## Known limitations

- **Not verified on real Windows**, and **unsigned** (SmartScreen warning). No auto-update.
- **Audible output has never been verified by a person**: automated tests confirm that audio is
  decoded and the playback clock advances, not that sound comes out of speakers.
- Lyrics come only from `.lrc` files - beside the track or attached by you (no lyrics embedded in tags,
  no online lookup; an attached file may also be a `.txt` that contains `[mm:ss.xx]` timestamps). Cover art is the picture embedded in the file; `cover.jpg` /
  `folder.jpg` files are not used.
- `.wma` and other formats not listed above are ignored by the scanner.
- A file that is moved or renamed is treated as a new track (it loses queue position/identity).
- The spectrum, equalizer and beat effects need the browser's Web Audio engine; if it cannot start the app keeps
  playing and shows calm idle motion instead (the equalizer is then off).
- Wallpaper: PNG/JPEG only (WebP is refused, Electron cannot decode it on every build).
- Appearance and audio preferences (theme, equalizer, speed, wallpaper dimming...) live in the app window's browser
  storage; favourites, playlists and play history live in the library database.
- Playlists are plain (no folders, no sharing); there is no online lyrics or artwork lookup.
- Closing the window **quits** the app. (Hide-to-tray exists only as an unreleased opt-in with no UI.)
- The Windows media overlay (lock screen / system media controls) is not integrated; the media keys
  work through the keyboard shortcut mechanism and can be owned by another app.
- Recursive folder watching and removable/network drives have only been exercised on Linux; the
  launch-time rescan is the safety net.
- Single window; English only.

## Troubleshooting

- **SmartScreen blocks the installer** - expected for an unsigned build; see [Installing](#installing-windows).
- **My music does not appear** - make sure the files use one of the supported extensions, click
  **Scan library**, and check the scan result message under **Scan**. A file the tag reader cannot
  parse is reported as unreadable rather than silently dropped.
- **A track will not play** - the message says why (file removed, drive unavailable, or a format the
  decoder cannot play). Rescan after fixing the cause.
- **A media key does nothing** - another application may own it; Nova Player logs this and carries on.
  Use the on-screen buttons or the tray menu.
- **A box says "Nova Player cannot open its library"** (or "could not start") - the library database
  could not be opened. The box names the database file; if it is damaged or locked by something
  else, close other copies of the app, and if it still fails move that file aside (Nova Player will
  create a fresh library and rescan your folders). Your music files are not affected.
- **Is there a log file?** No. Nova Player writes diagnostics only to its own process console and
  keeps no log file; nothing is uploaded.

## Uninstalling and your data

Use **Windows Settings -> Apps -> Nova Player -> Uninstall** (or the *Uninstall Nova Player*
entry the installer creates). The installer is configured **not** to delete user data on uninstall
(`deleteAppDataOnUninstall: false`), so your library database and settings are expected to remain
in `%APPDATA%\Nova Player`. *This uninstall behaviour is configured but has not been run on a real
Windows machine.* To remove everything, delete that folder yourself after uninstalling.
Your music files are never touched by install or uninstall.

## Privacy and data

What the code does, checked against the source:

- **Local files, read-only.** Nova Player reads audio files and `.lrc` files inside folders you added.
  It serves audio to its own window through a private `nova-media://` address that only resolves
  tracks in your registered folders (requests outside them, links pointing out of them, and
  unknown IDs are refused). It does not write to your music folders.
- **What it stores**, in `%APPDATA%\Nova Player` (Electron's per-user data folder for this app):
  `library\nova.db` (a SQLite database: your registered folders, one row of tag data per track, your saved queue/position,
  and the text of any `.lrc` you attached) and `shell-state.json` (window position and size), plus Chromium's own
  profile data for the app window.
- **No network use by the app's own code.** There is no telemetry, analytics, crash upload, update
  check or online lookup: the page's Content-Security-Policy only allows its own files, `data:` images
  and the local `nova-media:` audio address, and the main process contains no network calls.
  (Links, if any ever opened, would be handed to your default browser; the window itself never
  navigates away from the app.)
- **No secrets, no account, no sign-in.**
- **Hardened window**: context isolation on, no Node in the page, sandboxed, a narrow two-function
  bridge to the main process, permission requests refused.

## Release status in detail

| Check | Result |
|---|---|
| Source validation (typecheck, lint, tests, build) | Passed on Linux - see [NOVA_REBUILD_STATUS.md](NOVA_REBUILD_STATUS.md) for exact commands and counts |
| Windows NSIS installer **built** (cross-built on Linux with Wine) | Yes - unsigned |
| Installer **installed and run on real Windows** | **No** |
| Code signing | **Not configured** |
| Auto-update | **Not implemented** |

For development, build and release instructions see [RELEASING.md](RELEASING.md).
