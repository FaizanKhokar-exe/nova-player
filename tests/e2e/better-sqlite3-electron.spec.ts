import { test, expect } from '@playwright/test';
import { launchApp } from './helpers.js';

test('better-sqlite3 works inside the actual Electron main process', async () => {
  const { app, window } = await launchApp();

  const result = await window.evaluate(() => window.nova.invoke('diagnostics:checkDatabase', undefined));

  expect(result.ok).toBe(true);
  expect(result.driver).toBe('better-sqlite3');
  expect(result.rowCountAfterInsert).toBe(5000);
  expect(result.sqliteVersion).toMatch(/^\d+\.\d+\.\d+$/);
  expect(result.error).toBeUndefined();

  await app.close();
});
