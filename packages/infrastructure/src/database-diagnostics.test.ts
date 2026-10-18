import { describe, expect, it } from 'vitest';
import { runDatabaseDiagnostics } from './database-diagnostics.js';

describe('runDatabaseDiagnostics', () => {
  it('inserts and counts rows successfully via better-sqlite3', () => {
    const result = runDatabaseDiagnostics();
    expect(result.ok).toBe(true);
    expect(result.driver).toBe('better-sqlite3');
    expect(result.rowCountAfterInsert).toBe(5000);
    expect(result.error).toBeUndefined();
  });
});
