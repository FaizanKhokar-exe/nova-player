# Next phase plan (proposal, nothing here is built yet)

## 1. Online updates (free) — BUILT in 0.16.0 (needs a real release to verify)
- `electron-updater` + GitHub Releases. The Windows workflow publishes `Nova Player Setup x.y.z.exe`, its `.blockmap` and `latest.yml` to a Release (tag `vX.Y.Z`); installed apps check `latest.yml`, download in the background, and install on quit.
- Needs: a public repo (or a read-only token inside the app, which is not safe), `publish: github` in `electron-builder.yml`, `GH_TOKEN` in the workflow (already provided as `secrets.GITHUB_TOKEN`).
- Privacy: this is a second network access (github.com). It must be disclosed (FAQ, Settings) and switchable ("Check for updates automatically"), default ON with a one-time notice.
- Unsigned builds update fine technically, but Windows SmartScreen will still warn on first install (see 3).
- Rollout safety: staged percentage, "skip this version", never update while a song is playing without asking, keep the previous installer for rollback.

## 2. "Production" pages
- Help / FAQ view (offline): getting started, adding folders, lyrics + Lyric Studio, shortcuts, "why does Windows warn me", privacy (what leaves the computer: nothing, except lyrics search and update check), troubleshooting, how to report a bug (copy diagnostics button).
- About: version, build date, licence, third-party notices (Electron, React, music-metadata, better-sqlite3, ...), links, "Check for updates".
- First-run welcome (add a folder, pick theme), crash/error screen with "copy details".

## 3. Licence, brand, distribution
- Decide the app licence: (a) open source (MIT = anyone may copy/sell it; GPL = copies must stay open) or (b) proprietary freeware (EULA, source private). Either way ship a `LICENSE` + `THIRD_PARTY_NOTICES`. This is not legal advice.
- Brand: search the name "Nova Player" before investing (many products use it); check domain, GitHub org, trademark search in your country. A distinctive name is easier to protect.
- Code signing removes the SmartScreen warning but normally costs money. Free options exist only for open-source projects (e.g. SignPath Foundation's programme - check current terms). Otherwise users click "More info → Run anyway", and reputation builds with downloads.
- Microsoft Store is an alternative (small one-time developer fee, no SmartScreen warning).

## 4. Earning without spending
- Realistic: donations. GitHub Sponsors / Ko-fi / Buy Me a Coffee are free to set up (they take a payout fee). A "Support Nova Player" button in About + a thank-you supporter badge.
- Optional supporter perks without a server: a signed licence file (Ed25519, verified offline) you issue by hand to donors; unlocks cosmetic extras only (themes, icons). Manual work, easy to share, so keep it honour-based.
- Not recommended: ads or tracking in a music player; selling user data.
- Honest expectation: a small free desktop app usually earns little; the value is the portfolio / brand / reach.
