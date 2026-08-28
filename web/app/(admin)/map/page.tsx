'use client';

import dynamic from 'next/dynamic';
import { useMemo, useState } from 'react';

import { PageHeader } from '@/components/page-header';
import { EmptyState } from '@/components/states';
import { Skeleton } from '@/components/ui/skeleton';
import { usePermissions } from '@/lib/auth';
import { formatRelative } from '@/lib/format';
import {
  useMapAssignments,
  usePropertyLocations,
  useTechnicianLocations,
  useTechnicianRoute,
} from '@/lib/queries';
import { PropertyList } from '@/components/property-list';
import { buildRoster, TechnicianRoster } from '@/components/technician-roster';
import { DatePicker } from '@/components/ui/date-picker';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

/**
 * `ssr: false` is not optional. Leaflet reads `window` at import time and
 * measures its container to lay tiles out, so a server render throws before it
 * can produce anything — and `dynamic` may only disable SSR from a client
 * component, which is why this page is one.
 */
const TechnicianMap = dynamic(
  () => import('@/components/technician-map').then((module) => module.TechnicianMap),
  {
    ssr: false,
    loading: () => <Skeleton className="h-full w-full rounded-lg" />,
  },
);

/** The technician badge, small enough to sit in a line of text. */
function TechnicianSwatch({ stale = false }: { stale?: boolean }) {
  return (
    <svg aria-hidden="true" height="14" viewBox="0 0 28 28" width="14">
      <circle
        className={stale ? 'fill-map-technician-stale' : 'fill-map-technician'}
        cx="14"
        cy="14"
        r="11"
        stroke="#fff"
        strokeWidth="2.5"
      />
      <circle cx="14" cy="11.1" fill="#fff" r="2.9" />
      <path d="M8.1 20.4c0-3.2 2.7-5.2 5.9-5.2s5.9 2 5.9 5.2z" fill="#fff" />
    </svg>
  );
}

/** The property pin, at the same scale. */
function PropertySwatch() {
  return (
    <svg aria-hidden="true" height="15" viewBox="0 0 24 32" width="11">
      <path
        className="fill-map-property"
        d="M12 1.5c-5.5 0-10 4.4-10 9.9 0 7.4 10 19.1 10 19.1s10-11.7 10-19.1c0-5.5-4.5-9.9-10-9.9z"
        stroke="#fff"
        strokeWidth="2"
      />
      <path d="M12 6.6 6.6 11v6.1h3.6v-3.5h3.6v3.5h3.6V11z" fill="#fff" />
    </svg>
  );
}

function LegendKey({ children, swatch }: { children: React.ReactNode; swatch: React.ReactNode }) {
  return (
    <span className="text-muted-foreground flex items-center gap-1.5">
      {swatch}
      {children}
    </span>
  );
}

