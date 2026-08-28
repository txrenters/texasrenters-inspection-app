'use client';

import type { PropertyPosition } from '@texasrenters/shared';
import { memo, useMemo, useState } from 'react';

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
 * Rendered at most this many at once.
 *
 * Five hundred and forty-six rows is roughly sixteen hundred DOM nodes in a
 * panel that re-renders whenever a position arrives over the socket, which is
 * every few seconds. The cap keeps that cheap without a virtualiser, and the
 * count below says plainly how many were not drawn — a truncated list that does
 * not admit it is the thing that makes people distrust a search box.
 */
const RENDER_LIMIT = 120;

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

  const found = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const all = properties.filter((property) => matches(property, needle));
    // Sorted by name so the same search always returns the same order. An
    // unsorted list reshuffles as the API paginates and makes a row people were
    // reaching for move under the cursor.
    return [...all].sort((left, right) => left.name.localeCompare(right.name));
  }, [properties, query]);

  const shown = found.slice(0, RENDER_LIMIT);

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
        <div className="min-h-0 flex-1 overflow-y-auto">
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
          </ul>

          {/* Said, never silent. A list that quietly stops at a hundred and
              twenty looks like a search that found nothing further. */}
          {found.length > shown.length ? (
            <p className="text-muted-foreground border-t px-4 py-2 text-xs">
              Showing {shown.length} of {found.length}. Keep typing to narrow it.
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
});
