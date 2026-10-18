import { describe, expect, it, vi } from 'vitest';
import { applyWindowPolicy, isAppPage, isSafeExternalUrl, type NavigationEventLike, type WebContentsLike } from './window-policy.js';

const FILE_APP = 'file:///opt/nova/resources/app/out/renderer/index.html';
const DEV_APP = 'http://localhost:5173/';

describe('isSafeExternalUrl: only ordinary web addresses may reach the OS browser', () => {
  it.each(['https://example.com', 'http://example.com/path?q=1#frag', 'HTTPS://EXAMPLE.COM', 'https://example.com:8443/x', 'https://[::1]/', 'https://münchen.example/'])('allows %s', (url) => {
    expect(isSafeExternalUrl(url)).toBe(true);
  });

  it.each([
    'file:///C:/Windows/System32/calc.exe',
    'file://server/share/x',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'ms-msdt:/id PCWDiagnostic',
    'ms-officecmd:x',
    'search-ms:query=x',
    'nova-media://track/123e4567-e89b-42d3-a456-426614174000',
    'about:blank',
    'blob:https://example.com/uuid',
    'ftp://example.com',
    'steam://run/1',
    '//example.com',
    'example.com',
    '',
    ' ',
    'https://',
    'https://user:pass@example.com/',
    'https://trusted.example@evil.example/',
    'https://user@example.com/',
    `https://example.com/${'a'.repeat(2100)}`,
  ])('refuses %j', (url) => {
    expect(isSafeExternalUrl(url)).toBe(false);
  });

  it.each([undefined, null, 42, {}, [], true])('refuses the non-string %j without throwing', (value) => {
    expect(isSafeExternalUrl(value)).toBe(false);
  });
});

describe('isAppPage: only the application page itself', () => {
  it('matches the same file, ignoring query and fragment', () => {
    expect(isAppPage(FILE_APP, FILE_APP)).toBe(true);
    expect(isAppPage(`${FILE_APP}#/library`, FILE_APP)).toBe(true);
    expect(isAppPage(`${FILE_APP}?x=1`, FILE_APP)).toBe(true);
  });

  it('matches the dev server page', () => {
    expect(isAppPage('http://localhost:5173/', DEV_APP)).toBe(true);
    expect(isAppPage('http://localhost:5173/#x', DEV_APP)).toBe(true);
  });

  it.each([
    'file:///etc/passwd',
    'file:///opt/nova/resources/app/out/renderer/other.html',
    'file:///opt/nova/resources/app/out/renderer/index.html/../../../main/index.js',
    'https://example.com/',
    'http://localhost:5174/',
    'http://evil.example/',
    'javascript:alert(1)',
    'data:text/html,hi',
    'nova-media://track/123e4567-e89b-42d3-a456-426614174000',
    'about:blank',
    '',
    'not a url',
  ])('refuses %j for a file app', (url) => {
    expect(isAppPage(url, FILE_APP)).toBe(false);
  });

  it('refuses a different host or scheme for the dev server', () => {
    expect(isAppPage('https://localhost:5173/', DEV_APP)).toBe(false);
    expect(isAppPage('http://localhost.evil.example:5173/', DEV_APP)).toBe(false);
  });

  it.each([undefined, null, 5, {}])('refuses the non-string %j', (value) => {
    expect(isAppPage(value, FILE_APP)).toBe(false);
  });

  it('a malformed app url matches nothing (fail closed)', () => {
    expect(isAppPage(FILE_APP, 'not a url')).toBe(false);
  });
});

function fakeContents() {
  let openHandler: ((details: { url: string }) => { action: 'deny' }) | undefined;
  const listeners = new Map<string, (event: never) => void>();
  const contents: WebContentsLike = {
    setWindowOpenHandler: (handler) => void (openHandler = handler),
    on: ((event: string, listener: (event: never) => void) => void listeners.set(event, listener)) as WebContentsLike['on'],
  };
  const navigate = (kind: 'will-navigate' | 'will-frame-navigate' | 'will-redirect', url: string): boolean => {
    const event: NavigationEventLike & { prevented: boolean } = { url, prevented: false, preventDefault() { event.prevented = true; } };
    listeners.get(kind)?.(event as never);
    return event.prevented;
  };
  return { contents, open: (url: string) => openHandler?.({ url }), navigate, listeners };
}

describe('applyWindowPolicy', () => {
  function setup(openExternal: (url: string) => Promise<void> = () => Promise.resolve()) {
    const fake = fakeContents();
    const log = vi.fn();
    const spy = vi.fn(openExternal);
    applyWindowPolicy(fake.contents, { appUrl: FILE_APP, openExternal: spy, log });
    return { ...fake, log, openExternal: spy };
  }

  it('a window.open to an ordinary web link goes to the OS browser, and never opens an Electron window', () => {
    const { open, openExternal } = setup();
    expect(open('https://example.com/docs')).toEqual({ action: 'deny' });
    expect(openExternal).toHaveBeenCalledExactlyOnceWith('https://example.com/docs');
  });

  it.each(['file:///C:/Windows/System32/cmd.exe', 'javascript:alert(1)', 'ms-msdt:/id x', 'https://a@b.example/', 'data:text/html,x', ''])(
    'a window.open to %j is denied and is NOT handed to the OS',
    (url) => {
      const { open, openExternal, log } = setup();
      expect(open(url)).toEqual({ action: 'deny' });
      expect(openExternal).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledTimes(1);
    },
  );

  it('a browser that cannot be started is logged, not an unhandled rejection', async () => {
    const failure = new Error('no browser');
    const { open, log } = setup(() => Promise.reject(failure));
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      expect(open('https://example.com')).toEqual({ action: 'deny' });
      await new Promise((resolve) => setImmediate(resolve));
      expect(log).toHaveBeenCalledWith(expect.stringContaining('could not open a link'), failure);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it.each(['will-navigate', 'will-frame-navigate', 'will-redirect'] as const)('%s: staying on the app page is fine, anything else is cancelled', (kind) => {
    const { navigate } = setup();
    expect(navigate(kind, FILE_APP)).toBe(false);
    expect(navigate(kind, `${FILE_APP}#route`)).toBe(false);
    for (const url of ['https://example.com/', 'file:///etc/passwd', 'javascript:alert(1)', 'nova-media://track/x', 'data:text/html,x']) {
      expect(navigate(kind, url), url).toBe(true);
    }
  });

  it('a cancelled navigation is not forwarded to the browser (only window.open links are)', () => {
    const { navigate, openExternal } = setup();
    navigate('will-navigate', 'https://example.com/');
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('a <webview> can never be attached', () => {
    const { listeners } = setup();
    const event = { prevented: false, preventDefault() { event.prevented = true; } };
    listeners.get('will-attach-webview')?.(event as never);
    expect(event.prevented).toBe(true);
  });
});
