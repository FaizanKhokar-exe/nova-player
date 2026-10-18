import { useEffect, useRef } from 'react';
import { useLibraryStore } from '../library/LibraryStoreProvider.js';
import { Icon } from '../theme/Icon.js';
import { useServices, useUi } from './services.js';

/** Back / forward, the search box (Ctrl+K), and room for page actions. */
export function Topbar() {
  const { ui, library } = useServices();
  const route = useUi((s) => s.route);
  const index = useUi((s) => s.historyIndex);
  const length = useUi((s) => s.history.length);
  const focusToken = useUi((s) => s.searchFocusToken);
  const query = useLibraryStore((s) => s.query);
  const input = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (focusToken > 0) input.current?.focus();
  }, [focusToken]);

  return (
    <header className="nx-topbar" data-testid="topbar">
      <button type="button" className="nx-icon-btn" aria-label="Back" data-testid="nav-back" disabled={index <= 0} onClick={() => ui.getState().back()}>
        <Icon name="chevronLeft" size={22} />
      </button>
      <button type="button" className="nx-icon-btn" aria-label="Forward" data-testid="nav-forward" disabled={index >= length - 1} onClick={() => ui.getState().forward()}>
        <Icon name="chevronRight" size={22} />
      </button>
      <div className="nx-search" role="search">
        <span className="nx-search-icon"><Icon name="search" size={19} /></span>
        <input
          ref={input}
          type="search"
          aria-label="Search your music"
          data-testid="search-input"
          placeholder="Search songs, albums, artists"
          value={query}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            const value = event.currentTarget.value;
            library.getState().setQuery(value);
            if (value.trim() !== '' && ui.getState().route.name !== 'search') ui.getState().navigate({ name: 'search' });
            else if (value.trim() === '' && ui.getState().route.name === 'search') ui.getState().back();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              library.getState().setQuery('');
              event.currentTarget.blur();
              if (route.name === 'search') ui.getState().back();
            }
          }}
        />
        {query === '' ? (
          <kbd>Ctrl K</kbd>
        ) : (
          <button type="button" className="nx-icon-btn nx-icon-btn--small nx-search-clear" aria-label="Clear search" data-testid="search-clear" onClick={() => library.getState().setQuery('')}>
            <Icon name="close" size={15} />
          </button>
        )}
      </div>
      <div className="nx-topbar-spacer" />
    </header>
  );
}
