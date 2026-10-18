import { isAppPage } from '../shell/window-policy.js';

/** What main can observe about the frame an IPC call came from. Plain data, so the rule is unit-tested without Electron. */
export interface SenderFacts {
  /** The calling web contents belong to one of OUR windows. */
  readonly knownWindow: boolean;
  /** The call came from that window's top-level frame (not an iframe). */
  readonly isMainFrame: boolean;
  /** The address the calling frame is showing. */
  readonly frameUrl: unknown;
}

/**
 * Whether an IPC call may be served. Beyond "one of our windows' top-level frame" (Phase 3), Phase 8 also requires
 * that frame to be showing the application's OWN page: the preload bridge is attached to whatever the window
 * shows, so if the window were ever pointed somewhere else (the navigation rules in `window-policy.ts` are the
 * first line of defence) that page must still not be able to drive the library, the media, or the file picker.
 * Total: anything unexpected is "not trusted".
 */
export function isTrustedSenderFacts(facts: SenderFacts, appUrl: string): boolean {
  return facts.knownWindow && facts.isMainFrame && isAppPage(facts.frameUrl, appUrl);
}
