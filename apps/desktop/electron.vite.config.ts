import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

// Our own @nova/* workspace packages ship raw TypeScript source (no build
// step of their own - see the accepted architecture). They must be bundled
// and transpiled by Vite along with main/preload, not externalized like a
// normal npm dependency (which already ships compiled JS) - externalizing
// them caused a real, verified runtime failure: Electron's plain Node ESM
// loader cannot resolve or execute the raw .ts source directly. This
// `exclude` list is what fixes that; everything else (real npm deps like
// 'electron', 'better-sqlite3', 'music-metadata') stays externalized, which
// is correct since those already ship real, runnable JS/native binaries.
const novaWorkspacePackages = ['@nova/shared', '@nova/domain', '@nova/infrastructure', '@nova/ui'];

// electron-vite's externalizeDeps only auto-externalizes packages listed in
// THIS package's own package.json "dependencies" (apps/desktop/package.json).
// Now that @nova/infrastructure is bundled/inlined (see above), Rollup
// reaches better-sqlite3 and music-metadata as if they were ordinary local
// modules - and fails on better-sqlite3's dynamic native-binary require,
// since a static bundler cannot resolve a runtime-computed require() path.
// This is a real, verified failure this project hit, not a hypothetical:
// these two must be forced into the externalized set explicitly via
// `include`, even though they're not direct dependencies of @nova/desktop
// itself, so they stay as plain `require()`/`import` calls resolved by
// Node/Electron at runtime instead of being bundled.
const nativeOrEsmOnlyDeps = ['better-sqlite3', 'music-metadata'];

export default defineConfig({
  main: {
    build: {
      externalizeDeps: { exclude: novaWorkspacePackages, include: nativeOrEsmOnlyDeps },
      outDir: 'out/main',
      rollupOptions: {
        input: resolve(__dirname, 'src/main/index.ts'),
        output: { format: 'es', entryFileNames: 'index.js' },
      },
    },
  },
  preload: {
    build: {
      externalizeDeps: { exclude: novaWorkspacePackages },
      outDir: 'out/preload',
      rollupOptions: {
        input: resolve(__dirname, 'src/preload/index.ts'),
        // Forced to CJS + .cjs extension: Electron's sandboxed preload loader
        // does not reliably support ESM preload scripts today, even though
        // the app's package.json is "type": "module" and the source below is
        // written with ESM import/export syntax. This is a build-output
        // detail, not a reversal of the "ESM throughout" decision.
        output: { format: 'cjs', entryFileNames: 'index.cjs' },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html'),
      },
    },
  },
});
