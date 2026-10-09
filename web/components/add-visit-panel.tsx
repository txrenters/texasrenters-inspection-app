'use client';

import { isFinishedStatus, type PropertyPosition } from '@texasrenters/shared';
import { ArrowLeftIcon, ExternalLinkIcon, SearchIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { SECTION_LABEL } from '@/components/panel';
import { StatusBadge } from '@/components/status-badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { INSPECTION_TYPE_CHILDREN } from '@/lib/admin-navigation';
import { humanize } from '@/lib/format';
import { useUnassignedOnDay } from '@/lib/queries';
import { cn } from '@/lib/utils';

/** The type in the words the console's navigation uses ("Move-in"), not the enum humanized. */
const typeTitle = (type: string) =>
  INSPECTION_TYPE_CHILDREN.find((child) => child.type === type)?.title ?? humanize(type);

/** How many properties a search lists; the map shows every match. */
const LISTED_PROPERTIES = 20;

/** Lower case, punctuation dropped, so "12 Example-Mill Rd." finds "12 example mill rd". */
const normalise = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Whether every word typed appears somewhere in the property's name or
 * address. Words, not the whole phrase, so "mill testville" finds "12 Example
 * Mill Rd, Testville".
 */
export function matchesSearch(haystack: string, query: string) {
  const words = normalise(query).split(' ').filter(Boolean);
  if (!words.length) return false;
  const text = normalise(haystack);
  return words.every((word) => text.includes(word));
}

const propertyText = (property: PropertyPosition) =>
  [property.name, property.addressLine1, property.city, property.postalCode].filter(Boolean).join(' ');

/**
 * "+ Add visit" on the technician map (the office, 2026-10-02).
 *
 * The whole sidebar while it is open, in place of the technician list, with a
 * way back to it. It began nested under the last stop of the selected day,
 * where it was squeezed to the list's width, ran off its right edge, and sat
 * below the fold of a list somebody had to scroll (the office: "the UI
 * overlaps and it's not a great UX"). The map stays beside it, showing what it
 * lists.
 *
 * Two ways to add to a technician's day, both without leaving the map:
 *
 * - **A visit already booked for that day with nobody on it**, assigned with
 *   one click -- the inspection page's own Assign, with its audit entry and its
 *   push to Jobber.
 * - **A visit at any property**, through the full create form in a new tab,
 *   already filled in with the property, the technician and the day. That form
 *   is where units, tenants, services and the Jobber booking are decided, and
 *   a second copy of it squeezed into the map would be a second place to get
 *   them wrong.
 *
 * Everything the panel lists is shown on the map as it is typed ("if we search
 * those properties as we add them, the map should show them too real time"):
 * the day's unassigned visits as soon as the panel opens, the matching
 * properties as the search narrows.
 */
export function AddVisitPanel({
  canAssign,
  canCreate,
  date,
  dateLabel,
  onAssign,
  onClose,
  onFocusProperty,
  onSearchChange,
  properties,
  technicianId,
  technicianName,
}: {
  /** `inspections:assign`: the day's unassigned visits are offered. */
  canAssign: boolean;
  /** `inspections:manage`: a new visit at any property is offered. */
  canCreate: boolean;
  /** The day being looked at, `yyyy-MM-dd` in Texas. */
  date: string;
  dateLabel: string;
  onAssign: (inspectionId: string) => Promise<void>;
  onClose: () => void;
  /** Take the map to one property and open its window. */
  onFocusProperty: (propertyId: string) => void;
  /** The properties the panel is showing, for the map to light up; null when it closes. */
  onSearchChange: (propertyIds: string[] | null) => void;
  properties: readonly PropertyPosition[];
  technicianId: string;
  technicianName: string;
}) {
  const [query, setQuery] = useState('');
  const [assigning, setAssigning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const unassigned = useUnassignedOnDay(date, canAssign);

  const searching = normalise(query).length >= 2;

  /** The day's visits nobody is on, narrowed by the search once there is one. */
  const visits = useMemo(
    () =>
      (unassigned.data?.items ?? []).filter((visit) => {
        // Only what is still to be done: a visit handed in has no day left to
        // be added to, and a cancelled one is not a visit.
        if (visit.status === 'CANCELLED' || isFinishedStatus(visit.status)) return false;
        if (!searching) return true;
        const building = visit.propertywareBuilding;
        return matchesSearch(
          [building?.name, building?.addressLine1, building?.city, visit.propertywareUnit?.name]
            .filter(Boolean)
            .join(' '),
          query,
        );
      }),
    [query, searching, unassigned.data?.items],
  );

  const matches = useMemo(
    () =>
      searching
        ? properties
            .filter((property) => matchesSearch(propertyText(property), query))
            .sort((left, right) => left.name.localeCompare(right.name))
        : [],
    [properties, query, searching],
  );

  /** Everything listed, by building, for the map -- the unassigned visits first. */
  const shownIds = useMemo(() => {
    const ids = new Set<string>();
    for (const visit of visits) if (visit.propertywareBuilding?.id) ids.add(visit.propertywareBuilding.id);
    for (const property of matches) ids.add(property.id);
    return [...ids];
  }, [matches, visits]);
  const shownKey = shownIds.join('|');

  useEffect(() => {
    onSearchChange(shownKey ? shownKey.split('|') : []);
    // Keyed on the ids themselves: a refetch that returns the same visits must
    // not move the map again.
  }, [onSearchChange, shownKey]);

  // The map lets go of the search when the panel closes, however it closes.
  useEffect(() => () => onSearchChange(null), [onSearchChange]);

  const assign = async (inspectionId: string) => {
    setAssigning(inspectionId);
    setError(null);
    try {
      await onAssign(inspectionId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The visit could not be assigned.');
    } finally {
      setAssigning(null);
    }
  };

  /** A row: what it is, which may be cut short, and what can be done with it, which never is. */
  const row = 'grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2 py-1.5 text-xs';

  return (
    <section aria-label={`Add a visit to ${technicianName}'s day`} className="flex h-full min-h-0 flex-col">
      {/* Fixed above the lists, so the search box never scrolls away from the results. */}
      <header className="grid gap-2 border-b px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <Button
            aria-label={`Back to ${technicianName}'s day`}
            className="size-7 shrink-0"
            onClick={onClose}
            size="icon-sm"
            title="Back"
            type="button"
            variant="ghost"
          >
            <ArrowLeftIcon aria-hidden className="size-4" />
          </Button>
          <div className="min-w-0">
            <p className="text-sm font-medium">Add a visit</p>
            <p className="text-muted-foreground truncate text-xs">
              To {technicianName} · {dateLabel}
            </p>
          </div>
        </div>
        <label className="relative block min-w-0">
          <span className="sr-only">Search a property or an address</span>
          <SearchIcon aria-hidden className="text-muted-foreground absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
          <Input
            autoFocus
            className="h-8 w-full pl-8 text-xs"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search a property or an address"
            value={query}
          />
        </label>
      </header>

      <div className="grid min-h-0 flex-1 content-start gap-4 overflow-y-auto px-3 py-2.5">
        {error ? <p className="text-destructive text-xs">{error}</p> : null}

        {canAssign ? (
          <div className="grid min-w-0 gap-1">
            {/* The console's one section-name style (console-development). */}
            <p className={cn(SECTION_LABEL, 'flex items-baseline gap-2')}>
              Unassigned that day
              {unassigned.data ? (
                <span className="font-mono text-xs tracking-normal normal-case tabular-nums">{visits.length}</span>
              ) : null}
            </p>
            {unassigned.isLoading ? (
              <p className="text-muted-foreground text-xs">Loading…</p>
            ) : unassigned.isError ? (
              <p className="text-destructive text-xs">The day&rsquo;s unassigned visits could not be loaded.</p>
            ) : visits.length === 0 ? (
              <p className="text-muted-foreground text-xs">
                {searching ? 'None of them match.' : 'Every visit that day has somebody on it.'}
              </p>
            ) : (
              <ul className="divide-border grid divide-y">
                {visits.map((visit) => {
                  const building = visit.propertywareBuilding;
                  return (
                    <li className={row} key={visit.id}>
                      <button
                        className="hover:text-foreground min-w-0 text-left disabled:cursor-default"
                        disabled={!building?.id}
                        onClick={() => building?.id && onFocusProperty(building.id)}
                        title={building?.id ? 'Show it on the map' : 'Not on the map'}
                        type="button"
                      >
                        <span className="block truncate font-medium">
                          {building?.name ?? 'Unknown property'}
                          {visit.propertywareUnit?.name ? ` · ${visit.propertywareUnit.name}` : ''}
                        </span>
                        <span className="text-muted-foreground flex flex-wrap items-center gap-1">
                          {typeTitle(visit.inspectionType)}
                          <StatusBadge className="h-4 px-1 text-[10px]" showIcon={false} value={visit.status} />
                        </span>
                      </button>
                      <Button
                        className="h-7 px-2.5 text-xs"
                        disabled={assigning !== null}
                        onClick={() => void assign(visit.id)}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        {assigning === visit.id ? 'Assigning…' : 'Assign'}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ) : null}

        {canCreate ? (
          <div className="grid min-w-0 gap-1">
            <p className={cn(SECTION_LABEL, 'flex items-baseline gap-2')}>
              New visit
              {searching ? (
                <span className="font-mono text-xs tracking-normal normal-case tabular-nums">
                  {matches.length} {matches.length === 1 ? 'property' : 'properties'}
                </span>
              ) : null}
            </p>
            {!searching ? (
              <p className="text-muted-foreground text-xs">
                Search above for the property; the matches light up on the map.
              </p>
            ) : matches.length === 0 ? (
              <p className="text-muted-foreground text-xs">No property matches.</p>
            ) : (
              <ul className="divide-border grid divide-y">
                {matches.slice(0, LISTED_PROPERTIES).map((property) => (
                  <li className={row} key={property.id}>
                    <button
                      className="hover:text-foreground min-w-0 text-left"
                      onClick={() => onFocusProperty(property.id)}
                      title="Show it on the map"
                      type="button"
                    >
                      <span className="block truncate font-medium">{property.name}</span>
                      <span className="text-muted-foreground block truncate">
                        {property.addressLine1}
                        {property.city ? `, ${property.city}` : ''}
                      </span>
                    </button>
                    {/* A new tab, so the map -- and the day being planned on it -- stays put. */}
                    <a
                      aria-label={`New visit at ${property.name}`}
                      className={cn(buttonVariants({ size: 'sm', variant: 'outline' }), 'h-7 gap-1 px-2.5 text-xs')}
                      href={`/inspections/new?${new URLSearchParams({ propertyId: property.id, technicianId, date }).toString()}`}
                      rel="noopener"
                      target="_blank"
                      title="Opens the full form in a new tab, filled in with this property, the technician and the day"
                    >
                      New
                      <ExternalLinkIcon aria-hidden className="size-3" />
                    </a>
                  </li>
                ))}
                {matches.length > LISTED_PROPERTIES ? (
                  <li className="text-muted-foreground py-1.5 text-xs">
                    {matches.length - LISTED_PROPERTIES} more on the map; type more to narrow it down.
                  </li>
                ) : null}
              </ul>
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
}
