'use client';

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * A list page's search, held in the header.
 *
 * The office (2026-10-07): the inspections list had its own search box under
 * the header's, and the two looked like one control done twice -- "we can
 * consolidate the inspection page search bar to the navigation bar search bar,
 * because it is redundant". On every list page the header's box is now that
 * list's search; elsewhere it opens the search for records and pages (⌘K).
 *
 * The list still owns its query -- in its URL, as before. It lends the header
 * the value, what to call it, and how to change it, for as long as it is
 * mounted (`useProvidePageSearch`).
 */
export interface PageSearch {
  /** The field's accessible name: "Search move-out inspections". */
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  /** True while the list has not yet asked for what was typed. */
  pending?: boolean;
}

type Registry = {
  search: PageSearch | null;
  setSearch: (search: PageSearch | null) => void;
};

const PageSearchContext = createContext<Registry | null>(null);

export function PageSearchProvider({ children }: { children: ReactNode }) {
  const [search, setSearch] = useState<PageSearch | null>(null);
  return (
    <PageSearchContext.Provider value={{ search, setSearch }}>{children}</PageSearchContext.Provider>
  );
}

/** The search the current page lent the header, if it lent one. */
export function usePageSearch() {
  return useContext(PageSearchContext)?.search ?? null;
}

/**
 * Lends the header this page's search while the page is mounted.
 *
 * Returns whether there is a header to lend it to: without one -- a test, or a
 * page outside the console's shell -- the caller keeps drawing its own field.
 * `onChange` is read through a ref, so a new function each render neither
 * re-registers nor goes stale.
 */
export function useProvidePageSearch(search: PageSearch | null): boolean {
  const registry = useContext(PageSearchContext);
  const setSearch = registry?.setSearch;
  const onChange = useRef(search?.onChange);
  onChange.current = search?.onChange;
  const lent = search !== null;
  const label = search?.label ?? '';
  const placeholder = search?.placeholder ?? '';
  const value = search?.value ?? '';
  const pending = search?.pending ?? false;

  useEffect(() => {
    if (!setSearch || !lent) return;
    setSearch({
      label,
      placeholder,
      value,
      pending,
      onChange: (next) => onChange.current?.(next),
    });
  }, [setSearch, lent, label, placeholder, value, pending]);

  // Taken back when the page goes, not on every change, so the header never
  // flickers back to the record search between two keystrokes.
  useEffect(() => {
    if (!setSearch || !lent) return;
    return () => setSearch(null);
  }, [setSearch, lent]);

  return Boolean(registry);
}
