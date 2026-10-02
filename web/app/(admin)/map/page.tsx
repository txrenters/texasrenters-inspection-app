'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { OFF_ROUTE_M, projectOntoPath } from '@texasrenters/shared';

/**
 * The least time between two requests for a fresh route.
 *
 * Fifteen seconds. A route is drawn from where somebody was when it was asked
 * for, so by the time it arrives they have moved -- a technician driving away
 * from their next stop is off every route the moment it lands, and without
 * this each fix would buy another billed request. Long enough to stop the
 * loop, short enough that the line never sits wrong for a whole poll.
 */
const REROUTE_ASK_EVERY_MS = 15_000;

import {
  DoneBadge,
  GroupDisc,
  LooseDisc,
  OTHER_PROPERTY_RIM,
  OTHER_PROPERTY_YELLOW,
} from '@/components/map-discs';
import { PageHeader } from '@/components/page-header';
import { UNGROUPED_GREEN } from '@/components/planning/group-file';
import { useFillHeight } from '@/components/planning/use-fill-height';
import { EmptyState } from '@/components/states';
import { toast } from 'sonner';

import { AddVisitPanel } from '@/components/add-visit-panel';
import { Skeleton } from '@/components/ui/skeleton';
import { usePermissions } from '@/lib/auth';
import { fromDateValue } from '@/lib/date-range';
import { visitsByProperty } from '@/lib/day-visits';
import { formatRelative } from '@/lib/format';
import {
  useAdminMutations,
  useMapAssignments,
  usePropertyLocations,
  useRefreshMapDay,
  useTechnicianLocations,
  useTechnicianRoute,
  useTechnicianRoutes,
  useTechnicianTimeline,
  useTechnicianTrails,
} from '@/lib/queries';
import { technicianColors } from '@/lib/technician-colors';
import { PropertyList } from '@/components/property-list';
import {
  buildRoster,
  isOnTheDay,
  TechnicianRoster,
  type RosterEntry,
} from '@/components/technician-roster';
import { TechnicianDaySummary } from '@/components/technician-day-summary';
import { DatePicker } from '@/components/ui/date-picker';
import { businessToday } from '@/lib/clock';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { presenceOf, type AssignedStop, type TechnicianPresence } from '@texasrenters/shared';

/**
 * `ssr: false` is not optional, and stayed so when the map moved to Google.
 *
 * The Maps JavaScript API injects a script tag and measures its container, so
 * a server render produces nothing and throws on the way. Leaflet failed the
 * same way for the same reason, which is why this guard predates the change and
 * outlives it. `dynamic` may only disable SSR from a client component, which is
 * why this page is one.
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

/** The driving arrow, at the same scale. */
function DrivingSwatch() {
  return (
    <svg aria-hidden="true" height="14" viewBox="0 0 28 28" width="14">
      <circle cx="14" cy="14" fill="#fff" r="12.5" />
      <path className="fill-map-technician" d="M14 3.5 L21 23 L14 18.8 L7 23 Z" />
    </svg>
  );
}

/** The property discs, at a legend's scale: the map's own markers, not stand-ins for them. */
function DiscSwatch({ kind }: { kind: 'GROUP' | 'LOOSE' | 'OTHER' }) {
  return (
    <span aria-hidden="true" className="inline-flex size-4 items-center justify-center [&>svg]:size-4">
      {kind === 'GROUP' ? (
        <GroupDisc fill="#7c3aed" ink="#fff" />
      ) : kind === 'LOOSE' ? (
        <LooseDisc color={UNGROUPED_GREEN} />
      ) : (
        <LooseDisc color={OTHER_PROPERTY_YELLOW} rim={OTHER_PROPERTY_RIM} />
      )}
    </span>
  );
}

/** The tick a disc wears once its inspections are in. */
function DoneSwatch() {
  return (
    <span aria-hidden="true" className="inline-flex size-4 items-center justify-center">
      <DoneBadge />
    </span>
  );
}