export default function TechnicianMapPage() {
  // `technicians:read` rather than `inspections:read`: where a named person was
  // at a given minute is a fact about them, not about an inspection, and the
  // two should not open with the same key.
  const permissions = usePermissions();
  const canView = permissions.has('technicians:read');
  const positions = useTechnicianLocations(canView);

  // Properties are a separate grant, and someone may hold one without the
  // other. Asked for only when it is held, so the console never fires a request
  // it knows will be refused.
  const properties = usePropertyLocations(canView && permissions.has('properties:read'));

  // Today, in the reader's own calendar day. The schema stores a date with no
  // clock value, so there is no narrower window to ask for.
  //
  // `toISOString` would be UTC and would roll over an evening early for a Texas
  // office, showing tomorrow's work as today's. `en-CA` is the shortest way to
  // get `yyyy-MM-dd` out of the browser's own locale machinery.
  const today = useMemo(() => new Date().toLocaleDateString('en-CA'), []);
  const [date, setDate] = useState(today);
  const assignments = useMapAssignments(date, canView);

  const [selectedId, setSelectedId] = useState<string | null>(null);

  // One focus at a time. Both selections fly the map somewhere, so holding both
  // would leave two effects fighting over the view -- and "selected" would mean
  // two different things in one panel.
  const [selectedPropertyId, setSelectedPropertyId] = useState<string | null>(null);

  const selectTechnician = (technicianId: string | null) => {
    setSelectedId(technicianId);
    if (technicianId) setSelectedPropertyId(null);
  };

  const selectProperty = (propertyId: string | null) => {
    setSelectedPropertyId(propertyId);
    if (propertyId) setSelectedId(null);
  };

  // Only for the selected technician. Planning a route calls OSRM once per
  // person, so doing it for the whole roster to draw one line would be paying
  // for five answers to use one.
  const route = useTechnicianRoute(selectedId ?? '', date, Boolean(selectedId));

  const roster = useMemo(
    () => buildRoster(positions.data ?? [], assignments.data ?? []),
    [positions.data, assignments.data],
  );

  // Null when nobody is selected, which the map reads as "show everything at
  // full strength". An empty set is different and means the selected person
  // has no mapped stops -- worth seeing rather than silently drawing as though
  // nothing were selected.
  const highlighted = useMemo(() => {
    if (!selectedId) return null;
    const match = assignments.data?.find((entry) => entry.technicianId === selectedId);
    // Stops with no building are dropped here and only here: they cannot be
    // highlighted on a map. The panel still lists them, and says why.
    return new Set(
      (match?.stops ?? [])
        .map((stop) => stop.buildingId)
        .filter((buildingId): buildingId is string => Boolean(buildingId)),
    );
  }, [assignments.data, selectedId]);

  const newest = positions.data?.reduce<string | null>(
    (latest, position) => (!latest || position.recordedAt > latest ? position.recordedAt : latest),
    null,
  );

  return (
    <>
      <PageHeader
        description={
          newest
            ? `Where each technician was last seen. Most recent report ${formatRelative(newest)}.`
            : 'Last known position of each technician, reported while their app is open.'
        }
        title="Technician map"
      />

      {!canView ? (
        <EmptyState
          description="Ask an administrator for the technicians permission if you need it."
          title="You do not have access to technician locations"
        />
      ) : (
        /* The map is the page, and it renders whether or not anybody has
           reported. An empty map still says where the work is — the city, the
           streets, the shape of the patch — and replacing it with a card meant
           the most ordinary state of all, nobody on shift, showed nothing at
           all. Anything worth saying is said over the top of it instead. */
        <div className="space-y-2">
          {/* The roster sits beside the map on a wide screen and above it on a
              narrow one. Above rather than below: on a phone the list is the
              faster answer to "who is out", and a map you have to scroll past
              to reach it is the wrong way round. */}
          <div className="grid gap-3 lg:grid-cols-[280px_minmax(0,1fr)]">
            <div className="bg-card flex h-[70vh] flex-col overflow-hidden rounded-lg border">
              <Tabs className="flex min-h-0 flex-1 flex-col" defaultValue="technicians">
                <TabsList className="m-2 grid shrink-0 grid-cols-2">
                  <TabsTrigger value="technicians">Technicians</TabsTrigger>
                  <TabsTrigger value="properties">
                    Properties
                    {properties.data?.length ? (
                      <span className="text-muted-foreground ml-1.5 tabular-nums">
                        {properties.data.length}
                      </span>
                    ) : null}
                  </TabsTrigger>
                </TabsList>

                <TabsContent
                  className="mt-0 flex min-h-0 flex-1 flex-col"
                  value="technicians"
                >
              {/* The date sits above the list rather than beside the map,
                  because it governs the list: positions are always live, and
                  only the assignments below answer to it. Putting it over the
                  map would suggest it moved the pins through time. */}
              <div className="space-y-2 border-b px-3 py-3">
                <label
                  className="text-muted-foreground block text-xs font-medium tracking-wide uppercase"
                  htmlFor="roster-date"
                >
                  Assignments for
                </label>
                <DatePicker
                  aria-label="Show assignments for this date"
                  id="roster-date"
                  onChange={(next) => {
                    // Empty means the picker was cleared. A day is required
                    // here, so it falls back to today rather than asking the
                    // API for assignments on no date at all.
                    setDate(next || today);
                    // The selected technician may have no work on the new day,
                    // and a highlight left over from a different date would be
                    // quietly wrong.
                    setSelectedId(null);
                  }}
                  value={date}
                />
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                <TechnicianRoster
                  entries={roster}
                  onSelect={selectTechnician}
                  route={selectedId ? (route.data ?? null) : null}
                  selectedId={selectedId}
                />
              </div>
                </TabsContent>

                {/* Selecting one takes the map to it, exactly as the roster
                    does for a technician -- the panel behaves the same way
                    whichever tab is open. */}
                <TabsContent className="mt-0 min-h-0 flex-1" value="properties">
                  <PropertyList
                    onSelect={selectProperty}
                    properties={properties.data ?? []}
                    selectedId={selectedPropertyId}
                  />
                </TabsContent>
              </Tabs>
            </div>

            {/* `isolate` is load-bearing, not decoration. Leaflet gives its own
                controls `z-index: 1000` and its panes 400-700, and without a
                stacking context here those values compete with the whole page —
                so the theme menu and every other popover rendered into a portal
                at `z-50` came out *underneath* the map. Isolating confines
                Leaflet's z-indexes to this box, where they still order its own
                layers correctly and stop escaping. */}
            <div className="relative isolate h-[70vh] w-full overflow-hidden rounded-lg border">
              <TechnicianMap
                highlightedBuildingIds={highlighted}
                positions={positions.data ?? []}
                properties={properties.data ?? []}
                route={selectedId ? (route.data ?? null) : null}
                selectedPropertyId={selectedPropertyId}
                selectedTechnicianId={selectedId}
              />

              {positions.isError || (!positions.isLoading && !positions.data?.length) ? (
                /* `pointer-events-none` on the wrapper and restored on the
                   notice: a banner that swallowed drags would make the map
                   behind it look broken. z-[1000] because Leaflet's own panes
                   sit at 400-700. */
                <div className="pointer-events-none absolute inset-x-0 top-3 z-[1000] flex justify-center px-3">
                  <div className="bg-background/95 pointer-events-auto rounded-md border px-3 py-2 text-sm shadow-sm">
                    {positions.isError ? (
                      <span className="flex items-center gap-2">
                        <span className="text-destructive">Could not load positions.</span>
                        <button
                          className="underline underline-offset-4"
                          onClick={() => void positions.refetch()}
                          type="button"
                        >
                          Try again
                        </button>
                      </span>
                    ) : (
                      <span className="text-muted-foreground">
                        No handset has reported a position yet — they appear once a technician
                        opens the app.
                      </span>
                    )}
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          {/* The swatches repeat the markers' own shapes rather than reducing
              them all to dots. A legend whose keys look nothing like the thing
              they explain makes the reader do the translation twice. */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            <LegendKey swatch={<TechnicianSwatch />}>Technician, reported recently</LegendKey>
            <LegendKey swatch={<TechnicianSwatch stale />}>
              Technician, over 30 minutes ago
            </LegendKey>
            <LegendKey swatch={<PropertySwatch />}>
              Property {properties.data?.length ? `(${properties.data.length})` : null}
            </LegendKey>
          </div>
        </div>
      )}
    </>
  );
}
