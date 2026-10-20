import { useEffect, useState } from 'react';

interface Tip {
  readonly text: string;
  readonly keys: string | undefined;
  readonly x: number;
  readonly y: number;
  readonly below: boolean;
}

const SHOW_DELAY_MS = 450;

/** What an element should say in its tooltip: `data-tip`, or its `aria-label` when it shows no text of its own (icon buttons). */
export function tipTextFor(el: HTMLElement): string | undefined {
  if (el.hasAttribute('data-no-tip')) return undefined;
  const explicit = el.getAttribute('data-tip');
  if (explicit !== null && explicit !== '') return explicit;
  const label = el.getAttribute('aria-label');
  if (label === null || label === '') return undefined;
  const visible = el.innerText?.trim() ?? '';
  return visible === '' ? label : undefined;
}

/**
 * One tooltip for the whole app: hover (or keyboard focus) any icon-only control and its name appears, with the
 * shortcut when it has one (`data-keys`). Delegated from the document, so no control needs wiring.
 */
export function Tooltips() {
  const [tip, setTip] = useState<Tip | undefined>(undefined);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let owner: HTMLElement | null = null;
    const hide = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      owner = null;
      setTip(undefined);
    };
    // Scrolling hides a visible tip, but must not cancel one that is still waiting to appear (a hover can itself scroll the control into view).
    const dismiss = () => setTip(undefined);
    const schedule = (el: HTMLElement, delay: number) => {
      const text = tipTextFor(el);
      if (text === undefined) return;
      owner = el;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        if (owner !== el || !el.isConnected) return;
        const rect = el.getBoundingClientRect();
        const below = rect.top < 80;
        setTip({ text, keys: el.getAttribute('data-keys') ?? undefined, x: Math.min(Math.max(rect.left + rect.width / 2, 90), window.innerWidth - 90), y: below ? rect.bottom + 8 : rect.top - 8, below });
      }, delay);
    };
    const find = (target: EventTarget | null): HTMLElement | null => (target instanceof Element ? target.closest<HTMLElement>('[data-tip], [aria-label]') : null);
    const over = (event: PointerEvent) => {
      const el = find(event.target);
      if (el === owner) return;
      hide();
      if (el !== null) schedule(el, SHOW_DELAY_MS);
    };
    const focus = (event: FocusEvent) => {
      const el = find(event.target);
      if (el !== null && el.matches(':focus-visible')) schedule(el, 0);
    };
    document.addEventListener('pointerover', over);
    document.addEventListener('pointerdown', hide, true);
    document.addEventListener('keydown', hide, true);
    document.addEventListener('focusin', focus);
    document.addEventListener('focusout', hide);
    window.addEventListener('blur', hide);
    document.addEventListener('scroll', dismiss, true);
    return () => {
      hide();
      document.removeEventListener('pointerover', over);
      document.removeEventListener('pointerdown', hide, true);
      document.removeEventListener('keydown', hide, true);
      document.removeEventListener('focusin', focus);
      document.removeEventListener('focusout', hide);
      window.removeEventListener('blur', hide);
      document.removeEventListener('scroll', dismiss, true);
    };
  }, []);

  if (tip === undefined) return null;
  return (
    <div className="nx-tip" role="tooltip" data-testid="tooltip" style={{ left: tip.x, top: tip.y, transform: `translate(-50%, ${tip.below ? '0' : '-100%'})` }}>
      <span>{tip.text}</span>
      {tip.keys !== undefined && <kbd>{tip.keys}</kbd>}
    </div>
  );
}