/** A technician's line: solid where they went, dashed where they are still to go. */
function LineSwatch({ dashed = false }: { dashed?: boolean }) {
  return (
    <svg aria-hidden="true" className="text-foreground" height="8" viewBox="0 0 20 8" width="20">
      <path
        d="M1 4h18"
        stroke="currentColor"
        strokeDasharray={dashed ? '4 3' : undefined}
        strokeLinecap={dashed ? 'butt' : 'round'}
        strokeWidth={dashed ? 2 : 3}
      />
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
  // `technicians:locate` rather than `technicians:read`: where a named person was
  // at a given minute is a fact about them, not about an inspection, and the
  // two should not open with the same key.
  const permissions = usePermissions();
  const canView = permissions.has('technicians:locate');
  const positions = useTechnicianLocations(canView);

  // Properties are a separate grant, and someone may hold one without the
  // other. Asked for only when it is held, so the console never fires a request
  // it knows will be refused.
  const properties = usePropertyLocations(canView && permissions.has('properties:read'));

  // The map fills the window below where it starts, as the Group maker's does,
  // with room left under it for the legend.
  const fill = useFillHeight<HTMLDivElement>({ bottom: 40 });

  /** How many of each disc the legend explains; null where the package is not ours to say. */
  const discCounts = useMemo(() => {
    const list = properties.data ?? [];
    if (!list.some((property) => property.tbpEnrolled !== undefined)) return null;
    return {
      group: list.filter((property) => property.tbpGroup).length,
      loose: list.filter((property) => !property.tbpGroup && property.tbpEnrolled).length,
      other: list.filter((property) => property.tbpEnrolled === false).length,
    };
  }, [properties.data]);

  // Today in Texas, not today where the reader is. The schema stores a date
  // with no clock value, so there is no narrower window to ask for.
  //
  // This used to read the browser's own calendar day, which is right only if
  // the reader shares the field's. The office is often in Manila, thirteen or
  // fourteen hours ahead, so the map opened in the evening there showed *the
  // next day's* assignments — a roster for work nobody had started, and an
  // empty map for the technicians who were actually out.
  const today = useMemo(() => businessToday(), []);
  const [date, setDate] = useState(today);
  const assignments = useMapAssignments(date, canView);

  const [selectedId, setSelectedId] = useState<string | null>(null);

  // One focus at a time. Both selections fly the map somewhere, so holding both
  // would leave two effects fighting over the view -- and "selected" would mean
  // two different things in one panel.
  const [selectedPropertyId, setSelectedPropertyId] = useState<string | null>(null);

  // Both wrapped, because `PropertyList` is memoised and a handler rebuilt on
  // every render defeats that entirely -- and this page re-renders whenever a
  // position arrives over the socket, which is every few seconds. With the list
  // now able to grow to every property, re-rendering all of them on that
  // cadence is a cost with no reader.
  /**
   * Whose day the "Add visit" panel is adding to, while it is open in place of
   * the technician list (the office, 2026-10-02: nested under the last stop it
   * overflowed the sidebar). Null when the list is showing.
   */
  const [addingFor, setAddingFor] = useState<RosterEntry | null>(null);

  const selectTechnician = useCallback((technicianId: string | null) => {
    setSelectedId(technicianId);
    // Cleared whichever way the selection went. Deselecting used to leave a
    // focused stop behind, pointing at a property whose list had just
    // collapsed.
    setSelectedPropertyId(null);
    // A panel adding to somebody no longer selected would add to the wrong day.
    setAddingFor((current) => (current?.technicianId === technicianId ? current : null));
  }, []);

  /**
   * Back to the selected technician, and following them again, from wherever
   * the map has gone (the office, 2026-10-02: "add a button saying see Moses
   * location" -- once a stop was picked, their name only collapsed the list).
   * The count is a request the map acts on each time it goes up, so a second
   * press after panning away still brings them back.
   */
  const [followRequest, setFollowRequest] = useState(0);
  const focusTechnician = useCallback((technicianId: string) => {
    setSelectedId(technicianId);
    setSelectedPropertyId(null);
    setFollowRequest((count) => count + 1);
  }, []);

  const selectProperty = useCallback((propertyId: string | null) => {
    setSelectedPropertyId(propertyId);
    if (propertyId) setSelectedId(null);
  }, []);

  /**
   * A stop inside the selected technician's day.
   *
   * Deliberately *not* `selectProperty`, which clears the technician — that
   * would collapse the very list the stop was clicked in. The technician stays
   * selected, so their round stays highlighted and their route stays drawn
   * while the map moves to one address on it.
   *
   * Safe because the two focus effects key on different things: `FocusSelected`
   * depends on the technician id alone, so it does not re-run when only the
   * property changes. Their flight already happened when the name was clicked.
   * Nothing fights the map for the view.
   */
  const selectStop = useCallback((buildingId: string | null) => {
    setSelectedPropertyId(buildingId);
  }, []);

  // Only for the selected technician. Planning a route calls OSRM once per
  // person, so doing it for the whole roster to draw one line would be paying
  // for five answers to use one.
  const route = useTechnicianRoute(selectedId ?? '', date, Boolean(selectedId));

  /**
   * Ask for a new route the moment they leave the drawn one.
   *
   * The server already redraws when somebody is more than `OFF_ROUTE_M` from
   * the line -- that decision is `needsReroute`, and it is the same constant
   * used here so the two cannot disagree about what "off it" means. What it
   * cannot do is decide when to be asked: the route is polled every thirty
   * seconds, which at motorway speed is the better part of a kilometre driven
   * against a line that already stopped applying. The office watched exactly
   * that (2026-09-22): "moses is not following the route so it should
   * recalculate and reroute the lines also just like google maps".
   *
   * Positions arrive over the socket every few seconds, so this notices within
   * one fix. It refetches rather than computing anything: the route is
   * Google's answer, and the console's job is only to stop waiting for the
   * poll.
   *
   * Throttled to `REROUTE_ASK_EVERY_MS`, which is the guard that matters. A
   * fresh route is drawn from where they were when it was asked for, so by the
   * time it arrives they have moved again -- without this, a technician
   * driving away from their next stop would ask for a new route on every
   * single fix, and every one of those is a billed request.
   */
  const askedForRerouteAt = useRef(0);
  const drawnRoute = route.data?.geometry;
  useEffect(() => {
    if (!selectedId || !drawnRoute || drawnRoute.length < 2) return;
    const here = positions.data?.find((position) => position.technicianId === selectedId);
    if (!here) return;
    const projected = projectOntoPath(here, drawnRoute);
    if (!projected || projected.offsetMeters <= OFF_ROUTE_M) return;
    const now = Date.now();
    if (now - askedForRerouteAt.current < REROUTE_ASK_EVERY_MS) return;
    askedForRerouteAt.current = now;
    void route.refetch();
  }, [drawnRoute, positions.data, route, selectedId]);

  /**
   * Only for the selected technician, and only for the day being looked at.
   *
   * Segmenting a trail is cheap but it is one query per person, and the roster
   * is a list somebody scans rather than reads -- fetching a day for everyone
   * on it would spend a dozen requests to fill in numbers nobody asked for yet.
   */
  const timeline = useTechnicianTimeline(selectedId ?? '', date, Boolean(selectedId));

  /**
   * Which technicians to show: everybody, only those reporting now, or only
   * those who are not.
   *
   * Page level rather than inside the Technicians tab, because it moves the
   * markers on the map as well as the rows in the list. A control tucked into
   * one tab would carry on filtering the map while somebody was looking at the
   * Properties tab and could not see it.
   */
  const [presence, setPresence] = useState<TechnicianPresence | 'ALL'>('ALL');

  const roster = useMemo(
    () => buildRoster(positions.data ?? [], assignments.data ?? []),
    [positions.data, assignments.data],
  );

  /**
   * The counts, computed before filtering.
   *
   * On the labels because "who is out right now" is the question the page is
   * usually opened to answer, and a number answers it without anyone having to
   * click the filter to find out it is empty.
   */
  /**
   * The people with work on this day -- see `isOnTheDay`. Everything below
   * derives from this one set, so the counts on the filter, the rows in the
   * list and the markers on the map cannot disagree about who is there.
   */
  const dayRoster = useMemo(() => roster.filter(isOnTheDay), [roster]);

  const presenceCounts = useMemo(() => {
    const now = Date.now();
    let online = 0;
    for (const entry of dayRoster) if (presenceOf(entry.position, now) === 'ONLINE') online += 1;
    return { all: dayRoster.length, online, offline: dayRoster.length - online };
  }, [dayRoster]);

  const visibleRoster = useMemo(
    () =>
      presence === 'ALL'
        ? dayRoster
        : dayRoster.filter((entry) => presenceOf(entry.position) === presence),
    [dayRoster, presence],
  );

  // The markers follow the same rule, so the list and the map never disagree
  // about who is being shown -- and a marker for somebody who is offline with
  // nothing scheduled can no longer pull the map's bounds halfway round the
  // world.
  const visiblePositions = useMemo(() => {
    const onTheDay = new Set(dayRoster.map((entry) => entry.technicianId));
    return (positions.data ?? []).filter(
      (row) =>
        onTheDay.has(row.technicianId) && (presence === 'ALL' || presenceOf(row) === presence),
    );
  }, [dayRoster, positions.data, presence]);

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

  /**
   * A colour each, for the lines and the ring on each marker.
   *
   * Keyed on who is on the day rather than on the roster itself, which is
   * rebuilt from every position the socket delivers: a new map of colours each
   * time would redraw every line on the map every few seconds.
   */
  const dayKey = dayRoster
    .map((entry) => entry.technicianId)
    .sort()
    .join('|');
  const colors = useMemo(() => technicianColors(dayKey ? dayKey.split('|') : []), [dayKey]);

  /** Who is drawn, in the same stable form, for the lines' requests. */
  const visibleKey = visibleRoster.map((entry) => entry.technicianId).join('|');
  const visibleIds = useMemo(() => (visibleKey ? visibleKey.split('|') : []), [visibleKey]);

  /** The day the page shows is the one happening, so the live positions belong to it. */
  const live = date === today;

  /**
   * Everybody's lines: where they went (the office, 2026-10-02: "the trailing
   * lines") and their planned drive through the day's properties ("the lines
   * that connects to the scheduled property"). Behind the same
   * `technicians:locate` as the positions, which this page already requires.
   */
  const trails = useTechnicianTrails(visibleIds, date, live, canView);
  // Not the selected technician's: theirs is the followed route above, drawn
  // in orange, and the dashed one would be a second request for a line the map
  // does not draw.
  const contextIds = useMemo(
    () => visibleIds.filter((technicianId) => technicianId !== selectedId),
    [selectedId, visibleIds],
  );
  const crewRoutes = useTechnicianRoutes(contextIds, date, canView);

  /** The day's inspections by property: the ticks on the discs, and the links in their windows. */
  const visits = useMemo(() => visitsByProperty(assignments.data), [assignments.data]);

  /**
   * Changing a technician's day from the map (the office, 2026-10-02): the "x"
   * on a visit, and "+ Add visit". The same Assign and Unassign the inspection
   * page uses -- its permission, its audit entry, its push to Jobber -- so the
   * map is a shortcut to them and not a second set of rules.
   */
  const canAssign = permissions.has('inspections:assign');
  const canCreate = permissions.has('inspections:manage');
  const mutations = useAdminMutations();
  const refreshMapDay = useRefreshMapDay();
  /** What the "+ Add visit" panel is showing, for the map to light up. */
  const [searchMatches, setSearchMatches] = useState<string[] | null>(null);
  const searched = useMemo(() => (searchMatches ? new Set(searchMatches) : null), [searchMatches]);
  const dateLabel = useMemo(
    () =>
      fromDateValue(date)?.toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      }) ?? date,
    [date],
  );

  const removeStop = useCallback(
    async (stop: AssignedStop, technician: RosterEntry, reason: string) => {
      await mutations.unassign.mutateAsync({ id: stop.inspectionId, reason });
      refreshMapDay(date, technician.technicianId);
      toast.success(`${stop.propertyName} is off ${technician.displayName}'s day`, {
        description: 'It stays booked for the day with nobody on it.',
      });
    },
    [date, mutations.unassign, refreshMapDay],
  );

  const assignToDay = useCallback(
    async (technician: RosterEntry, inspectionId: string) => {
      await mutations.assign.mutateAsync({
        id: inspectionId,
        technicianId: technician.technicianId,
        reason: 'Added to the day on the technician map',
        idempotencyKey: crypto.randomUUID(),
      });
      refreshMapDay(date, technician.technicianId);
      toast.success(`Added to ${technician.displayName}'s day`);
    },
    [date, mutations.assign, refreshMapDay],
  );

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
          {/* Who the page is about, above everything it governs.
              
              Counts on the labels because "how many are out right now" is the
              question this page is usually opened for, and reading it should
              not require clicking a filter to discover it is empty. They count
              the whole roster, not the filtered view, or the number would
              change to match whatever was already selected. */}
          <Tabs
            onValueChange={(value) => setPresence(value as TechnicianPresence | 'ALL')}
            value={presence}
          >
            <TabsList aria-label="Filter technicians by whether they are reporting now">
              <TabsTrigger value="ALL">
                All
                <span className="text-muted-foreground ml-1.5 tabular-nums">
                  {presenceCounts.all}
                </span>
              </TabsTrigger>
              <TabsTrigger value="ONLINE">
                {/* A dot, not a colour on the word: the same signal the marker
                    uses, so the filter and the map read alike. */}
                <span
                  aria-hidden
                  className="bg-map-technician mr-1.5 inline-block size-1.5 rounded-full"
                />
                Online
                <span className="text-muted-foreground ml-1.5 tabular-nums">
                  {presenceCounts.online}
                </span>
              </TabsTrigger>
              <TabsTrigger value="OFFLINE">
                <span
                  aria-hidden
                  className="bg-map-technician-stale mr-1.5 inline-block size-1.5 rounded-full"
                />
                Offline
                <span className="text-muted-foreground ml-1.5 tabular-nums">
                  {presenceCounts.offline}
                </span>
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {/* The roster sits beside the map on a wide screen and above it on a
              narrow one. Above rather than below: on a phone the list is the
              faster answer to "who is out", and a map you have to scroll past
              to reach it is the wrong way round. */}
          <div className="grid gap-3 lg:grid-cols-[280px_minmax(0,1fr)]">
            <div
              className="bg-card flex h-[70vh] flex-col overflow-hidden rounded-lg border"
              style={fill.height ? { height: fill.height } : undefined}
            >
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
                    setAddingFor(null);
                  }}
                  value={date}
                />
              </div>
              {addingFor ? (
                /* The whole sidebar, not a box inside the list: the panel
                   scrolls its own results under a search box that stays put. */
                <div className="flex min-h-0 flex-1 flex-col">
                  <AddVisitPanel
                    canAssign={canAssign}
                    canCreate={canCreate}
                    date={date}
                    dateLabel={dateLabel}
                    onAssign={(inspectionId) => assignToDay(addingFor, inspectionId)}
                    onClose={() => setAddingFor(null)}
                    onFocusProperty={selectStop}
                    onSearchChange={setSearchMatches}
                    properties={properties.data ?? []}
                    technicianId={addingFor.technicianId}
                    technicianName={addingFor.displayName}
                  />
                </div>
              ) : (
              <div className="min-h-0 flex-1 overflow-y-auto">
                {/* Above the list, because it describes the person whose row
                    is open rather than any one stop in it. Only when somebody
                    is selected: there is no such thing as the roster's day. */}
                {selectedId && timeline.data ? (
                  <TechnicianDaySummary
                    stops={assignments.data?.find((entry) => entry.technicianId === selectedId)?.stops}
                    timeline={timeline.data}
                  />
                ) : null}

                <TechnicianRoster
                  colors={colors}
                  entries={visibleRoster}
                  onAddVisit={canAssign || canCreate ? setAddingFor : undefined}
                  onFocusTechnician={focusTechnician}
                  onRemoveStop={canAssign ? removeStop : undefined}
                  onSelect={selectTechnician}
                  onSelectStop={selectStop}
                  timeline={selectedId ? (timeline.data ?? null) : null}
                  route={selectedId ? (route.data ?? null) : null}
                  selectedId={selectedId}
                  selectedStopBuildingId={selectedPropertyId}
                />
              </div>
              )}
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
            <div
              className="relative isolate h-[70vh] w-full overflow-hidden rounded-lg border"
              ref={fill.ref}
              style={fill.height ? { height: fill.height } : undefined}
            >
              <TechnicianMap
                colors={colors}
                crewRoutes={crewRoutes}
                currentInspectionIds={
                  selectedId ? (timeline.data?.projection.current?.inspectionIds ?? null) : null
                }
                followRequest={followRequest}
                highlightedBuildingIds={highlighted}
                live={live}
                onFocusTechnician={focusTechnician}
                onSelectTechnician={selectTechnician}
                positions={visiblePositions}
                properties={properties.data ?? []}
                route={selectedId ? (route.data ?? null) : null}
                searchedPropertyIds={searched}
                selectedPropertyId={selectedPropertyId}
                selectedTechnicianId={selectedId}
                trails={trails}
                visits={visits}
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
            <LegendKey swatch={<DrivingSwatch />}>Driving, pointing the way they are going</LegendKey>
            <LegendKey swatch={<TechnicianSwatch stale />}>
              Technician, over 30 minutes ago
            </LegendKey>
            {discCounts ? (
              <>
                <LegendKey swatch={<DiscSwatch kind="GROUP" />}>
                  TBP property, in its group&rsquo;s colour ({discCounts.group})
                </LegendKey>
                <LegendKey swatch={<DiscSwatch kind="LOOSE" />}>TBP, in no group ({discCounts.loose})</LegendKey>
                <LegendKey swatch={<DiscSwatch kind="OTHER" />}>Not on TBP ({discCounts.other})</LegendKey>
              </>
            ) : (
              <LegendKey swatch={<DiscSwatch kind="OTHER" />}>
                Property {properties.data?.length ? `(${properties.data.length})` : null}
              </LegendKey>
            )}
            <LegendKey swatch={<DoneSwatch />}>Inspection submitted that day</LegendKey>
            <LegendKey swatch={<LineSwatch />}>Where they drove, in their colour</LegendKey>
            <LegendKey swatch={<LineSwatch dashed />}>Route on to the day&rsquo;s properties</LegendKey>
          </div>
        </div>
      )}
    </>
  );
}
