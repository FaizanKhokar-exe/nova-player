import type { LyricsProvider, PlaybackApplication, PlaybackApplicationEvent, TrackSidecars } from '@nova/infrastructure';
import type { IpcResult, PlaybackIpcContract, UpdateStatusDto } from '@nova/shared';
import type { UpdateService } from '../updater/update-service.js';
import { toQueueDto } from './browse-dto-mappers.js';
import {
  validateEnqueue,
  validateGetQueue,
  validateMoveQueueItem,
  validatePlayGroup,
  validateQueueItem,
} from './browse-validation.js';
import { toMediaProblemDto, toPlaybackCommandResultDto, toPlaybackStateDto } from './playback-dto-mappers.js';
import { ForbiddenSenderError, toIpcError } from './ipc-errors.js';
import type { IpcRegistrar, PublishEvent } from './register-library-ipc.js';
import { validateNoRequest } from './validation.js';
import {
  validateDiagnoseSource,
  validateLyricsSearch,
  validateEditTrackInfo,
  validateSaveLyrics,
  validatePlayTrack,
  validatePositioned,
  validateReportPosition,
  validateSetRepeatMode,
  validateSetShuffle,
  validateTrackFinished,
  validateTrackRef,
} from './playback-validation.js';

export interface PlaybackIpcDependencies {
  readonly registrar: IpcRegistrar;
  /** The one playback service the handlers orchestrate. */
  readonly application: PlaybackApplication;
  /** Lyrics and artwork for a track, found behind the same media-access checks as the audio. */
  readonly sidecars: TrackSidecars;
  /** Removes solid bars from a cover for display (returns undefined when there is nothing to remove). */
  readonly trimCover?: (bytes: Uint8Array) => Uint8Array | undefined;
  /** The native "choose a lyrics file" dialog: the chosen path, or `undefined` when the listener cancelled. The renderer never supplies a path. */
  readonly pickLyricsFile: () => Promise<string | undefined>;
  /** The native "choose a picture" dialog for a track's cover (v0.11.3): the chosen path, or `undefined` when cancelled. */
  readonly pickArtworkFile: () => Promise<string | undefined>;
  /** A track's cover was attached or removed: cached thumbnails must forget which tracks have covers. */
  readonly onArtworkChanged: () => void;
  /** v0.15.0: store (or clear, with `undefined`) the listener's own names for a track. Returns false when the track is unknown. Main then tells the window to refresh. */
  /** v0.15.2: app updates (absent in tests = unsupported). */
  readonly updates?: UpdateService;
  readonly editTrackInfo?: (trackId: string, edit: { readonly title: string; readonly artist: string; readonly album?: string } | undefined) => 'done' | 'nothing' | 'unknown';
  /** v0.12.0: what the library knows about a track (to search by), or `undefined` for an unknown id. */
  readonly describeTrack: (trackId: string) => { readonly title: string; readonly artist: string; readonly album?: string; readonly durationSec?: number } | undefined;
  /** v0.12.0: the online lyrics-text provider, or `undefined` when this build has none. */
  readonly lyricsProvider?: LyricsProvider;
  /** Whether a call came from the application's own window. */
  readonly isTrustedSender: (event: unknown) => boolean;
  /** Where unexpected errors go (the main-process log). Never the renderer. */
  readonly log: (message: string, error: unknown) => void;
}

type PlaybackChannel = keyof PlaybackIpcContract;
type Value<K extends PlaybackChannel> = Extract<PlaybackIpcContract[K]['response'], { ok: true }>['value'];

/**
 * Registers every `playback:*` channel. Exactly the library handlers' shape:
 * check the sender, validate the request, call the application service, map
 * the result to a DTO. No business rule lives here - the queue rules run in
 * the domain, behind `PlaybackApplication`.
 */
