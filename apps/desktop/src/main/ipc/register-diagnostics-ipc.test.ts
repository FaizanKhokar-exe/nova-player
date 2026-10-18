import { describe, expect, it, vi } from 'vitest';
import type { IpcContract } from '@nova/shared';
import { MAX_PING_NONCE_LENGTH, registerDiagnosticsIpc, validatePing } from './register-diagnostics-ipc.js';

type Handler = (event: unknown, request: unknown) => unknown;

function setup(options: { trusted?: boolean; spike?: boolean } = {}) {
  const handlers = new Map<string, Handler>();
  const checkDatabase = vi.fn((): IpcContract['diagnostics:checkDatabase']['response'] => ({
    ok: true,
    driver: 'better-sqlite3',
    sqliteVersion: '3.x',
    rowCountAfterInsert: 1,
    insertDurationMs: 0,
  }));
  const seek = vi.fn((): IpcContract['diagnostics:getSeekSpikeMediaUrl']['response'] => ({ url: 'nova-media://local/x', absolutePath: '/src/tests/fixtures/seek-spike.mp3' }));
  registerDiagnosticsIpc({
    registrar: { handle: (channel, listener) => void handlers.set(channel, listener as Handler) },
    isTrustedSender: () => options.trusted ?? true,
    checkDatabase,
    seekSpikeMediaUrl: options.spike === false ? undefined : seek,
    now: () => 1234,
  });
  return { call: (channel: string, request?: unknown) => handlers.get(channel)!({}, request), handlers, checkDatabase, seek };
}

describe('diagnostics IPC', () => {
  it('registers exactly the three Phase 0 channels', () => {
    expect([...setup().handlers.keys()].sort()).toEqual(['app:ping', 'diagnostics:checkDatabase', 'diagnostics:getSeekSpikeMediaUrl']);
  });

  it('ping echoes the nonce', () => {
    expect(setup().call('app:ping', { nonce: 'abc' })).toEqual({ nonce: 'abc', pong: true, receivedAtMs: 1234 });
  });

  it.each([undefined, null, 'abc', 5, [], { nonce: 5 }, { nonce: null }, {}, { nonce: 'a', extra: 1 }, { nonce: 'x'.repeat(MAX_PING_NONCE_LENGTH + 1) }])(
    'ping refuses the malformed request %j',
    (request) => {
      expect(() => setup().call('app:ping', request)).toThrow(/nonce|object|Unexpected field/);
    },
  );

  it('validatePing accepts the longest allowed nonce', () => {
    expect(validatePing({ nonce: 'x'.repeat(MAX_PING_NONCE_LENGTH) }).nonce).toHaveLength(MAX_PING_NONCE_LENGTH);
  });

  it('every channel refuses a call that did not come from the application window', () => {
    const { call, checkDatabase, seek } = setup({ trusted: false });
    for (const [channel, request] of [['app:ping', { nonce: 'a' }], ['diagnostics:checkDatabase', undefined], ['diagnostics:getSeekSpikeMediaUrl', undefined]] as const) {
      expect(() => call(channel, request), channel).toThrow(/application window/);
    }
    expect(checkDatabase).not.toHaveBeenCalled();
    expect(seek).not.toHaveBeenCalled();
  });

  it('the no-argument channels refuse smuggled data', () => {
    const { call } = setup();
    expect(() => call('diagnostics:checkDatabase', { sql: 'DROP TABLE tracks' })).toThrow(/no arguments/);
    expect(() => call('diagnostics:getSeekSpikeMediaUrl', 'x')).toThrow(/no arguments/);
  });

  it('the database check runs for the application window', () => {
    const { call, checkDatabase } = setup();
    expect(call('diagnostics:checkDatabase')).toMatchObject({ ok: true });
    expect(checkDatabase).toHaveBeenCalledTimes(1);
  });

  it('the spike channel returns its url in a development run', () => {
    expect(setup().call('diagnostics:getSeekSpikeMediaUrl')).toMatchObject({ url: 'nova-media://local/x' });
  });

  it('in a packaged app the spike channel refuses, and no path is returned', () => {
    const { call } = setup({ spike: false });
    let thrown: unknown;
    try {
      call('diagnostics:getSeekSpikeMediaUrl');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(String((thrown as Error).message)).toContain('not available');
    expect(String((thrown as Error).message)).not.toMatch(/[\\/]/);
  });
});
