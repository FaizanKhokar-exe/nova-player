import { createStore, type StoreApi } from 'zustand/vanilla';
import type { ArtworkDto, AttachLyricsResultDto, IpcResult, LyricLineDto, LyricsStatusDto, NovaBridge } from '@nova/shared';
import type { PlaybackStoreApi } from '../playback/playback-store.js';

/**
 * What the Now Playing view knows about the CURRENT track beyond its metadata: its lyrics and its
 * artwork. It owns no playback state and no queue: it only watches which track main says is current
 * (the playback store is the one authority for that) and asks main - through typed IPC - for the
 * track's lyrics and artwork. The renderer never sees a path; it names the track by id.
 *
 * Stale protection: a change of track resets both slices at once (the old track's lyrics and
 * artwork are never shown against the new one) and every answer carries the sequence number of the
 * request that asked, so a slow answer for a previous track is dropped.
 */

export type NowPlayingLyricsStatus = 'idle' | 'loading' | 'ready' | 'error';
export type NowPlayingArtworkStatus = 'idle' | 'loading' | 'found' | 'none' | 'error';

export interface LyricsSlice {
  readonly status: NowPlayingLyricsStatus;
  /** What main said about the sidecar, once `status` is `ready`. */
  readonly availability: LyricsStatusDto | undefined;
  readonly lines: readonly LyricLineDto[];
  readonly error: string | undefined;
  /** `true` when the listener attached these lyrics by hand (so they can be removed again). */
  readonly attached: boolean;
}

/** The state of the attach / remove lyrics buttons. `message` is a short, plain-language outcome. */
export interface LyricsActionSlice {
  readonly busy: boolean;
  readonly message: string | undefined;
}

export interface ArtworkSlice {
  readonly status: NowPlayingArtworkStatus;
  readonly dataUrl: string | undefined;
  /** `true` when the picture is one the listener attached by hand (it can be removed again). */
  readonly custom?: boolean;
}

export interface NowPlayingState {
  /** The track the slices below belong to. */
  readonly trackId: string | undefined;
  readonly lyrics: LyricsSlice;
  readonly artwork: ArtworkSlice;
  readonly lyricsAction: LyricsActionSlice;
  /** Starts following the playback store; reference-counted like the other stores. */
  connect(): () => void;
  /** Asks again for the current track's lyrics (the "Try again" button). */
  retryLyrics(): void;
  /** Quietly re-reads the current track's lyrics and updates the screen only if they changed (the .lrc file was edited). No loading flicker. */
  refreshLyrics(): Promise<void>;
  /** Lets the listener pick a picture (the dialog is in main) to use as this track's cover. Resolves with a short plain-language outcome to show, or undefined. */
  attachArtwork(): Promise<string | undefined>;
  /** Removes a cover the listener attached. */
  detachArtwork(): Promise<void>;
  /** Lets the listener pick a `.lrc` file (the dialog is in main) to use as this track's lyrics. */
  attachLyrics(): Promise<void>;
  /** Removes lyrics the listener attached, returning to the `.lrc` beside the track (if any). */
  detachLyrics(): Promise<void>;
  dismissLyricsMessage(): void;
}

export type NowPlayingStoreApi = StoreApi<NowPlayingState>;

const IDLE_LYRICS: LyricsSlice = { status: 'idle', availability: undefined, lines: [], error: undefined, attached: false };
const IDLE_ACTION: LyricsActionSlice = { busy: false, message: undefined };
const IDLE_ARTWORK: ArtworkSlice = { status: 'idle', dataUrl: undefined };
const ATTACH_MESSAGES = {
  cancelled: undefined,
  empty: 'That file has no timed lines (like [01:23.45] text), so nothing was attached.',
  unreadable: 'That file couldn’t be read.',
  'too-large': 'That file is too large to be a lyrics file (limit 1 MB).',
  unavailable: 'Lyrics can’t be attached right now - the track’s folder can’t be reached.',
} as const;
const ARTWORK_MESSAGES = {
  cancelled: undefined,
  'not-an-image': 'That file isn’t a JPEG, PNG or WebP picture.',
  unreadable: 'That picture couldn’t be read.',
  'too-large': 'That picture is too large (limit 5 MB).',
  unavailable: 'A cover can’t be attached right now - the track’s folder can’t be reached.',
} as const;
const UNREACHABLE = 'Could not reach the application. Try restarting Nova Player.';

