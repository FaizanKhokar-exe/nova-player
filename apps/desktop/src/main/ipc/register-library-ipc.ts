import type { LibraryApplication, LibraryApplicationEvent } from '@nova/infrastructure';
import type { IpcEventChannel, IpcEventPayload, IpcResponse, IpcResult, LibraryIpcContract } from '@nova/shared';
import {
  toRootDto,
  toScanProgressDto,
  toScanResultDto,
  toScanStateDto,
  toSearchResultDto,
  toTrackDto,
  toWatcherStatusDto,
} from './dto-mappers.js';
import { ForbiddenSenderError, toIpcError } from './ipc-errors.js';
import { validateGetGroup, validateListGroups } from './browse-validation.js';
import { toGroupDto, toLibrarySummaryDto } from './browse-dto-mappers.js';
import { validateListTracks, validateNoRequest, validateRemoveRoot, validateSearch, validateStartScan } from './validation.js';

/** The slice of `ipcMain` the handlers need. A thin adapter in main/index.ts
 *  supplies the real one; tests supply a fake - so nothing here imports Electron. */
export interface IpcRegistrar {
  handle(channel: string, listener: (event: unknown, request: unknown) => unknown): void;
}

export interface LibraryIpcDependencies {
  readonly registrar: IpcRegistrar;
  /** The one application service the handlers orchestrate. */
  readonly application: LibraryApplication;
  /** Shows the OS folder picker; resolves the chosen folder, or `undefined` if cancelled. */
  readonly pickFolder: () => Promise<string | undefined>;
  /** Whether a call came from the application's own window. */
  readonly isTrustedSender: (event: unknown) => boolean;
  /** Where unexpected errors go (the main-process log). Never the renderer. */
  readonly log: (message: string, error: unknown) => void;
}

type LibraryChannel = keyof LibraryIpcContract;
type Value<K extends LibraryChannel> = Extract<IpcResponse<K>, { ok: true }>['value'];

/**
 * Registers every `library:*` channel. A handler does exactly four things:
 * check the sender, validate the request, call the application service, and
 * map the result to a DTO. There is no business logic here, and no second
 * service graph - everything goes through the one `LibraryApplication`.
 */
export function registerLibraryIpc(dependencies: LibraryIpcDependencies): void {
  const { registrar, application, pickFolder, isTrustedSender, log } = dependencies;

  function register<K extends LibraryChannel, R>(
    channel: K,
    validate: (raw: unknown) => R,
    run: (request: R) => Promise<Value<K>> | Value<K>,
  ): void {
    registrar.handle(channel, async (event, raw): Promise<IpcResult<Value<K>>> => {
      try {
        if (!isTrustedSender(event)) throw new ForbiddenSenderError();
        const request = validate(raw);
        return { ok: true, value: await run(request) };
      } catch (error) {
        return { ok: false, error: toIpcError(error, channel, log) };
      }
    });
  }

  register('library:listRoots', validateNoRequest, async () => ({
    roots: (await application.listRoots()).map(toRootDto),
  }));

  register('library:addRoot', validateNoRequest, async () => {
    const folder = await pickFolder();
    if (folder === undefined) return { outcome: 'cancelled' as const };
    return { outcome: 'added' as const, root: toRootDto(await application.addRoot(folder)) };
  });

  register('library:removeRoot', validateRemoveRoot, (request) => application.removeRoot(request.rootId));

  register('library:startScan', validateStartScan, (request) =>
    application.startScan(request.rootId === undefined ? {} : { rootId: request.rootId }),
  );

  register('library:cancelScan', validateNoRequest, () => ({ cancelled: application.cancelScan() }));

  register('library:getScanState', validateNoRequest, () => toScanStateDto(application.getScanState()));

  register('library:listTracks', validateListTracks, ({ offset, limit, sort }) => {
    const all = application.listTracks(sort);
    const page = limit === undefined ? all.slice(offset) : all.slice(offset, offset + limit);
    return { total: all.length, offset, tracks: page.map(toTrackDto) };
  });

  register('library:search', validateSearch, ({ query, limit }) => {
    const all = application.searchTracks(query);
    return { query, total: all.length, results: all.slice(0, limit).map(toSearchResultDto) };
  });

  register('library:getSummary', validateNoRequest, () => toLibrarySummaryDto(application.getSummary()));

  register('library:listGroups', validateListGroups, ({ kind }) => ({ kind, groups: application.listGroups(kind).map(toGroupDto) }));

  register('library:getGroup', validateGetGroup, ({ kind, key, sort }) => {
    const { group, tracks } = application.getGroup(kind, key, sort);
    return { group: toGroupDto(group), tracks: tracks.map(toTrackDto) };
  });

  register('library:startWatching', validateNoRequest, async () => toWatcherStatusDto(await application.startWatching()));
  register('library:stopWatching', validateNoRequest, async () => toWatcherStatusDto(await application.stopWatching()));
  register('library:getWatcherStatus', validateNoRequest, () => toWatcherStatusDto(application.getWatcherStatus()));
}

/** Sends one event to the renderer(s). The real implementation lives in main/index.ts. */
export type PublishEvent = <E extends IpcEventChannel>(channel: E, payload: IpcEventPayload<E>) => void;

/**
 * Forwards the application layer's events to the renderer as DTOs, one
 * `IpcEventContract` channel each. Returns the unsubscribe function.
 */
export function bridgeApplicationEvents(application: LibraryApplication, publish: PublishEvent): () => void {
  return application.subscribe((event: LibraryApplicationEvent) => {
    switch (event.type) {
      case 'scan-progress':
        publish('library:scanProgress', toScanProgressDto(event.progress));
        break;
      case 'scan-finished':
        publish('library:scanFinished', toScanResultDto(event.result));
        break;
      case 'library-changed':
        publish('library:changed', { reason: event.reason });
        break;
      case 'watcher-status':
        publish('library:watcherStatus', toWatcherStatusDto(event.status));
        break;
    }
  });
}
