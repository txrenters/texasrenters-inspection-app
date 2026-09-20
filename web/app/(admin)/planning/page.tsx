'use client';

import { closedDaysOfQuarter, zoneNumberOf, type Quarter } from '@texasrenters/shared';
import { CalendarRangeIcon, RefreshCwIcon, RouteIcon, SendIcon } from 'lucide-react';
import dynamic from 'next/dynamic';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import { OfficeSheetImport } from '@/components/planning/office-sheet-import';
import type { AttentionMapStop } from '@/components/planning/plan-attention-map';
import { PlanBuildDialog, type PlanBuildChoice } from '@/components/planning/plan-build-dialog';
import { PlanCalendar } from '@/components/planning/plan-calendar';
import { bookedProblem, PlanDays } from '@/components/planning/plan-days';
import { PlanStopDialog } from '@/components/planning/plan-stop-dialog';
import { PlanStopsTable } from '@/components/planning/plan-stops-table';
import { PageHeader } from '@/components/page-header';
import { Stat, StatGroup, StatStrip, StatStripItem } from '@/components/stat-card';
import { EmptyState, ErrorState, PageSkeleton } from '@/components/states';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { usePermissions } from '@/lib/auth';
import { formatRelative } from '@/lib/format';
import {
  attentionOf,
  bookedInWords,
  dayOutsideRules,
  formatMinutes,
  formatShortDay,
  needsUnit,
  planStartText,
  quarterChoices,
  quarterKey,
  quarterName,
} from '@/lib/planning';
import {
  usePlanDays,
  usePlanQuarters,
  usePlanRotation,
  usePlanStops,
  usePlanningMutations,
  type PlanStatus,
} from '@/lib/planning-queries';
import { useUrlState } from '@/lib/url-state';

/**
 * A quarter of Tenant Benefit Package visits, before and after it is booked.
 *
 * The office's rules, as the planner applies them: whoever was first last
 * quarter is first again; Q2 and Q4 visits are HVAC inspections for tenancies
 * on the HVAC plan; the visits are grouped into days of nine for the least
 * driving, never more than twenty minutes from one property to the next, and a
 * tenth where it is within five minutes of the day (2026-09-19 and -20); a day
 * short of nine fills from the fuller days near it; everyone chosen works every
 * day from the plan's first until every visit has a day -- the quarter is
 * finished as early as the crew can and the days after that stay empty
 * (2026-09-20) -- each taking a group in their zone of the week and moving on
 * each week, with a property within five minutes of a group joining it; a zone too far for a day's drive
 * is a trip of days in a row for whoever lives nearest; visits go on weekdays
 * that are not US holidays, with Mondays from the second week kept for
 * rescheduled visits. Building a quarter asks two things only -- who goes out,
 * and the first day, up to fifteen days either side of the quarter's
 * (2026-09-19) -- and applies the rest (the office found a form of minutes and
 * closed days confusing, 2026-09-16). This page is where a coordinator checks
 * the days, changes any draft visit in its window -- the day, technician, unit,
 * title, Details -- and publishes, which creates the inspections and queues
 * their visits for Jobber.
 */

/** Google Maps touches `window` and measures its container, so it is never rendered on the server. */
const PlanAttentionMap = dynamic(() => import('@/components/planning/plan-attention-map').then((module) => module.PlanAttentionMap), {
  ssr: false,
  loading: () => <Skeleton className="h-full w-full rounded-lg" />,
});

const STATUS: Record<PlanStatus, { label: string; variant: 'secondary' | 'info' | 'success' | 'destructive' | 'outline' }> = {
  DRAFT: { label: 'Draft', variant: 'secondary' },
  PUBLISHING: { label: 'Publishing', variant: 'info' },
  PUBLISHED: { label: 'Published', variant: 'success' },
  PUBLISH_FAILED: { label: 'Publish failed', variant: 'destructive' },
  CANCELLED: { label: 'Cancelled', variant: 'outline' },
};

