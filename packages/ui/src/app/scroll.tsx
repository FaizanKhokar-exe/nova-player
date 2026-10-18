import { createContext, useContext, type RefObject } from 'react';

/** The page's scroll container, so a virtualized list can scroll WITH the page (hero, shelves and rows in one scroll). */
export const ScrollContext = createContext<RefObject<HTMLDivElement | null> | null>(null);

export function useScrollRef(): RefObject<HTMLDivElement | null> {
  const ref = useContext(ScrollContext);
  if (ref === null) throw new Error('A page list must be rendered inside the page scroll area.');
  return ref;
}
