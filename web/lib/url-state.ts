'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo, useRef } from 'react';

/**
 * List state — page, search, filters — held in the URL rather than in `useState`.
 *
 * The old app kept all of it in component state, which meant a filtered list
 * could not be shared, bookmarked, or reopened: the back button left the filters
 * applied while showing page 1, and a refresh silently discarded everything
 * someone had narrowed down to. "Send me the link to the unassigned inspections"
 * had no answer.
 *
 * Written with `replace` and `scroll: false` so typing in a search box does not
 * push forty history entries or jump the page to the top on each keystroke.
 */
export type UrlState = Record<string, string | number | boolean | undefined>;

/**
 * Inference against a primitive-union constraint keeps literal types, so
 * `useUrlState({ unassigned: false })` would give the state key the type
 * `false` — and `setState({ unassigned: true })` then fails with "Type 'true'
 * is not assignable to type 'false'". The defaults are seed values, not a
 * closed set, so they widen back to their base types here.
 */
type Widen<T> = {
  [K in keyof T]: T[K] extends boolean
    ? boolean
    : T[K] extends number
      ? number
      : T[K] extends string
        ? string
        : T[K];
};

export function useUrlState<T extends UrlState>(defaults: T) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  /**
   * Every call site passes an object literal, so `defaults` is a new reference
   * on each render and would invalidate both callbacks below every time.
   *
   * Held in a ref, captured once. The defaults describe the shape of the state,
   * not a value that changes — a call site that varied them between renders
   * would be describing a different page. Keeping it honest this way beats
   * disabling the exhaustive-deps rule, which is what the first version did.
   */
  const defaultsRef = useRef(defaults);

  const state = useMemo(() => {
    const seed = defaultsRef.current;
    const next = { ...seed };
    for (const key of Object.keys(seed)) {
      const raw = searchParams.get(key);
      if (raw === null) continue;
      const fallback = seed[key];
      (next as UrlState)[key] =
        typeof fallback === 'number'
          ? Number.isFinite(Number(raw))
            ? Number(raw)
            : fallback
          : typeof fallback === 'boolean'
            ? raw === 'true'
            : raw;
    }
    return next as Widen<T>;
  }, [searchParams]);

  const setState = useCallback(
    (patch: Partial<Widen<T>>) => {
      const seed = defaultsRef.current;
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(patch)) {
        // A value equal to its default is absent from the URL rather than
        // written as `?page=1&status=`, so a pristine list has a clean address.
        if (value === undefined || value === '' || value === false || value === seed[key]) {
          params.delete(key);
        } else {
          params.set(key, String(value));
        }
      }
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  const reset = useCallback(() => {
    router.replace(pathname, { scroll: false });
  }, [pathname, router]);

  return [state, setState, reset] as const;
}
