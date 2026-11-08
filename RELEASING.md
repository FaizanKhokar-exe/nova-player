# Developing and releasing Nova Player

User-facing documentation is in [README.md](README.md). Project history and exact validation
evidence per phase is in [NOVA_REBUILD_STATUS.md](NOVA_REBUILD_STATUS.md). This file is for
building, testing and releasing.

## Toolchain

| Tool | Version | Notes |
|---|---|---|
| Node.js | >= 22 (validated with 22.22.0) | `engines` in `package.json` |
| pnpm | 12.6.0 | pinned by `packageManager`; use Corepack: `corepack enable` |
| Electron | 44.4.5 | exact pin in `apps/desktop/package.json` |
| electron-builder | 26.15.3 | NSIS target only, x64 |
| TypeScript / Vite / electron-vite / Vitest / Playwright | ^6.0.3 / ^7.3.6 / 5.0.0 / ^5.0.1 / ^1.63.0 | see lockfile |

`better-sqlite3` 13.0.3 ships prebuilt N-API binaries for every platform (including `win32-x64`),
so **no C++ toolchain is needed** and electron-builder is configured not to rebuild native modules
(`npmRebuild: false`).

pnpm skips dependency install scripts, so Electron's binary is fetched explicitly after install:

```
pnpm install --frozen-lockfile
npx install-electron          # downloads the Electron binary (needed for E2E and packaging)
```

## Source validation commands

Run from the repository root.

```
pnpm typecheck                              # tsc -b, strict
pnpm exec eslint . --max-warnings 0         # lint, zero warnings allowed
pnpm build                                  # electron-vite build -> apps/desktop/out
pnpm test                                   # Vitest, all projects (domain, infrastructure, desktop, ui)
xvfb-run -a pnpm exec playwright test       # E2E against real Electron (Linux needs Xvfb; on Windows run without xvfb-run)
```

These validate the **source tree** only. They say nothing about an installer.

## Packaging

All packaging commands run from `apps/desktop` (or with `pnpm --filter @nova/desktop run ...`).
Configuration is `apps/desktop/electron-builder.yml`; the app identity is `appId: com.novaplayer.desktop`,
`productName: Nova Player`, version from `apps/desktop/package.json`.

| Goal | Command | Output |
|---|---|---|
| Unpacked build for the *current* OS (fast; no installer) | `pnpm --filter @nova/desktop run build:unpack` | `apps/desktop/dist-installer/<os>-unpacked/` |
| **Windows NSIS installer** (x64) | `pnpm --filter @nova/desktop run dist:win` | `apps/desktop/dist-installer/Nova Player Setup <version>.exe` (+ `.blockmap`, `win-unpacked/`) |

`dist-installer/` is a build output and is git-ignored / excluded from source archives.

### Building the installer in the cloud (GitHub Actions, one single .exe)

`.github/workflows/windows-installer.yml` builds the installer on a real `windows-latest` runner and uploads **one file**,
`Nova Player Setup <version>.exe`, as the workflow artifact `Nova-Player-Setup`. Push the repository to GitHub, open
**Actions -> Windows installer -> Run workflow**, and download the artifact when it finishes (about 5-10 minutes). Pushing a
tag such as `v0.11.3` also attaches the installer to a GitHub Release. The workflow runs typecheck, lint and unit tests first.
The result is **unsigned** (SmartScreen warns; choose *More info -> Run anyway*) - no signing secret is configured, and
adding one is a deliberate, separate step (see the signing notes below).

### Building the installer on Windows (the supported release path)

Windows 10/11 x64, Node >= 22, pnpm as above:

```
pnpm install --frozen-lockfile
pnpm --filter @nova/desktop run dist:win
```

### Building it from Linux (what this repository's validation used)

electron-builder generates the NSIS uninstaller by *running* a 32-bit Windows program, so Linux
needs Wine **with 32-bit support** and an X display:

```
dpkg --add-architecture i386 && apt-get update
apt-get install -y --no-install-recommends wine wine32:i386 xvfb
export WINEDEBUG=-all
xvfb-run -a pnpm --filter @nova/desktop run dist:win
```

If you previously ran Wine without `wine32`, delete the old Wine prefix (`~/.wine` or `$WINEPREFIX`)
first; a 64-bit-only prefix fails with `could not load kernel32.dll`. Network access to
`github.com` (electron-builder downloads Electron, NSIS and winCodeSign) is required.

A Wine-built installer is a valid way to produce the file, but is **not** a substitute for testing
it on Windows.

### What the packaging configuration guarantees

- Only `out/**` (the electron-vite bundle), `package.json`, and the runtime-external dependencies
  (`better-sqlite3`, `music-metadata` and its dependencies) enter `app.asar`. The `@nova/*` workspace
  packages and the UI libraries are excluded because Vite has already bundled them; this also keeps
  compiled test files and source maps out. `better-sqlite3`'s C++ sources are excluded (prebuilds only).
