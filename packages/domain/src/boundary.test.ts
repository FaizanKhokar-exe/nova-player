import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A lightweight, dependency-free architectural check (per the Phase 1A
 * brief: a large tool like dependency-cruiser would be excessive for this).
 * It reads this package's own SOURCE files as plain text and greps for
 * import specifiers / global tokens that would mean the domain layer has
 * started depending on Electron, React, the DOM, the filesystem, or a
 * specific database/tag-reading library.
 *
 * Deliberately implemented with only `node:fs`/`node:path` - the same
 * built-ins every other test file in this repo already uses to read fixture
 * files - not a new dependency. This file is test infrastructure, not
 * domain logic, so it is explicitly excluded from the scan it performs (see
 * `SELF_EXCLUDE` below); everything the domain layer actually ships is
 * still covered.
 */

const srcDir = path.resolve(fileURLToPath(new URL('.', import.meta.url)));
const SELF_EXCLUDE = 'boundary.test.ts';

const FORBIDDEN_IMPORT_SPECIFIERS = [
  'electron',
  'react',
  'react-dom',
  'better-sqlite3',
  'music-metadata',
  'fs',
  'node:fs',
  'node:fs/promises',
  'path',
  'node:path',
  'node:child_process',
  'node:net',
  'node:http',
];

const FORBIDDEN_GLOBAL_TOKENS = ['document.', 'window.', 'localStorage', 'indexedDB', 'XMLHttpRequest'];

function listDomainSourceFiles(): string[] {
  return fs
    .readdirSync(srcDir)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && name !== SELF_EXCLUDE)
    .filter((name) => name !== 'global.d.ts')
    .map((name) => path.join(srcDir, name));
}

function extractImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const importRegex = /(?:import|export)\s+(?:[^'"]*from\s+)?['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(source)) !== null) {
    const specifier = match[1];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  return specifiers;
}

describe('packages/domain architectural boundary', () => {
  const files = listDomainSourceFiles();

  it('found at least one domain source file to check (sanity check on the test itself)', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((filePath) => [path.basename(filePath), filePath] as const))(
    '%s imports no forbidden module',
    (_name: string, filePath: string) => {
      const source = fs.readFileSync(filePath, 'utf8');
      const specifiers = extractImportSpecifiers(source);
      const forbiddenHits = specifiers.filter((specifier) => FORBIDDEN_IMPORT_SPECIFIERS.includes(specifier));
      expect(forbiddenHits).toEqual([]);
    },
  );

  it.each(files.map((filePath) => [path.basename(filePath), filePath] as const))(
    '%s references no forbidden global (document/window/localStorage/...)',
    (_name: string, filePath: string) => {
      const source = fs.readFileSync(filePath, 'utf8');
      const hits = FORBIDDEN_GLOBAL_TOKENS.filter((token) => source.includes(token));
      expect(hits).toEqual([]);
    },
  );

  it('every import from @nova/* is limited to @nova/shared (no reaching into infrastructure/ui)', () => {
    const disallowedNovaImports = files.flatMap((filePath) => {
      const source = fs.readFileSync(filePath, 'utf8');
      return extractImportSpecifiers(source).filter(
        (specifier) => specifier.startsWith('@nova/') && specifier !== '@nova/shared',
      );
    });
    expect(disallowedNovaImports).toEqual([]);
  });
});
