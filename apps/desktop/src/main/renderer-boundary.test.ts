import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The renderer boundary, enforced as a test (Phase 4). The renderer - the
 * `@nova/ui` package and the renderer entry point - may talk to the backend ONLY through
 * the typed `window.nova` bridge. It reads its own source as text and fails if
 * a file starts importing Node/Electron/database/domain/infrastructure code,
 * reaches for a global that would bypass the bridge, or builds a media address
 * itself (main hands those out, opaque, with each track).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');
const uiDir = path.join(repoRoot, 'packages/ui/src');
const rendererEntryDir = path.join(repoRoot, 'apps/desktop/src/renderer/src');

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const isShippedSource = (file: string): boolean => /\.(ts|tsx)$/.test(file) && !/\.test\.tsx?$/.test(file) && !/test-support\.ts$/.test(file) && !file.endsWith('.d.ts');

const uiFiles = walk(uiDir).filter(isShippedSource);
const rendererFiles = walk(rendererEntryDir).filter(isShippedSource);
const all = [...uiFiles, ...rendererFiles];
const rel = (file: string): string => path.relative(repoRoot, file).split(path.sep).join('/');

/** Source with comments removed, so a rule is judged on code, not on prose that mentions a name. */
const codeOf = (file: string): string => fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

interface Import {
  readonly specifier: string;
  readonly typeOnly: boolean;
}

function importsOf(source: string): Import[] {
  const found: Import[] = [];
  const regex = /(?:^|\n)\s*(import|export)\s+(type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source)) !== null) found.push({ specifier: match[3]!, typeOnly: match[2] !== undefined });
  // dynamic import() and require()
  for (const m of source.matchAll(/\b(?:import|require)\(\s*['"]([^'"]+)['"]\s*\)/g)) found.push({ specifier: m[1]!, typeOnly: false });
  return found;
}

const FORBIDDEN_IMPORTS = [/^electron/, /^node:/, /^(fs|path|os|child_process|net|http|https|crypto|stream|buffer|url)(\/|$)/, /better-sqlite3/, /music-metadata/, /^@nova\/infrastructure/, /^@nova\/domain/];

/** Phase 6: the single, narrow exception - the renderer consumes two pure lyric rules from the domain through ONE adapter file. */
const DOMAIN_ADAPTER = 'packages/ui/src/nowplaying/lyric-sync.ts';

describe('renderer boundary: what the UI may import', () => {
  it('found the sources to check (sanity check on the test itself)', () => {
    expect(uiFiles.length).toBeGreaterThan(8);
    expect(rendererFiles.map(rel)).toEqual(expect.arrayContaining(['apps/desktop/src/renderer/src/main.tsx', 'apps/desktop/src/renderer/src/App.tsx']));
    expect(uiFiles.map(rel)).toEqual(expect.arrayContaining(['packages/ui/src/playback/playback-store.ts', 'packages/ui/src/app/Dock.tsx']));
  });

  it.each(all.map((f) => [rel(f), f] as const))('%s imports no Node, Electron, SQLite, tag-reader, domain or infrastructure code', (_name, file) => {
    const specifiers = importsOf(fs.readFileSync(file, 'utf8')).map((i) => i.specifier);
    const allowDomain = rel(file) === DOMAIN_ADAPTER;
    const hits = specifiers.filter((s) => FORBIDDEN_IMPORTS.some((rule) => rule.test(s)) && !(allowDomain && s === '@nova/domain'));
    expect(hits).toEqual([]);
  });

  it.each(all.map((f) => [rel(f), f] as const))('%s imports @nova/shared only as types', (_name, file) => {
    const shared = importsOf(fs.readFileSync(file, 'utf8')).filter((i) => i.specifier === '@nova/shared');
    expect(shared.filter((i) => !i.typeOnly)).toEqual([]);
  });
});