- `resources/icon.png` and `resources/tray.png` are copied beside the asar
  (`process.resourcesPath`), which is where the app reads them when packaged.
- `publish` is the GitHub provider (owner FaizanKhokar-exe, repo nova-player) but builds run with `--publish never`: nothing is uploaded by electron-builder; it only writes `latest.yml` + `.blockmap` next to the installer.
- NSIS: not one-click, user may choose the install directory, Desktop and Start Menu shortcuts,
  per-user by default, `deleteAppDataOnUninstall: false`.
- App data lives in `%APPDATA%\Nova Player` (set by `productName` in `apps/desktop/package.json`).

## Publishing an update (free, GitHub Releases)

1. Bump `version` in `apps/desktop/package.json` (e.g. 0.16.1) and push.
2. Tag it: `git tag v0.16.1 && git push origin v0.16.1`.
3. The *Windows installer* workflow builds and attaches `Nova-Player-Setup-0.16.1.exe`, its `.blockmap` and `latest.yml` to the Release.
4. Installed apps (Settings -> Updates, or the automatic check ~8 s after launch) see the new `latest.yml`, show a notice, download on click and install on "Restart & update".

Requirements: the repository must be **public** (no token inside the app); the first install is always manual; the tag version must match `package.json`; unsigned builds still update but SmartScreen warns on a fresh download. Untested on real Windows/GitHub until the first real release.

## Code signing (optional; not configured)

The installer is **unsigned** by default and no certificate exists in this repository. electron-builder
signs only when credentials are present in the **environment**; never commit them:

```
set CSC_LINK=C:\path\to\certificate.pfx        # or a base64 / https URL, supplied by your CI secret store
set CSC_KEY_PASSWORD=<password>                # CI secret
pnpm --filter @nova/desktop run dist:win
```

An Azure Trusted Signing block is left commented out in `electron-builder.yml`. After the first
signed build, verify it on Windows (`Get-AuthenticodeSignature "Nova Player Setup <version>.exe"`)
before claiming the release is signed.

## Distinguishing validation levels

When reporting a release, say which of these was actually done:

1. **Source validated** - typecheck, lint, Vitest, E2E (above). Linux is sufficient.
2. **Packaged-app smoke tested** - the *unpacked* app (asar and all) launched and exercised:
   `pnpm --filter @nova/desktop run build:unpack` then
   `xvfb-run -a pnpm exec playwright test -c playwright.packaged.config.ts`
   (set `NOVA_PACKAGED_EXECUTABLE` to test a different unpacked build). This is Linux-only here.
3. **Installer built** - `dist:win` produced `Nova Player Setup <version>.exe` (record its size and SHA-256).
4. **Installed and run on real Windows** - the only level that verifies the installer itself.
   Not done for 0.11.3.

Only level 4 supports a statement like "the Windows installer works".

## Manual Windows verification checklist (not yet performed)

On a clean Windows 10/11 x64 machine or VM:

- [ ] Run the installer; SmartScreen warning appears (unsigned) and *Run anyway* proceeds.
- [ ] Install-directory page works; Desktop and Start Menu **Nova Player** shortcuts appear.
- [ ] App launches with the Nova Player icon, one window, tray icon present.
- [ ] Add a music folder with real files; scan completes; tracks, albums, artists, genres appear.
- [ ] Play a track; **sound is audible**; seek, volume, next/previous, shuffle, repeat work.
- [ ] Media keys and tray menu control playback; a toast appears for a new track when unfocused.
- [ ] A `.lrc` file beside a track shows synced lyrics; an embedded cover shows.
- [ ] Settings: Light/Dark switch, the accent follows the cover of the playing track, fixed swatches work, choices survive a relaunch.
- [ ] Lyrics page: current line glows, scrolling by hand shows *Jump to now*; *Attach a .lrc file...* opens the Windows file dialog and the chosen lyrics show; *Remove attached lyrics* undoes it.
- [ ] The Inter / Sora fonts render (not a fallback), and the window looks right at 125% and 150% display scaling.
- [ ] Close and relaunch: queue and position restored (paused); a second launch focuses the first.
- [ ] Data created under `%APPDATA%\Nova Player`.
- [ ] Uninstall via Apps & Features: app and shortcuts removed; `%APPDATA%\Nova Player` and the music files remain.
- [ ] Reinstall over an existing install keeps the library.

## Version and release procedure

1. Update `version` in `apps/desktop/package.json` (the installer file name and `app.getVersion()` follow it).
2. Run the source validation commands; fix anything failing.
3. Build with `dist:win`; record the file size and SHA-256.
4. Run the manual Windows checklist; record results in `NOVA_REBUILD_STATUS.md`.
5. Distribute the installer (and its SHA-256). Do not describe the release as signed, auto-updating or
   Windows-verified unless those things are true.
