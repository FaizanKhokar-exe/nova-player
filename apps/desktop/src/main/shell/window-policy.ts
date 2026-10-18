/**
 * Phase 8: what a window's web contents may do besides show the application page. Electron-free (the Electron
 * objects are passed in as small interfaces), so the rules are unit-tested; `electron-shell.ts` supplies the
 * real ones.
 *
 *  - The window shows ONE page: the application's own `index.html` (or the dev server's address in development).
 *    Any other navigation of the window - a link, a script setting `location`, a redirect - is cancelled, so no
 *    other page ever runs with the application's preload bridge.
 *  - A link that wants a new window is never opened in Electron. Only an ordinary web address (http or https,
 *    no embedded credentials) is handed to the operating system's browser; every other scheme (`file:`,
 *    `javascript:`, `ms-msdt:` and the like - which the OS would hand to ANOTHER program) is dropped.
 *  - `<webview>` is never allowed, and every permission request (camera, geolocation, notifications from the
 *    page, ...) is refused: the application is local and asks for none of them.
 */

const MAX_EXTERNAL_URL_LENGTH = 2048;

/** Whether `raw` is an ordinary web address that may be opened in the user's browser. Total: never throws. */
export function isSafeExternalUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_EXTERNAL_URL_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.hostname.length === 0) return false;
  if (url.username !== '' || url.password !== '') return false; // `https://trusted.example@evil.example/`
  return true;
}

/**
 * Whether `candidate` is the application's own page. The comparison is on protocol, host and path: a different
 * query or fragment is still the same page; a different file, host or scheme is not. Total: never throws.
 */
export function isAppPage(candidate: unknown, appUrl: string): boolean {
  if (typeof candidate !== 'string') return false;
  try {
    const wanted = new URL(appUrl);
    const actual = new URL(candidate);
    return actual.protocol === wanted.protocol && actual.host === wanted.host && actual.pathname === wanted.pathname;
  } catch {
    return false;
  }
}

export interface NavigationEventLike {
  readonly url: string;
  preventDefault(): void;
}

export interface WebContentsLike {
  setWindowOpenHandler(handler: (details: { readonly url: string }) => { readonly action: 'deny' }): void;
  on(event: 'will-navigate' | 'will-frame-navigate' | 'will-redirect', listener: (event: NavigationEventLike) => void): unknown;
  on(event: 'will-attach-webview', listener: (event: { preventDefault(): void }) => void): unknown;
}

export interface WindowPolicyDependencies {
  /** The application page this window is allowed to show. */
  readonly appUrl: string;
  /** Hands an already-vetted web address to the OS browser. May reject (no browser, refused). */
  readonly openExternal: (url: string) => Promise<void>;
  readonly log: (message: string, error: unknown) => void;
}

/** Installs the rules above on one window's web contents. Call once per window. */
export function applyWindowPolicy(contents: WebContentsLike, dependencies: WindowPolicyDependencies): void {
  const { appUrl, openExternal, log } = dependencies;

  contents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) {
      // Fire and forget, but never an unhandled rejection: a browser that cannot be started is a logged, ordinary failure.
      void openExternal(url).catch((error: unknown) => log('[nova] could not open a link in the browser:', error));
    } else {
      log('[nova] refused to open a link with a disallowed address.', undefined);
    }
    return { action: 'deny' };
  });

  const keepOnAppPage = (event: NavigationEventLike): void => {
    if (isAppPage(event.url, appUrl)) return;
    event.preventDefault();
    // A refused navigation never goes to the browser by itself: only `window.open` links are offered to it.
    log('[nova] blocked the window from navigating away from the application.', undefined);
  };
  contents.on('will-navigate', keepOnAppPage);
  contents.on('will-frame-navigate', keepOnAppPage);
  contents.on('will-redirect', keepOnAppPage);
  contents.on('will-attach-webview', (event) => event.preventDefault());
}
