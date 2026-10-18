/**
 * `crypto.randomUUID()` was locked in during Phase 0 (product decision 2:
 * use the built-in Web Crypto API for all entity IDs, never the `uuid`
 * package). It's a cross-runtime Web-platform standard - identical in
 * behavior in Node, in an Electron renderer, and in a browser - not an
 * Electron-specific or Node-specific API.
 *
 * TypeScript still needs *some* lib to know the global `crypto` symbol
 * exists. Rather than adding `"types": ["node"]` (which would pull in every
 * Node global, weakening this package's independence from any one runtime)
 * or the `"dom"` lib (which pulls in the entire browser global surface),
 * this file declares only the one method this package actually uses.
 */
declare global {
  interface Crypto {
    randomUUID(): string;
  }

  var crypto: Crypto;
}

export {};
