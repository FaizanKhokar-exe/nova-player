import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { formatRemaining, SLEEP_CHOICES_MINUTES } from '../audio/audio-controls.js';
import { useCollections } from '../collections/CollectionsStoreProvider.js';
import { usePlaybackStore } from '../playback/PlaybackStoreProvider.js';
import { SPEEDS } from '../prefs/prefs-store.js';
import { Icon } from '../theme/Icon.js';
import { useAudioControls, usePrefs, useServices, useUi } from './services.js';
import type { MenuItem, OpenMenu } from './ui-store.js';

/* ------------------------------ context menu ------------------------------ */

function useDismiss(active: boolean, close: () => void, ref: React.RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!active) return;
    const onPointer = (event: PointerEvent): void => {
      if (ref.current !== null && !ref.current.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
      }
    };
    const onBlur = (): void => close();
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('resize', onBlur);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', onBlur);
    };
  }, [active, close, ref]);
}

const menuIds = new WeakMap<object, number>();
let nextMenuId = 0;

/** The open context menu. Each opened menu gets a fresh panel (its own submenu stack and position). */
export function ContextMenuLayer() {
  const menu = useUi((s) => s.menu);
  if (menu === undefined) return null;
  let id = menuIds.get(menu);
  if (id === undefined) menuIds.set(menu, (id = nextMenuId++));
  return <MenuPanel key={id} menu={menu} />;
}

