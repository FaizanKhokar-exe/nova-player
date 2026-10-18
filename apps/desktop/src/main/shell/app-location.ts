import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Where the application's one page is loaded from: the dev server in a development run, otherwise the built
 * `index.html` next to the main bundle. The single source for both loading the window and judging whether a
 * navigation or an IPC call comes from that page (Electron-free, unit-tested).
 */
export function resolveAppLocation(mainDir: string, devServerUrl: string | undefined): { readonly url: string; readonly kind: 'dev-server' | 'file'; readonly filePath?: string } {
  if (devServerUrl !== undefined && devServerUrl.length > 0) return { url: devServerUrl, kind: 'dev-server' };
  const filePath = path.join(mainDir, '../renderer/index.html');
  return { url: pathToFileURL(filePath).href, kind: 'file', filePath };
}
