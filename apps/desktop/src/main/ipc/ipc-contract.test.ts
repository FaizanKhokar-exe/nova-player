import type {
  AddRootResponse,
  IpcChannel,
  IpcErrorCode,
  IpcEventContract,
  IpcRequest,
  IpcResponse,
  IpcResult,
  ListTracksResponse,
  NovaBridge,
  ScanProgressDto,
  SearchTracksResponse,
  StartScanResponse,
  TrackDto,
} from '@nova/shared';
import { describe, expect, expectTypeOf, it } from 'vitest';

/**
 * Compile-time contract coverage: these assertions are checked by `tsc -b`
 * (and run as ordinary tests). If the contract drifts from what the handlers
 * and the renderer rely on, typecheck fails.
 */
describe('IPC contract types', () => {
  it('Phase 0 channels are preserved unchanged', () => {
    expectTypeOf<IpcRequest<'app:ping'>>().toEqualTypeOf<{ readonly nonce: string }>();
    expectTypeOf<IpcResponse<'app:ping'>>().toMatchTypeOf<{ readonly pong: true }>();
    expectTypeOf<IpcRequest<'diagnostics:checkDatabase'>>().toEqualTypeOf<void>();
    expectTypeOf<IpcResponse<'diagnostics:getSeekSpikeMediaUrl'>>().toMatchTypeOf<{ readonly url: string }>();
  });

  it('every library channel answers with an IpcResult', () => {
    type Library = Extract<IpcChannel, `library:${string}`>;
    expectTypeOf<IpcResponse<Library>>().toMatchTypeOf<IpcResult<unknown>>();
    expectTypeOf<IpcResponse<'library:startScan'>>().toEqualTypeOf<IpcResult<StartScanResponse>>();
    expectTypeOf<IpcResponse<'library:listTracks'>>().toEqualTypeOf<IpcResult<ListTracksResponse>>();
    expectTypeOf<IpcResponse<'library:search'>>().toEqualTypeOf<IpcResult<SearchTracksResponse>>();
    expectTypeOf<IpcResponse<'library:addRoot'>>().toEqualTypeOf<IpcResult<AddRootResponse>>();
  });

  it('requests have the intended shapes; addRoot takes NO path', () => {
    expectTypeOf<IpcRequest<'library:addRoot'>>().toEqualTypeOf<void>();
    expectTypeOf<IpcRequest<'library:removeRoot'>>().toEqualTypeOf<{ readonly rootId: string }>();
    expectTypeOf<IpcRequest<'library:startScan'>>().toEqualTypeOf<{ readonly rootId?: string }>();
    expectTypeOf<IpcRequest<'library:search'>>().toEqualTypeOf<{ readonly query: string; readonly limit?: number }>();
    expectTypeOf<IpcRequest<'library:cancelScan'>>().toEqualTypeOf<void>();
  });

  it('the bridge is invoke + subscribe, and subscribe is typed per event', () => {
    expectTypeOf<keyof NovaBridge>().toEqualTypeOf<'invoke' | 'subscribe'>();
    expectTypeOf<IpcEventContract['library:scanProgress']>().toEqualTypeOf<ScanProgressDto>();
    expectTypeOf<IpcEventContract['library:changed']>().toEqualTypeOf<{ readonly reason: 'scan' | 'watcher' | 'root-added' | 'root-removed' }>();
    expectTypeOf<keyof IpcEventContract>().toEqualTypeOf<
      'library:scanProgress' | 'library:scanFinished' | 'library:changed' | 'library:watcherStatus' | 'playback:stateChanged' | 'shell:command'
    >();
  });

  it('TrackDto carries no file path and no internal provenance', () => {
    expectTypeOf<keyof TrackDto>().toEqualTypeOf<
      'id' | 'title' | 'artist' | 'album' | 'albumArtist' | 'genre' | 'trackNumber' | 'discNumber' | 'year' | 'durationSeconds' | 'artwork'
    >();
  });

  it('is a discriminated result: `ok` selects the value or the error', () => {
    type Result = IpcResponse<'library:listRoots'>;
    expectTypeOf<Extract<Result, { ok: true }>['value']['roots']>().toMatchTypeOf<readonly unknown[]>();
    expectTypeOf<Extract<Result, { ok: false }>['error']['code']>().toMatchTypeOf<string>();
    expectTypeOf<Extract<Result, { ok: false }>['error']>().toEqualTypeOf<{
      readonly code: IpcErrorCode;
      readonly message: string;
      readonly operation: string;
    }>();
    expect(true).toBe(true);
  });
});