export default function PlanningPage() {
  const { has } = usePermissions();
  const canChange = has('planning:publish');
  const [state, setState] = useUrlState({ quarter: '', tab: 'days', day: '' });
  const quarters = usePlanQuarters();
  const choices = useMemo(() => quarterChoices(quarters.data ?? [], new Date()), [quarters.data]);
  const choice = choices.find((entry) => entry.key === state.quarter) ?? choices[0]!;
  const plan =
    quarters.data?.find((entry) => quarterKey(entry.quarterYear, entry.quarterNumber) === choice.key) ?? null;
  const stops = usePlanStops(plan?.id);
  const days = usePlanDays(plan?.id);
  const rotation = usePlanRotation(plan?.id);
  const mutations = usePlanningMutations();
  const [publishing, setPublishing] = useState(false);
  // Build and Rebuild ask who goes out and the first day before anything is laid out (2026-09-19).
  const [choosing, setChoosing] = useState(false);
  // The visit whose details are open, from its pin, its row in a day, or the tables.
  const [openStopId, setOpenStopId] = useState<string | null>(null);

  const draft = plan?.status === 'DRAFT';
  const building = mutations.build.isPending;
  // Blocked or failed, or on a day but still without the unit it is booked at.
  const attention = (stops.data ?? []).filter(
    (stop) => stop.status === 'BLOCKED' || stop.status === 'FAILED' || needsUnit(stop),
  );
  const review = (stops.data ?? []).filter(
    (stop) => stop.inspectionTypeNeedsReview && stop.status !== 'EXCLUDED' && stop.status !== 'PUBLISHED',
  );
  const attentionIds = new Set([...attention, ...review].map((stop) => stop.id));
  const bookedToCheck = (days.data ?? []).flatMap((day) =>
    (day.anchors ?? []).flatMap((anchor) => {
      const problem = bookedProblem(day, anchor, anchor.kind);
      return problem ? [{ day, anchor, problem }] : [];
    }),
  );
  const daysOutsideRules = plan ? (days.data ?? []).filter((day) => dayOutsideRules(day, plan)) : [];
  const planned = (stops.data ?? []).filter((stop) => stop.status === 'PLANNED');
  // A zone too far for a day's drive is a trip (the office, 2026-09-18): who goes, and when.
  const trips = (rotation.data?.outOfReach ?? []).map((zone) => {
    const tripDays = (days.data ?? [])
      .filter((day) => day.stops.length > 0 && day.stops.every((stop) => zoneNumberOf(stop.zone) === zone))
      .sort((left, right) => left.date.localeCompare(right.date));
    if (tripDays.length === 0) return `Zone ${zone}: a trip for whoever lives nearest, planned at the next Rebuild`;
    const first = formatShortDay(tripDays[0]!.date.slice(0, 10));
    const last = formatShortDay(tripDays[tripDays.length - 1]!.date.slice(0, 10));
    return `Zone ${zone}: a ${tripDays.length}-day trip, ${tripDays[0]!.technician.displayName}, ${
      tripDays.length > 1 ? `${first} – ${last}` : first
    }`;
  });
  const technicians = new Set((days.data ?? []).map((day) => day.technicianId));
  // Every visit still waiting for something, on one map, with the planned ones
  // behind them: the office asked to see where they are, as Jobber shows its
  // unscheduled appointments (2026-09-20).
  const onMap = (stop: (typeof attention)[number]): AttentionMapStop => ({
    id: stop.id,
    address: stop.propertywareUnit?.addressLine1 ?? stop.tenant.addressLine1,
    city: stop.tenant.city,
    latitude: stop.latitude,
    longitude: stop.longitude,
    attention: attentionOf(stop) ?? 'KIND_TO_CHECK',
  });
  const needingMap = (stops.data ?? []).filter((stop) => attentionIds.has(stop.id)).map(onMap);
  const plannedMap = planned
    .filter((stop) => !attentionIds.has(stop.id))
    .map((stop) => ({ ...onMap(stop), attention: null }));
  const withoutLocation = needingMap.filter((stop) => stop.latitude === null || stop.longitude === null).length;
  const openStop = openStopId ? ((stops.data ?? []).find((stop) => stop.id === openStopId) ?? null) : null;
  const openStopDay = openStopId
    ? ((days.data ?? []).find((day) => day.stops.some((stop) => stop.id === openStopId)) ?? null)
    : null;

  // The weekdays the planner skipped: the quarter's US holidays, and any other
  // day closed on the plan, listed apart so a holiday is never mislabelled.
  const quarter: Quarter = { year: choice.year, quarter: choice.quarter as Quarter['quarter'] };
  const startsOn = plan?.startsOn ? plan.startsOn.slice(0, 10) : null;
  const holidays = closedDaysOfQuarter(quarter, [], startsOn);
  const alsoClosed = closedDaysOfQuarter(quarter, plan?.holidays ?? [], startsOn).filter((day) => !holidays.includes(day));

  const build = (picked: PlanBuildChoice) => {
    setChoosing(false);
    // One toast from the click to the result. A build takes minutes, and a
    // spinner on a small button alone reads as a page that has hung.
    const id = `plan-build-${choice.key}`;
    toast.loading(`Building ${choice.label}`, {
      id,
      description: 'Drive times come from Google at a steady pace, so this takes a few minutes. Keep this page open.',
    });
    mutations.build.mutate(
      { year: choice.year, quarter: choice.quarter, ...picked },
      {
        onSuccess: (result) => {
          toast.success(`${choice.label} is planned`, {
            id,
            description: `${result.routing.placed.toLocaleString()} visits over ${result.routing.days.toLocaleString()} technician-days${
              result.routing.unplaced.length ? `; ${result.routing.unplaced.length} need attention` : ''
            }.`,
          });
        },
        onError: (error) => toast.error(`${choice.label} could not be planned`, { id, description: error.message }),
      },
    );
  };

  const publish = () => {
    if (!plan) return;
    mutations.publish.mutate(plan.id, {
      onSuccess: (result) => {
        setPublishing(false);
        if (result.failed)
          toast.error(`${result.failed} visits could not be published`, {
            description: 'Their reasons are on the visits; publishing again picks up where this stopped.',
          });
        else toast.success(`${(result.published + result.adopted).toLocaleString()} inspections created for ${choice.label}`);
      },
      onError: (error) => toast.error(`${choice.label} could not be published`, { description: error.message }),
    });
  };

  const header = (
    <PageHeader
      actions={
        <>
          <Select onValueChange={(quarter) => setState({ quarter, day: '' })} value={choice.key}>
            <SelectTrigger aria-label="Quarter" className="w-32" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {choices.map((entry) => (
                <SelectItem key={entry.key} value={entry.key}>
                  {entry.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {canChange && draft && plan ? (
            <>
              <OfficeSheetImport planId={plan.id} />
              <Button
                disabled={building}
                onClick={() => setChoosing(true)}
                size="sm"
                title="Reads the tenant report again and lays the days out again, for the technicians and from the first day you choose. Every change a coordinator made to a visit is kept."
                variant="outline"
              >
                {building ? <Spinner /> : <RefreshCwIcon />}
                Rebuild
              </Button>
              <Button
                disabled={building || attention.length > 0 || planned.length === 0}
                onClick={() => setPublishing(true)}
                size="sm"
                title={attention.length ? 'Resolve or leave out every visit that needs attention first.' : undefined}
              >
                <SendIcon />
                Publish
              </Button>
            </>
          ) : null}
          {canChange && plan?.status === 'PUBLISH_FAILED' ? (
            <Button disabled={mutations.publish.isPending} onClick={() => setPublishing(true)} size="sm">
              <SendIcon />
              Publish the rest
            </Button>
          ) : null}
        </>
      }
      badges={plan ? <Badge variant={STATUS[plan.status].variant}>{STATUS[plan.status].label}</Badge> : null}
      description="Each quarter's Tenant Benefit Package visits, in last quarter's order. Building asks who goes out and the first day, up to 15 days either side of the quarter's. The visits are grouped into days of 9 for the least driving, never more than 20 minutes from one property to the next; a day takes a 10th while that property is within 5 minutes of it, and a day short of 9 fills from the fuller days near it, so none is left with one or two. Everyone chosen works every day from the plan's first until every visit has a day: the quarter is finished as early as the crew can, and the days left at the end of it stay empty. Visits are taken up in last quarter's order, the month of the quarter they were visited in first. A day with a move-out or move-in is built around it, with 3 visits fewer for each. Each technician takes a group in their zone of the week and moves to the next zone the week after, and a property within 5 minutes of a group joins it whatever its zone. A zone too far for a day's drive is a trip of days in a row for whoever lives nearest. US holidays are off, and Mondays from the second week are kept free for rescheduled visits."
      title="Benefit package plan"
    />
  );

  if (quarters.isLoading)
    return (
      <>
        {header}
        <PageSkeleton cards={2} />
      </>
    );
  if (quarters.isError)
    return (
      <>
        {header}
        <ErrorState error={quarters.error} retry={() => void quarters.refetch()} />
      </>
    );

  return (
    <>
      {header}

      {!plan ? (
        <EmptyState
          description={`Build it from the tenant report: every enrolled tenancy, in ${quarterName(
            choice.quarter === 1 ? choice.year - 1 : choice.year,
            choice.quarter === 1 ? 4 : choice.quarter - 1,
          )}'s order${choice.quarter % 2 === 0 ? ', with HVAC inspections for tenancies on the HVAC plan' : ', each an occupied inspection'}. Nothing is booked until it is published.`}
          icon={CalendarRangeIcon}
          title={`No plan for ${choice.label} yet`}
        >
          {canChange ? (
            <Button disabled={building} onClick={() => setChoosing(true)}>
              {building ? <Spinner /> : <RouteIcon />}
              Build the {choice.label} plan
            </Button>
          ) : null}
        </EmptyState>
      ) : (
        <div className="grid gap-4">
          {plan.lastError ? (
            <Alert variant="destructive">
              <AlertTitle>The last publish did not finish</AlertTitle>
              <AlertDescription>{plan.lastError}</AlertDescription>
            </Alert>
          ) : null}

          {bookedToCheck.length ? (
            // Days are built around move-outs and move-ins (the office, 2026-09-17 and -18), so one that
            // moved, was cancelled or is not with the day's technician makes that day wrong until fixed.
            <Alert>
              <AlertTitle>{bookedInWords(bookedToCheck.map(({ anchor }) => anchor), 'count')} to check</AlertTitle>
              <AlertDescription>
                <ul className="grid gap-0.5">
                  {bookedToCheck.map(({ day, anchor, problem }) => (
                    <li key={anchor.id}>
                      {formatShortDay(day.date.slice(0, 10))}, {day.technician.displayName} · {anchor.address ?? 'Unknown address'}: {problem}
                    </li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          ) : null}

          <StatGroup columns="grid-cols-2 lg:grid-cols-4">
            <Stat
              detail={`${plan.hvacStopCount.toLocaleString()} HVAC · ${plan.occupiedStopCount.toLocaleString()} occupied`}
              label="Visits"
              value={(plan.hvacStopCount + plan.occupiedStopCount).toLocaleString()}
            />
            <Stat
              detail={`${technicians.size} ${technicians.size === 1 ? 'technician' : 'technicians'}`}
              label="Technician-days"
              value={(days.data?.length ?? 0).toLocaleString()}
            />
            <Stat
              detail={review.length ? `${review.length} to check the kind of visit` : 'Resolve or leave out before publishing'}
              label="Needs attention"
              tone={attention.length ? 'warning' : 'default'}
              value={attention.length.toLocaleString()}
            />
            <Stat
              detail={`Over ${plan.maxStopsPerDay} visits, ${formatMinutes(plan.maxOnSiteMinutes)} inspecting, or ${plan.maxLegMinutes} min between properties`}
              label="Days outside the rules"
              tone={daysOutsideRules.length ? 'destructive' : 'success'}
              value={daysOutsideRules.length.toLocaleString()}
            />
          </StatGroup>

          <StatStrip>
            <StatStripItem label="First day" value={planStartText(quarter, startsOn)} />
            <StatStripItem
              label="Working days"
              value={`Weekdays except US holidays${holidays.length ? `: ${holidays.map(formatShortDay).join(', ')}` : ''}`}
            />
            {alsoClosed.length ? (
              <StatStripItem label="Also closed" value={alsoClosed.map(formatShortDay).join(', ')} />
            ) : null}
            <StatStripItem
              label="Visits a day"
              value={`${plan.minStopsPerDay}, and up to ${plan.maxStopsPerDay} where the properties are within 5 minutes of each other`}
            />
            <StatStripItem
              label="Between properties"
              value={`never more than ${plan.maxLegMinutes} min from one to the next; fewer visits where they are further apart`}
            />
            <StatStripItem label="Neighbours" value="a property within 5 minutes of a group joins it, whatever its zone" />
            <StatStripItem label="Mondays" value="kept free for rescheduled visits from week 2" />
            {rotation.data ? (
              <StatStripItem
                label="Crew"
                value={
                  rotation.data.crew.length
                    ? `${rotation.data.crew.map((member) => member.displayName ?? 'Someone').join(', ')} · ${
                        plan.crewTechnicianIds?.length ? 'chosen for this plan' : 'the crew on the planning profiles'
                      } · a zone each, moving weekly`
                    : 'nobody yet: choose who goes out when you rebuild'
                }
              />
            ) : null}
            {trips.length ? <StatStripItem label={trips.length === 1 ? 'Trip' : 'Trips'} value={trips.join(' · ')} /> : null}
            <StatStripItem
              label="Details"
              value={plan.officeDetailsImportedAt ? `office sheet, ${formatRelative(plan.officeDetailsImportedAt)}` : 'from the tenant report'}
            />
            <StatStripItem label="Built" value={formatRelative(plan.generatedAt)} />
          </StatStrip>

          <Tabs onValueChange={(tab) => setState({ tab })} value={state.tab}>
            <TabsList>
              <TabsTrigger value="days">Days ({(days.data?.length ?? 0).toLocaleString()})</TabsTrigger>
              <TabsTrigger value="calendar">Calendar</TabsTrigger>
              <TabsTrigger value="visits">Visits ({(stops.data?.length ?? 0).toLocaleString()})</TabsTrigger>
              <TabsTrigger value="attention">Needs attention ({attentionIds.size.toLocaleString()})</TabsTrigger>
            </TabsList>

            <TabsContent className="mt-3" value="days">
              {days.isLoading ? (
                <PageSkeleton cards={1} />
              ) : days.isError ? (
                <ErrorState error={days.error} retry={() => void days.refetch()} />
              ) : !days.data?.length ? (
                <EmptyState
                  description="No visit has a day yet. Rebuild the plan to place them."
                  icon={CalendarRangeIcon}
                  title="No technician-days"
                />
              ) : (
                <PlanDays
                  days={days.data}
                  onOpenStop={setOpenStopId}
                  rotation={rotation.data ?? null}
                  onSelect={(day) => setState({ day })}
                  planId={plan.id}
                  selectedDayId={state.day}
                  settings={plan}
                />
              )}
            </TabsContent>

            <TabsContent className="mt-3" value="calendar">
              {days.isLoading ? (
                <PageSkeleton cards={1} />
              ) : days.isError ? (
                <ErrorState error={days.error} retry={() => void days.refetch()} />
              ) : !days.data?.length ? (
                <EmptyState
                  description="No visit has a day yet. Rebuild the plan to place them."
                  icon={CalendarRangeIcon}
                  title="No technician-days"
                />
              ) : (
                // A day chosen here opens in the Days tab, with its route and visits.
                <PlanCalendar
                  days={days.data}
                  onSelect={(day) => setState({ tab: 'days', day })}
                  quarter={quarter}
                  rotation={rotation.data ?? null}
                  selectedDayId={state.day}
                  settings={plan}
                  startsOn={startsOn}
                />
              )}
            </TabsContent>

            <TabsContent className="mt-3" value="visits">
              {stops.isLoading ? (
                <PageSkeleton cards={1} />
              ) : stops.isError ? (
                <ErrorState error={stops.error} retry={() => void stops.refetch()} />
              ) : (
                <PlanStopsTable editable={canChange && draft} onOpen={setOpenStopId} stops={stops.data ?? []} />
              )}
            </TabsContent>

            <TabsContent className="mt-3" value="attention">
              {stops.isLoading ? (
                <PageSkeleton cards={1} />
              ) : attentionIds.size === 0 ? (
                <EmptyState
                  description="Every visit has a day and a technician inside the limits, and every kind of visit is settled by the tenant report."
                  title="Nothing needs attention"
                />
              ) : (
                <div className="grid gap-3">
                  <div className="h-80 lg:h-[30rem]">
                    <PlanAttentionMap onSelectStop={setOpenStopId} planned={plannedMap} stops={needingMap} />
                  </div>
                  <p className="text-muted-foreground text-xs">
                    Every visit waiting for something, with the visits already planned behind them in grey. Click one to
                    give it a day and a technician.
                    {withoutLocation
                      ? ` ${withoutLocation.toLocaleString()} ${withoutLocation === 1 ? 'is' : 'are'} not on the map: Propertyware has no location for the property.`
                      : ''}
                  </p>
                  <PlanStopsTable
                    allStops={stops.data ?? []}
                    editable={canChange && draft}
                    onOpen={setOpenStopId}
                    stops={(stops.data ?? []).filter((stop) => attentionIds.has(stop.id))}
                  />
                </div>
              )}
            </TabsContent>
          </Tabs>
        </div>
      )}

      <PlanStopDialog
        closedDays={closedDaysOfQuarter(quarter, plan?.holidays ?? [], startsOn)}
        day={openStopDay}
        editable={canChange && draft}
        onOpenChange={(open) => !open && setOpenStopId(null)}
        quarter={quarter}
        startsOn={startsOn}
        stop={openStop}
      />

      <PlanBuildDialog
        chosen={plan?.crewTechnicianIds ?? []}
        label={choice.label}
        onBuild={build}
        onOpenChange={setChoosing}
        open={choosing}
        pending={building}
        quarter={quarter}
        rebuild={Boolean(plan)}
        startsOn={startsOn}
      />

      <AlertDialog onOpenChange={setPublishing} open={publishing}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Publish {choice.label}?</AlertDialogTitle>
            <AlertDialogDescription>
              This creates {planned.length.toLocaleString()} inspections —{' '}
              {planned.filter((stop) => stop.inspectionType === 'HVAC').length.toLocaleString()} HVAC and{' '}
              {planned.filter((stop) => stop.inspectionType === 'OCCUPIED').length.toLocaleString()} occupied — on their
              planned days, assigned to their technicians, and queues each visit to be booked in Jobber with the
              office&rsquo;s Details. There is no bulk undo.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Not yet</AlertDialogCancel>
            <AlertDialogAction
              disabled={mutations.publish.isPending}
              onClick={(event) => {
                event.preventDefault();
                publish();
              }}
            >
              {mutations.publish.isPending ? <Spinner /> : null}
              Publish {planned.length.toLocaleString()} inspections
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