export function registerPlaybackIpc(dependencies: PlaybackIpcDependencies): void {
  const { registrar, application, sidecars, trimCover, pickLyricsFile, pickArtworkFile, onArtworkChanged, editTrackInfo, updates, describeTrack, lyricsProvider, isTrustedSender, log } = dependencies;

  function register<K extends PlaybackChannel, R>(
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

  register('playback:getState', validateNoRequest, () => toPlaybackStateDto(application.getState()));

  register('playback:playTrack', validatePlayTrack, (request) =>
    toPlaybackCommandResultDto(application.playTrack(request.context === undefined ? { trackId: request.trackId } : { trackId: request.trackId, context: request.context })),
  );

  register('playback:next', validatePositioned, (request) => toPlaybackCommandResultDto(application.next(request.positionMs)));
  register('playback:previous', validatePositioned, (request) => toPlaybackCommandResultDto(application.previous(request.positionMs)));
  register('playback:trackFinished', validateTrackFinished, (request) => toPlaybackCommandResultDto(application.trackFinished(request.trackId)));

  register('playback:setRepeatMode', validateSetRepeatMode, (request) => toPlaybackStateDto(application.setRepeatMode(request.mode)));
  register('playback:setShuffle', validateSetShuffle, (request) => toPlaybackStateDto(application.setShuffle(request.enabled)));

  register('playback:reportPosition', validateReportPosition, (request) => application.reportPosition(request.trackId, request.positionMs));

  register('playback:playGroup', validatePlayGroup, (request) =>
    toPlaybackCommandResultDto(application.playGroup(request.sort === undefined ? { group: request.group } : { group: request.group, sort: request.sort })),
  );

  register('playback:enqueue', validateEnqueue, (request) =>
    toPlaybackCommandResultDto(
      application.enqueue({
        position: request.position,
        ...(request.trackId !== undefined && { trackId: request.trackId }),
        ...(request.group !== undefined && { group: request.group }),
        ...(request.source !== undefined && { source: request.source }),
      }),
    ),
  );

  register('playback:getQueue', validateGetQueue, (request) => toQueueDto(application.getQueue(request)));

  register('playback:playQueueItem', validateQueueItem, (request) => toPlaybackCommandResultDto(application.playQueueItem(request.index, request.trackId)));
  register('playback:removeFromQueue', validateQueueItem, (request) => toPlaybackCommandResultDto(application.removeFromQueue(request.index, request.trackId)));
  register('playback:moveQueueItem', validateMoveQueueItem, (request) =>
    toPlaybackCommandResultDto(application.moveQueueItem(request.index, request.trackId, request.toIndex)),
  );
  register('playback:clearQueue', validateNoRequest, () => toPlaybackCommandResultDto(application.clearQueue()));

  // Phase 6. Each answer is a status plus data; "no lyrics" and "no artwork" are answers, not errors.
  register('track:getLyrics', validateTrackRef, async ({ trackId }) => {
    const result = await sidecars.getLyrics(trackId);
    return {
      status: result.status,
      lines: result.lines.map((line) => ({ timeMs: line.timeMs, text: line.text })),
      ...(result.status === 'found' && result.attached === true && { attached: true as const }),
    };
  });

  // Attach a lyrics file by hand. Order matters: the track is checked BEFORE the dialog opens (an unknown id is
  // refused without bothering the listener), and the dialog is main's own - the renderer names only the track.
  register('track:attachLyrics', validateTrackRef, async ({ trackId }) => {
    const known = await sidecars.getLyrics(trackId); // throws invalid-id / track-not-found before any dialog
    if (known.status === 'unavailable') return { outcome: 'unavailable' };
    const filePath = await pickLyricsFile();
    if (filePath === undefined) return { outcome: 'cancelled' };
    const result = await sidecars.attachLyricsFromFile(trackId, filePath);
    if (result.outcome !== 'attached') return { outcome: result.outcome };
    return { outcome: 'attached', lyrics: { status: 'found', lines: result.lines.map((line) => ({ timeMs: line.timeMs, text: line.text })), attached: true } };
  });

  register('track:detachLyrics', validateTrackRef, async ({ trackId }) => ({ removed: await sidecars.detachLyrics(trackId) }));

  register('track:getArtwork', validateTrackRef, async ({ trackId }) => {
    const result = await sidecars.getArtwork(trackId);
    if (result.status !== 'found') return { status: result.status };
    const trimmed = trimCover?.(result.bytes);
    const [mime, bytes] = trimmed === undefined ? [result.mimeType, result.bytes] : ['image/jpeg', trimmed];
    return { status: 'found', dataUrl: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`, ...(result.custom === true && { custom: true as const }) };
  });

  // Attach a cover picture by hand (v0.11.3). Same order as lyrics: the track is checked BEFORE the dialog opens; the dialog is main's own.
  register('track:attachArtwork', validateTrackRef, async ({ trackId }) => {
    const known = await sidecars.getArtwork(trackId); // throws invalid-id / track-not-found before any dialog
    if (known.status === 'unavailable') return { outcome: 'unavailable' };
    const filePath = await pickArtworkFile();
    if (filePath === undefined) return { outcome: 'cancelled' };
    const result = await sidecars.attachArtworkFromFile(trackId, filePath);
    if (result.outcome === 'attached') onArtworkChanged();
    return { outcome: result.outcome };
  });

  register('track:detachArtwork', validateTrackRef, async ({ trackId }) => {
    const removed = await sidecars.detachArtwork(trackId);
    if (removed) onArtworkChanged();
    return { removed };
  });

  register('track:editInfo', validateEditTrackInfo, ({ trackId, title, artist, album }) => {
    if (title === '' || artist === '') return { outcome: 'invalid' as const };
    const result = editTrackInfo?.(trackId, { title, artist, ...(album !== undefined && { album }) });
    return { outcome: result === 'done' ? ('saved' as const) : ('unknown' as const) };
  });
  register('track:resetInfo', validateTrackRef, ({ trackId }) => {
    const result = editTrackInfo?.(trackId, undefined) ?? 'unknown';
    return { outcome: result === 'done' ? ('reset' as const) : result === 'nothing' ? ('nothing-to-reset' as const) : ('unknown' as const) };
  });

  const noUpdates: UpdateStatusDto = { state: 'unsupported', currentVersion: '0.0.0' };
  register('update:getStatus', validateNoRequest, () => (updates?.getStatus() ?? noUpdates));
  register('update:check', validateNoRequest, () => (updates?.check() ?? noUpdates));
  register('update:download', validateNoRequest, () => (updates?.download() ?? noUpdates));
  register('update:install', validateNoRequest, () => (updates?.install() ?? noUpdates));

  // v0.12.0 Lyric Studio. The search sends only the tags (or the listener's correction) of ONE known track.
  register('lyrics:search', validateLyricsSearch, async ({ trackId, title, artist }) => {
    const known = describeTrack(trackId);
    if (known === undefined) {
      await sidecars.getLyrics(trackId); // throws the right invalid-id / track-not-found error
      return { status: 'error', title: '', artist: '', candidates: [] };
    }
    const query = {
      title: title !== undefined && title !== '' ? title : known.title,
      artist: artist !== undefined ? artist : known.artist,
      ...(known.album !== undefined && { album: known.album }),
      ...(known.durationSec !== undefined && { durationSec: known.durationSec }),
    };
    if (lyricsProvider === undefined) return { status: 'unavailable', title: query.title, artist: query.artist, candidates: [] };
    const result = await lyricsProvider.search(query);
    return { status: result.status, title: query.title, artist: query.artist, candidates: result.candidates };
  });

  register('lyrics:save', validateSaveLyrics, async ({ trackId, lrc }) => {
    const result = await sidecars.saveLrc(trackId, lrc);
    return { outcome: result.outcome };
  });

  register('playback:diagnoseSource', validateDiagnoseSource, async (request) => {
    const denial = await application.diagnoseSource(request.trackId);
    return denial === undefined ? {} : { problem: toMediaProblemDto(denial) };
  });
}

/** Forwards the playback service's own state changes to the renderer as DTOs. Returns the unsubscribe function. */
export function bridgePlaybackEvents(application: PlaybackApplication, publish: PublishEvent): () => void {
  return application.subscribe((event: PlaybackApplicationEvent) => {
    if (event.type !== 'state-changed') return; // `track-started` is for the desktop shell, not the renderer
    publish('playback:stateChanged', { reason: event.reason, state: toPlaybackStateDto(event.state) });
  });
}
