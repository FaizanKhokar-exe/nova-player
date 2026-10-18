import { describe, expect, it } from 'vitest';
import { isTrustedSenderFacts } from './trusted-sender.js';

const APP = 'file:///opt/nova/resources/app/out/renderer/index.html';
const good = { knownWindow: true, isMainFrame: true, frameUrl: `${APP}#/library?x=1` };

describe('isTrustedSenderFacts', () => {
  it('accepts the main frame of our window showing the application page (query and fragment do not matter)', () => {
    expect(isTrustedSenderFacts(good, APP)).toBe(true);
  });
  it('refuses every other combination', () => {
    expect(isTrustedSenderFacts({ ...good, knownWindow: false }, APP)).toBe(false);
    expect(isTrustedSenderFacts({ ...good, isMainFrame: false }, APP)).toBe(false);
    for (const frameUrl of ['https://example.org/', 'file:///etc/passwd', 'file:///opt/nova/resources/app/out/renderer/other.html', 'data:text/html,hi', 'about:blank', '', undefined, null, 42, {}]) {
      expect(isTrustedSenderFacts({ ...good, frameUrl }, APP), String(frameUrl)).toBe(false);
    }
  });
});
