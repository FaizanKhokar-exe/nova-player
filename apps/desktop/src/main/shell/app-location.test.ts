import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveAppLocation } from './app-location.js';

describe('resolveAppLocation', () => {
  const mainDir = path.resolve('/opt/nova/out/main');

  it('is the built index.html next to the main bundle when there is no dev server', () => {
    const location = resolveAppLocation(mainDir, undefined);
    expect(location.kind).toBe('file');
    expect(location.filePath).toBe(path.resolve('/opt/nova/out/renderer/index.html'));
    expect(location.url).toBe(pathToFileURL(path.resolve('/opt/nova/out/renderer/index.html')).href);
  });

  it('an empty dev server value counts as none', () => {
    expect(resolveAppLocation(mainDir, '').kind).toBe('file');
  });

  it('is the dev server address when one is given', () => {
    expect(resolveAppLocation(mainDir, 'http://localhost:5173/')).toEqual({ url: 'http://localhost:5173/', kind: 'dev-server' });
  });
});
