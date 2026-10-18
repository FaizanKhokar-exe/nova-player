import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Creates a unique temp directory for one test's database files. */
export function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nova-db-test-'));
}

export function removeDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}