function MenuPanel({ menu }: { menu: OpenMenu }) {
  const { ui } = useServices();
  const ref = useRef<HTMLDivElement | null>(null);
  const [stack, setStack] = useState<ReadonlyArray<{ title: string; items: readonly MenuItem[] }>>([]);
  const [position, setPosition] = useState<{ left: number; top: number } | undefined>(undefined);
  const close = useCallback(() => ui.getState().closeMenu(), [ui]);
  useDismiss(true, close, ref);

  // Keep the menu inside the window: flip left / up when it would overflow.
  useLayoutEffect(() => {
    if (ref.current === null) return;
    const rect = ref.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(menu.x, window.innerWidth - rect.width - 8));
    const top = Math.max(8, menu.y + rect.height > window.innerHeight - 8 ? Math.max(8, menu.y - rect.height) : menu.y);
    setPosition((previous) => (previous?.left === left && previous.top === top ? previous : { left, top }));
  }, [menu, stack]);

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
  }, [stack]);

  const level = stack.at(-1);
  const items = level?.items ?? menu.items;

  const onKeyDown = (event: ReactKeyboardEvent): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const buttons = [...(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLElement);
    const next = event.key === 'ArrowDown' ? (index + 1) % buttons.length : (index - 1 + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  const style: CSSProperties = { left: position?.left ?? menu.x, top: position?.top ?? menu.y, visibility: position === undefined ? 'hidden' : 'visible' };
  return (
    <div ref={ref} className="nx-menu" role="menu" aria-label="Actions" data-testid="context-menu" style={style} onKeyDown={onKeyDown} onContextMenu={(event) => event.preventDefault()}>
      {level !== undefined && (
        <button type="button" className="nx-menu-item" onClick={() => setStack((s) => s.slice(0, -1))}>
          <Icon name="chevronLeft" size={16} />
          <span>{level.title}</span>
        </button>
      )}
      {level !== undefined && <div className="nx-menu-sep" />}
      {items.map((item, index) => {
        if (item.kind === 'sep') return <div key={`sep-${index}`} className="nx-menu-sep" role="separator" />;
        if (item.kind === 'title') return <div key={`title-${index}`} className="nx-menu-title">{item.label}</div>;
        if (item.kind === 'submenu') {
          return (
            <button key={item.id} type="button" role="menuitem" className="nx-menu-item" onClick={() => setStack((s) => [...s, { title: item.label, items: item.build() }])}>
              {item.icon !== undefined && <Icon name={item.icon} size={17} />}
              <span className="nx-ellipsis">{item.label}</span>
              <span className="nx-menu-hint"><Icon name="chevronRight" size={15} /></span>
            </button>
          );
        }
        return (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            className="nx-menu-item"
            data-danger={item.danger === true ? 'true' : undefined}
            disabled={item.disabled === true}
            onClick={() => {
              close();
              item.run();
            }}
          >
            {item.icon !== undefined && <Icon name={item.icon} size={17} />}
            <span className="nx-ellipsis nx-text">{item.label}</span>
            {item.hint !== undefined && <span className="nx-menu-hint">{item.hint}</span>}
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------ dialogs ------------------------------ */

function Dialog({ title, children, onClose, label }: { title: string; children: React.ReactNode; onClose: () => void; label: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input, button')?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="nx-scrim" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={ref} className="nx-modal" role="dialog" aria-modal="true" aria-label={label} data-testid="dialog">
        <h2 className="nx-h2">{title}</h2>
        {children}
      </div>
    </div>
  );
}

function NameDialog({ title, label, initial, confirmLabel, onSubmit, onClose }: { title: string; label: string; initial: string; confirmLabel: string; onSubmit: (name: string) => Promise<void> | void; onClose: () => void }) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const trimmed = name.trim();
  return (
    <Dialog title={title} onClose={onClose} label={title}>
      <form
        style={{ display: 'contents' }}
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmed === '' || busy) return;
          setBusy(true);
          void Promise.resolve(onSubmit(trimmed)).finally(onClose);
        }}
      >
        <label className="nx-field">
          <span className="nx-muted">{label}</span>
          <input className="nx-input nx-text" value={name} maxLength={80} placeholder="My playlist" onChange={(event) => setName(event.target.value)} autoComplete="off" spellCheck={false} />
        </label>
        <div className="nx-modal-actions">
          <button type="button" className="nx-btn nx-btn--ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="nx-btn nx-btn--primary" disabled={trimmed === '' || busy}>{confirmLabel}</button>
        </div>
      </form>
    </Dialog>
  );
}

export function ModalLayer() {
  const modal = useUi((s) => s.modal);
  const { ui, collections } = useServices();
  const playlists = useCollections((s) => s.playlists.items);
  const close = useCallback(() => ui.getState().closeModal(), [ui]);
  if (modal === undefined) return null;

  if (modal.kind === 'create-playlist') {
    return (
      <NameDialog
        title="New playlist"
        label="Name"
        initial=""
        confirmLabel="Create"
        onClose={close}
        onSubmit={async (name) => {
          await collections.getState().createPlaylist(name, modal.trackIds.length > 0 ? modal.trackIds : undefined);
        }}
      />
    );
  }
  if (modal.kind === 'rename-playlist') {
    return <NameDialog title="Rename playlist" label="Name" initial={modal.playlist.name} confirmLabel="Save" onClose={close} onSubmit={async (name) => void (await collections.getState().renamePlaylist(modal.playlist.id, name))} />;
  }
  if (modal.kind === 'confirm') {
    return (
      <Dialog title={modal.title} onClose={close} label={modal.title}>
        <p className="nx-muted" style={{ margin: 0 }}>{modal.body}</p>
        <div className="nx-modal-actions">
          <button type="button" className="nx-btn nx-btn--ghost" onClick={close}>Cancel</button>
          <button
            type="button"
            className={`nx-btn ${modal.danger === true ? 'nx-btn--danger' : 'nx-btn--primary'}`}
            onClick={() => {
              close();
              modal.onConfirm();
            }}
          >
            {modal.confirmLabel}
          </button>
        </div>
      </Dialog>
    );
  }
  if (modal.kind === 'edit-info') {
    return (
      <Dialog title="Edit song info" onClose={close} label="Edit song info">
        <EditInfoForm track={modal.track} onClose={close} />
      </Dialog>
    );
  }
  // add-to-playlist
  return (
    <Dialog title="Add to playlist" onClose={close} label="Add to playlist">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 320, overflowY: 'auto' }}>
        <button type="button" className="nx-menu-item" onClick={() => ui.getState().openModal({ kind: 'create-playlist', trackIds: modal.trackIds })}>
          <Icon name="plus" size={17} /> New playlist…
        </button>
        {playlists.map((list) => (
          <button
            key={list.id}
            type="button"
            className="nx-menu-item"
            onClick={() => {
              close();
              void collections.getState().addToPlaylist(list.id, modal.trackIds, list.name);
            }}
          >
            <Icon name="playlist" size={17} />
            <span className="nx-ellipsis nx-text">{list.name}</span>
            <span className="nx-menu-hint">{list.trackCount}</span>
          </button>
        ))}
      </div>
      <div className="nx-modal-actions">
        <button type="button" className="nx-btn nx-btn--ghost" onClick={close}>Cancel</button>
      </div>
    </Dialog>
  );
}

/* ------------------------------ popovers (speed, sleep) ------------------------------ */

import { EditInfoForm } from './EditInfoForm.js';
import { EqualizerPanel } from './EqualizerPanel.js';

export function PopoverLayer() {
  const popover = useUi((s) => s.popover);
  const { ui, prefs, audioControls } = useServices();
  const speed = usePrefs((s) => s.speed);
  const sleep = useAudioControls((s) => s.sleep);
  const remaining = useAudioControls((s) => s.sleepRemainingMs);
  const hasTrack = usePlaybackStore((s) => s.session?.current !== undefined);
  const ref = useRef<HTMLDivElement | null>(null);
  const close = useCallback(() => ui.getState().closePopover(), [ui]);
  useDismiss(popover !== undefined, close, ref);
  if (popover === undefined || popover.kind === 'volume') return null;

  const width = popover.kind === 'eq' ? 440 : 260;
  const left = Math.max(8, Math.min(popover.anchor.left + popover.anchor.width / 2 - width / 2, window.innerWidth - width - 8));
  const bottom = Math.max(8, window.innerHeight - popover.anchor.top + 10);
  const style: CSSProperties = { left, bottom, width };

  if (popover.kind === 'eq') {
    return (
      <div ref={ref} className="nx-popover nx-popover--eq" role="dialog" aria-label="Equalizer" style={{ ...style, maxWidth: 'calc(100vw - 16px)' }} data-testid="eq-popover">
        <div className="nx-menu-title" style={{ padding: '2px 4px 10px' }}>Equalizer</div>
        <EqualizerPanel testIdPrefix="eqpop" />
      </div>
    );
  }

  if (popover.kind === 'speed') {
    return (
      <div ref={ref} className="nx-popover" role="dialog" aria-label="Playback speed" style={style} data-testid="speed-popover">
        <div className="nx-menu-title" style={{ padding: '2px 4px 10px' }}>Playback speed</div>
        <div className="nx-chips">
          {SPEEDS.map((value) => (
            <button key={value} type="button" className="nx-pill" aria-pressed={speed === value} onClick={() => prefs.getState().setSpeed(value)}>
              {value === 1 ? 'Normal' : `${value}×`}
            </button>
          ))}
        </div>
        <p className="nx-faint" style={{ margin: '10px 4px 0', fontSize: 12 }}>Pitch stays natural at any speed.</p>
      </div>
    );
  }

  return (
    <div ref={ref} className="nx-popover" role="dialog" aria-label="Sleep timer" style={style} data-testid="sleep-popover">
      <div className="nx-menu-title" style={{ padding: '2px 4px 10px' }}>Sleep timer</div>
      {sleep.mode !== 'off' && (
        <div className="nx-setting" style={{ padding: '0 4px 10px' }}>
          <span className="nx-muted">{sleep.mode === 'timer' ? `Pausing in ${formatRemaining(remaining)}` : 'Pausing at the end of this track'}</span>
          <button type="button" className="nx-btn nx-btn--small nx-btn--danger" onClick={() => audioControls.getState().cancelSleep()}>Cancel</button>
        </div>
      )}
      <div className="nx-chips">
        {SLEEP_CHOICES_MINUTES.map((minutes) => (
          <button
            key={minutes}
            type="button"
            className="nx-pill"
            aria-pressed={sleep.mode === 'timer' && sleep.minutes === minutes}
            onClick={() => {
              audioControls.getState().setSleepTimer(minutes);
              close();
            }}
          >
            {minutes < 60 ? `${minutes} min` : `${minutes / 60 === 1 ? '1 hour' : `${minutes} min`}`}
          </button>
        ))}
        <button
          type="button"
          className="nx-pill"
          aria-pressed={sleep.mode === 'track'}
          disabled={!hasTrack}
          onClick={() => {
            audioControls.getState().setSleepEndOfTrack();
            close();
          }}
        >
          End of track
        </button>
      </div>
    </div>
  );
}

/* ------------------------------ toasts ------------------------------ */

interface Toast {
  readonly key: string;
  readonly text: string;
  readonly tone: 'ok' | 'error';
}

/** One place that turns the app's notices (favourites, queue, sleep timer, playback problems) into a short toast. */
export function ToastLayer() {
  const { collections, playback, audioControls, updates } = useServices();
  const [toast, setToast] = useState<Toast | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const show = useCallback((next: Toast): void => {
    setToast(next);
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(undefined), next.tone === 'error' ? 5_000 : 2_800);
  }, []);

  useEffect(() => {
    const a = collections.subscribe((s, p) => {
      if (s.notice !== undefined && s.notice.id !== p.notice?.id) show({ key: `c${s.notice.id}`, text: s.notice.text, tone: s.notice.tone });
    });
    const b = playback.subscribe((s, p) => {
      if (s.notice !== undefined && s.notice !== p.notice) show({ key: `p${Date.now()}`, text: s.notice, tone: 'ok' });
    });
    const c = audioControls.subscribe((s, p) => {
      if (s.notice !== undefined && s.notice !== p.notice) show({ key: `a${Date.now()}`, text: s.notice, tone: 'ok' });
    });
    const d = updates?.subscribe((s, p) => {
      if (s.announced !== undefined && s.announced !== p.announced) show({ key: `u${s.announced}`, text: `Update ${s.announced} is available — open Settings to install it.`, tone: 'ok' });
    });
    return () => {
      a();
      b();
      c();
      d?.();
      if (timer.current !== undefined) clearTimeout(timer.current);
    };
  }, [collections, playback, audioControls, updates, show]);

  return (
    <div className="nx-toasts" aria-live="polite" role="status" data-testid="toasts">
      {toast !== undefined && (
        <div key={toast.key} className="nx-toast" data-tone={toast.tone}>
          {toast.tone === 'ok' ? <Icon name="check" size={16} /> : <Icon name="close" size={16} />}
          <span className="nx-text">{toast.text}</span>
        </div>
      )}
    </div>
  );
}
