'use client';

import type { PropertyPosition } from '@texasrenters/shared';
import { memo, useEffect, useMemo, useRef, useState } from 'react';

import { Input } from '@/components/ui/input';

/**
 * Every mapped property, findable by name or address.
 *
 * Beside the technicians rather than instead of them. The map answers "where is
 * everything"; five hundred pins answer that badly on their own, because a pin
 * cannot be read until you already know which one you want. A list can be
 * searched, and searching is how somebody actually arrives at one property.
 *
 * Selecting one takes the map to it — the same gesture the roster uses for a
 * technician, so the panel behaves consistently whichever tab is open.
 */

/**
 * Rows added each time the end of the list comes into view.
 *
 * The list used to stop dead at 120 with a line explaining that it had. That is
 * honest but useless: the remaining four hundred properties existed, were
 * searchable, and could not be reached by scrolling. Now the end of the list
 * pulls the next page in, and the only way to run out is to reach the actual
 * end.
 */
const PAGE = 60;

/**
 * How far ahead of the bottom to start loading.
 *
 * Far enough that the next rows are already there by the time the reader gets
 * to them, which is the whole difference between a feed and a list with a
 * "more" button in it.
 */
const LOOKAHEAD_PX = 300;

function matches(property: PropertyPosition, needle: string) {
  if (!needle) return true;
  const haystack =
    `${property.name} ${property.addressLine1} ${property.city} ${property.postalCode}`.toLowerCase();
  return haystack.includes(needle);
}

export const PropertyList = memo(function PropertyList({
  onSelect,
  properties,
  selectedId,
}: {
  onSelect: (propertyId: string | null) => void;
  properties: readonly PropertyPosition[];
  selectedId: string | null;
}) {
  const [query, setQuery] = useState('');
  const [visible, setVisible] = useState(PAGE);

  const scroller = useRef<HTMLDivElement | null>(null);
  const sentinel = useRef<HTMLLIElement | null>(null);

  const found = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const all = properties.filter((property) => matches(property, needle));
    // Sorted by name so the same search always returns the same order. An
    // unsorted list reshuffles as the API refetches and makes a row somebody
    // was reaching for move under the cursor.
    return [...all].sort((left, right) => left.name.localeCompare(right.name));
  }, [properties, query]);

  // Back to the first page whenever the search changes. Keeping a deep scroll
  // position across a new search would open the results part-way down, on rows
  // the reader has never seen.
  useEffect(() => {
    setVisible(PAGE);
    // `scrollTop` rather than `scrollTo`: the latter is absent in jsdom and in
    // a few older browsers, and this is not worth throwing over.
    if (scroller.current) scroller.current.scrollTop = 0;
  }, [query]);

  const shown = found.slice(0, visible);
  const more = found.length > shown.length;

  useEffect(() => {
    if (!more) return;

    const target = sentinel.current;
    const root = scroller.current;
    if (!target || !root) return;

    // Guarded: jsdom has no IntersectionObserver, and neither do a few older
    // browsers. Without it the list simply shows everything it has rather than
    // throwing — a longer list is a far smaller problem than a blank panel.
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(found.length);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        // `min` so the last page is exact rather than a slice past the end.
        if (entries.some((entry) => entry.isIntersecting))
          setVisible((count) => Math.min(count + PAGE, found.length));
      },
      { root, rootMargin: `0px 0px ${LOOKAHEAD_PX}px 0px` },
    );

    observer.observe(target);
    return () => observer.disconnect();
  }, [found.length, more, shown.length]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b px-3 py-3">
        <label className="sr-only" htmlFor="property-search">
          Search properties
        </label>
        <Input
          autoComplete="off"
          id="property-search"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search by address or city"
          type="search"
          value={query}
        />
      </div>

      {!properties.length ? (
        <p className="text-muted-foreground p-4 text-sm">
          No property has been placed on the map yet.
        </p>
      ) : !found.length ? (
        <p className="text-muted-foreground p-4 text-sm">
          Nothing matches &ldquo;{query.trim()}&rdquo;.
        </p>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto" ref={scroller}>
          <ul className="divide-border divide-y">
            {shown.map((property) => {
              const selected = property.id === selectedId;
              return (
                <li key={property.id}>
                  <button
                    aria-pressed={selected}
                    className={`hover:bg-muted/60 focus-visible:ring-ring flex w-full flex-col items-start gap-0.5 px-4 py-2.5 text-left outline-none focus-visible:ring-2 ${
                      selected ? 'bg-muted' : ''
                    }`}
                    // Clicking the selected row clears it, matching the roster:
                    // the way out is the control you came in by.
                    onClick={() => onSelect(selected ? null : property.id)}
                    type="button"
                  >
                    <span className="w-full truncate text-sm font-medium">{property.name}</span>
                    <span className="text-muted-foreground w-full truncate text-xs">
                      {property.addressLine1}
                      {property.city ? `, ${property.city}` : null}
                    </span>
                  </button>
                </li>
              );
            })}

            {/* The thing the observer watches. Inside the list rather than
                after it, so it scrolls with the rows and sits a page ahead of
                the reader instead of at a fixed point in the panel. */}
            {more ? (
              <li
                className="text-muted-foreground px-4 py-3 text-xs"
                ref={sentinel}
                // Announced rather than silent: somebody on a screen reader
                // has no way to see rows appearing beneath them.
                aria-live="polite"
              >
                Loading more&hellip; {shown.length} of {found.length}
              </li>
            ) : (
              <li className="text-muted-foreground px-4 py-3 text-xs">
                {found.length === properties.length
                  ? `All ${found.length} properties`
                  : `${found.length} of ${properties.length} properties`}
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
});