describe('renderer boundary: globals that would bypass the bridge', () => {
  const FORBIDDEN_TOKENS: Array<[string, RegExp]> = [
    ['ipcRenderer', /\bipcRenderer\b/],
    ['require()', /\brequire\s*\(/],
    ['process', /\bprocess\s*\./],
    ['Buffer', /\bBuffer\b/],
    ['localStorage', /\blocalStorage\b/],
    ['sessionStorage', /\bsessionStorage\b/],
    ['indexedDB', /\bindexedDB\b/],
    ['fetch of a media address', /\bfetch\s*\(/],
    ['XMLHttpRequest', /\bXMLHttpRequest\b/],
    ['eval', /\beval\s*\(/],
    ['new Function', /\bnew\s+Function\b/],
    ['dangerouslySetInnerHTML', /dangerouslySetInnerHTML/],
  ];

  // Phase 10 (deliberate, narrow exception): the theme store keeps the viewer's own appearance choices
  // (dark/light, accent, lyric size) in localStorage. It holds no library data, paths or secrets, every
  // access is guarded, and nothing else may touch browser storage.
  // Nova Player 2 (deliberate, same narrow exception): the preferences store keeps the viewer's own display choices
  // (speed, equalizer, visualizer, wallpaper dim/blur, sidebar...) in localStorage. No library data, paths or secrets.
  const ALLOWED: Record<string, readonly string[]> = {
    'packages/ui/src/theme/theme-store.ts': ['localStorage'],
    'packages/ui/src/prefs/prefs-store.ts': ['localStorage'],
    // v0.11.2 (deliberate, narrow exception): the seek-bar hover preview needs the loudness profile of the playing song.
    // This one file fetches the address the playback store hands it (it never builds one: the nova-media rule below still holds)
    // and decodes it with Web Audio; the result is a few hundred numbers kept in memory.
    'packages/ui/src/playback/energy-profile.ts': ['fetch of a media address'],
  };

  it.each(all.map((f) => [rel(f), f] as const))('%s uses none of them', (name, file) => {
    const source = codeOf(file);
    const allowed = ALLOWED[name] ?? [];
    const hits = FORBIDDEN_TOKENS.filter(([token, regex]) => !allowed.includes(token) && regex.test(source)).map(([token]) => token);
    expect(hits).toEqual([]);
  });

  it('only the renderer entry point touches window.nova', () => {
    const offenders = all.filter((file) => /\bwindow\.nova\b/.test(codeOf(file))).map(rel);
    expect(offenders).toEqual(['apps/desktop/src/renderer/src/main.tsx']);
  });
});

describe('renderer boundary: media addresses and paths', () => {
  it('no UI source builds or parses a nova-media address: main hands them out, opaque, with each track', () => {
    const offenders = all.filter((file) => /nova-media/.test(codeOf(file))).map(rel);
    expect(offenders).toEqual([]);
  });

  it('the only place the renderer touches the audio element\'s src is the playback store', () => {
    const offenders = all.filter((file) => /\.src\s*=[^=]/.test(codeOf(file))).map(rel);
    // Phase 10: palette.ts also assigns `.src`, on an off-screen `new Image()` that decodes the cover's data: URL that main
    // already sent (to read its colours); it never touches the audio element.
    expect(offenders).toEqual(['packages/ui/src/playback/playback-store.ts', 'packages/ui/src/theme/palette.ts']);
  });

  it('no UI source reads a file-path field from a track', () => {
    const offenders = all.filter((file) => /\bsourcePath\b|\babsolutePath\b|\bfilePath\b/.test(codeOf(file))).map(rel);
    expect(offenders).toEqual([]);
  });

  it('the renderer creates exactly one audio element, in the entry point', () => {
    const creators = all.filter((file) => /createElement\(\s*['"]audio['"]|new\s+Audio\s*\(|<audio[\s>]/.test(codeOf(file))).map(rel);
    expect(creators).toEqual(['apps/desktop/src/renderer/src/main.tsx']);
  });

  it('no queue, shuffle or next-track logic exists in the renderer: those rules live in the domain, behind IPC', () => {
    const offenders = all.filter((file) => /fisherYates|shuffleArray|Math\.random|decideOn|replaceQueue|enableShuffle|jumpToIndex/.test(codeOf(file))).map(rel);
    expect(offenders).toEqual([]);
  });
});

describe('renderer boundary: Phase 5 library rules live in main, not in React', () => {
  it('no UI source sorts, groups or normalizes the library: ordering, grouping and counts come from main', () => {
    for (const file of uiFiles) {
      const code = codeOf(file);
      // `.sort(` / `localeCompare` / `Intl.Collator` would mean React is ordering tracks itself.
      expect(code, `${rel(file)} sorts in the renderer`).not.toMatch(/\.sort\s*\(|\.toSorted\s*\(|localeCompare|Intl\.Collator/);
      // `new Map`/`reduce` over tracks to bucket by album/artist/genre would be a second grouping implementation.
      expect(code, `${rel(file)} groups tracks in the renderer`).not.toMatch(/groupBy|\.reduce\s*\([^)]*(album|artist|genre)/);
    }
  });

  it('the renderer sends only requests for queue edits: it never builds or reorders a queue array', () => {
    for (const file of uiFiles) {
      const code = codeOf(file);
      expect(code, `${rel(file)} splices a queue`).not.toMatch(/\.splice\s*\(/);
    }
    const store = codeOf(path.join(uiDir, 'playback/playback-store.ts'));
    for (const channel of ['playback:removeFromQueue', 'playback:moveQueueItem', 'playback:clearQueue', 'playback:enqueue', 'playback:playGroup', 'playback:getQueue']) {
      expect(store).toContain(channel);
    }
  });

  it('there is exactly one useVirtualizer call site (app/TrackList, Nova Player 2), and the lint rule is suppressed nowhere else', () => {
    const users = uiFiles.filter((file) => /\buseVirtualizer\s*\(/.test(codeOf(file))).map(rel);
    expect(users).toEqual(['packages/ui/src/app/TrackList.tsx']);
    const raw = (file: string): string => fs.readFileSync(file, 'utf8');
    const directive = /^\s*\/\/\s*eslint-disable/m; // a real directive line, not prose that mentions one
    const suppressions = [...uiFiles, ...rendererFiles].filter((file) => directive.test(raw(file)) || /\/\*\s*eslint-disable/.test(raw(file))).map(rel);
    expect(suppressions).toEqual(['packages/ui/src/app/TrackList.tsx']);
    const lines = raw(path.join(uiDir, 'app/TrackList.tsx')).split('\n').filter((line) => /^\s*\/\/\s*eslint-disable/.test(line));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('react-hooks/incompatible-library'); // that one rule, nothing broader
  });

  it('the playback position store is read by the progress display only, never by a list component', () => {
    const readers = uiFiles.filter((file) => /usePlaybackPositionMs|positionStore/.test(codeOf(file))).map(rel);
    expect(readers.every((file) => !/app\/(TrackList|QueueDrawer|Sidebar)\./.test(file))).toBe(true);
  });
});


describe('renderer boundary: the one domain import (Phase 6 lyric rules)', () => {
  it('only the adapter imports @nova/domain, and only getActiveLyricIndex and getLyricSeekTime', () => {
    const importers = uiFiles.filter((file) => importsOf(fs.readFileSync(file, 'utf8')).some((i) => i.specifier === '@nova/domain')).map(rel);
    expect(importers).toEqual([DOMAIN_ADAPTER]);
    const source = fs.readFileSync(path.join(repoRoot, DOMAIN_ADAPTER), 'utf8');
    const named = /import\s*\{([^}]*)\}\s*from\s*'@nova\/domain'/.exec(source)?.[1]?.split(',').map((n) => n.trim()).filter(Boolean);
    expect(named).toEqual(['getActiveLyricIndex', 'getLyricSeekTime']);
    expect(source).not.toMatch(/parseLyrics/); // parsing stays in main
  });

  it('no UI source parses LRC text or re-implements the active-line search', () => {
    for (const file of uiFiles) {
      if (rel(file) === DOMAIN_ADAPTER) continue;
      const code = codeOf(file);
      expect(code, `${rel(file)} parses lyrics`).not.toMatch(/parseLyrics|\[\(\\d|mm:ss|TIME_TAG/);
      expect(code, `${rel(file)} searches lyric lines itself`).not.toMatch(/timeMs\s*<=|timeMs\s*>/);
    }
  });
});

describe('Phase 8: the page\'s content security policy', () => {
  const html = fs.readFileSync(path.resolve(here, '../renderer/index.html'), 'utf8');
  const policy = /Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ?? '';

  it('allows only the app itself, plus nova-media audio and data: images, and forbids plugins, <base> and form posts', () => {
    for (const directive of ["default-src 'self'", "script-src 'self'", 'media-src \'self\' nova-media:', "connect-src 'self' nova-media:" /* v0.11.2: the seek-bar preview reads the playing song through the same address (nothing else may connect) */, "object-src 'none'", "base-uri 'none'", "form-action 'none'"]) {
      expect(policy).toContain(directive);
    }
    expect(policy).not.toMatch(/unsafe-eval|script-src[^;]*unsafe-inline|http:|https:|\*/);
  });
});