export function createNowPlayingStore(bridge: NovaBridge, playback: PlaybackStoreApi): NowPlayingStoreApi {
  let connections = 0;
  let unsubscribe: (() => void) | undefined;
  let lyricsSequence = 0;
  let artworkSequence = 0;
  let lyricsKey: string | undefined;
  let artworkKey: string | undefined;

  async function call(channel: 'track:getLyrics' | 'track:getArtwork' | 'track:attachLyrics' | 'track:detachLyrics' | 'track:attachArtwork' | 'track:detachArtwork', trackId: string): Promise<IpcResult<unknown> | undefined> {
    try {
      return (await bridge.invoke(channel, { trackId })) as IpcResult<unknown>;
    } catch {
      return undefined;
    }
  }

  return createStore<NowPlayingState>((set, get) => {
    async function loadLyrics(trackId: string): Promise<void> {
      const sequence = ++lyricsSequence;
      set({ lyrics: { ...IDLE_LYRICS, status: 'loading' } });
      const result = await call('track:getLyrics', trackId);
      if (sequence !== lyricsSequence) return; // the track changed while this was in flight
      if (result?.ok === true) {
        const value = result.value as { status: LyricsStatusDto; lines: readonly LyricLineDto[]; attached?: true };
        set({ lyrics: { status: 'ready', availability: value.status, lines: value.lines, error: undefined, attached: value.attached === true } });
      } else {
        // A failed lookup never touches playback; the panel says so quietly and offers a retry.
        set({ lyrics: { ...IDLE_LYRICS, status: 'error', error: result === undefined ? UNREACHABLE : result.error.message } });
      }
    }

    async function loadArtwork(trackId: string): Promise<void> {
      const sequence = ++artworkSequence;
      set({ artwork: { status: 'loading', dataUrl: undefined } });
      const result = await call('track:getArtwork', trackId);
      if (sequence !== artworkSequence) return;
      if (result?.ok === true) {
        const value = result.value as ArtworkDto;
        set({ artwork: value.status === 'found' && value.dataUrl !== undefined ? { status: 'found', dataUrl: value.dataUrl, ...(value.custom === true && { custom: true }) } : { status: 'none', dataUrl: undefined } });
      } else {
        set({ artwork: { status: 'error', dataUrl: undefined } });
      }
    }

    /** Called with the playback store's current track (or none). Only a real change does any work. */
    function follow(track: { readonly id: string; readonly artwork: string } | undefined): void {
      const id = track?.id;
      if (id !== lyricsKey) {
        lyricsKey = id;
        lyricsSequence += 1; // invalidate anything in flight for the previous track
        set({ trackId: id, lyrics: IDLE_LYRICS, lyricsAction: IDLE_ACTION });
        if (id !== undefined) void loadLyrics(id);
      }
      const nextArtworkKey = track === undefined ? undefined : `${track.id}:${track.artwork}`;
      if (nextArtworkKey !== artworkKey) {
        artworkKey = nextArtworkKey;
        artworkSequence += 1;
        if (track === undefined) set({ artwork: IDLE_ARTWORK });
        else void loadArtwork(track.id); // always asked: a folder cover or a picture the listener attached may exist even when the file has none embedded
      }
    }

    return {
      trackId: undefined,
      lyrics: IDLE_LYRICS,
      artwork: IDLE_ARTWORK,
      lyricsAction: IDLE_ACTION,

      connect() {
        connections += 1;
        if (connections === 1) {
          follow(playback.getState().session?.current?.track);
          unsubscribe = playback.subscribe((state) => follow(state.session?.current?.track));
        }
        let released = false;
        return () => {
          if (released) return;
          released = true;
          connections -= 1;
          if (connections === 0) {
            unsubscribe?.();
            unsubscribe = undefined;
            lyricsSequence += 1;
            artworkSequence += 1;
            lyricsKey = undefined;
            artworkKey = undefined;
            set({ trackId: undefined, lyrics: IDLE_LYRICS, artwork: IDLE_ARTWORK, lyricsAction: IDLE_ACTION });
          }
        };
      },

      retryLyrics() {
        const id = get().trackId;
        if (id !== undefined) void loadLyrics(id);
      },

      async refreshLyrics() {
        const id = get().trackId;
        if (id === undefined || get().lyrics.status !== 'ready') return;
        const result = await call('track:getLyrics', id);
        if (get().trackId !== id || result?.ok !== true) return;
        const value = result.value as { status: LyricsStatusDto; lines: readonly LyricLineDto[]; attached?: true };
        const current = get().lyrics;
        const same = current.availability === value.status && current.attached === (value.attached === true) && current.lines.length === value.lines.length && current.lines.every((line, i) => line.timeMs === value.lines[i]?.timeMs && line.text === value.lines[i]?.text);
        if (!same) set({ lyrics: { status: 'ready', availability: value.status, lines: value.lines, error: undefined, attached: value.attached === true } });
      },

      async attachArtwork() {
        const id = get().trackId;
        if (id === undefined) return undefined;
        const result = await call('track:attachArtwork', id);
        if (result?.ok !== true) return 'Couldn’t attach a picture right now. Try again.';
        const outcome = (result.value as { outcome: keyof typeof ARTWORK_MESSAGES | 'attached' }).outcome;
        if (outcome === 'attached') {
          if (get().trackId === id) void loadArtwork(id);
          return undefined;
        }
        return ARTWORK_MESSAGES[outcome];
      },

      async detachArtwork() {
        const id = get().trackId;
        if (id === undefined) return;
        const result = await call('track:detachArtwork', id);
        if (result?.ok === true && get().trackId === id) void loadArtwork(id);
      },

      async attachLyrics() {
        const id = get().trackId;
        if (id === undefined || get().lyricsAction.busy) return;
        set({ lyricsAction: { busy: true, message: undefined } });
        const result = await call('track:attachLyrics', id);
        if (get().trackId !== id) return; // the track changed while the dialog was open
        if (result?.ok !== true) {
          set({ lyricsAction: { busy: false, message: 'Couldn’t attach lyrics right now. Try again.' } });
          return;
        }
        const value = result.value as AttachLyricsResultDto;
        if (value.outcome === 'attached') {
          lyricsSequence += 1;
          const lyrics = value.lyrics;
          set({ lyrics: { status: 'ready', availability: lyrics.status, lines: lyrics.lines, error: undefined, attached: lyrics.attached === true }, lyricsAction: IDLE_ACTION });
          return;
        }
        set({ lyricsAction: { busy: false, message: ATTACH_MESSAGES[value.outcome] } });
      },

      async detachLyrics() {
        const id = get().trackId;
        if (id === undefined || get().lyricsAction.busy) return;
        set({ lyricsAction: { busy: true, message: undefined } });
        const result = await call('track:detachLyrics', id);
        if (get().trackId !== id) return;
        set({ lyricsAction: result?.ok === true ? IDLE_ACTION : { busy: false, message: 'Couldn’t remove the lyrics right now. Try again.' } });
        if (result?.ok === true) await loadLyrics(id); // fall back to whatever sits beside the track
      },

      dismissLyricsMessage() {
        set({ lyricsAction: IDLE_ACTION });
      },
    };
  });
}
