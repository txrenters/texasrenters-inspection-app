'use client';

import { closedDaysOfQuarter, zoneNumberOf, type Quarter } from '@texasrenters/shared';
import { CalendarRangeIcon, RefreshCwIcon, RouteIcon, SendIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import { OfficeSheetImport } from '@/components/planning/office-sheet-import';
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
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { usePermissions } from '@/lib/auth';
import { formatRelative } from '@/lib/format';
import {
  bookedInWords,
  dayOutsideRules,
  formatMinutes,
  formatShortDay,
  needsUnit,
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
 * on the HVAC plan; the whole crew works every day from the quarter's start
 * until every visit has a day, each starting in their zone of the week and
 * moving on each week, with a property within five minutes of a day's visits
 * joining it; a zone too far for a day's drive is a trip of days in a row for
 * whoever lives nearest; visits go on weekdays that are not US holidays, with
 * Mondays from the second week kept for rescheduled visits; and every
 * technician-day holds nine to twelve visits, laid out for the least driving,
 * which has no limit (the office, 2026-09-18). Building a quarter
 * applies all of it and asks the coordinator nothing (the office found a form
 * of minutes and closed days confusing, 2026-09-16). This page is where a
 * coordinator checks the days, changes any draft visit in its window -- the
 * day, technician, unit, title, Details -- and publishes, which creates the
 * inspections and queues their visits for Jobber.
 */

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
  const openStop = openStopId ? ((stops.data ?? []).find((stop) => stop.id === openStopId) ?? null) : null;
  const openStopDay = openStopId
    ? ((days.data ?? []).find((day) => day.stops.some((stop) => stop.id === openStopId)) ?? null)
    : null;

  // The weekdays the planner skipped: the quarter's US holidays, and any other
  // day closed on the plan, listed apart so a holiday is never mislabelled.
  const quarter: Quarter = { year: choice.year, quarter: choice.quarter as Quarter['quarter'] };
  const holidays = closedDaysOfQuarter(quarter);
  const alsoClosed = closedDaysOfQuarter(quarter, plan?.holidays ?? []).filter((day) => !holidays.includes(day));

  const build = () => {
    // One toast from the click to the result. A build takes minutes, and a
    // spinner on a small button alone reads as a page that has hung.
    const id = `plan-build-${choice.key}`;
    toast.loading(`Building ${choice.label}`, {
      id,
      description: 'Drive times come from Google at a steady pace, so this takes a few minutes. Keep this page open.',
    });
    mutations.build.mutate(
      { year: choice.year, quarter: choice.quarter },
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
                onClick={build}
                size="sm"
                title="Reads the tenant report again and lays the days out again. Every kind of visit a coordinator chose is kept."
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
      description="Each quarter's Tenant Benefit Package visits, in last quarter's order. The whole crew works every day from the start of the quarter until every visit has a day, 9 to 12 visits each, laid out for the least driving. A day with a move-out or move-in is built around it, with 3 visits fewer for each. Each technician starts in their zone of the week and moves to the next zone the week after, and a property within 5 minutes of a day's visits joins that day whatever its zone. A zone too far for a day's drive is a trip of days in a row for whoever lives nearest. US holidays are off, and Mondays from the second week are kept free for rescheduled visits."
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
            <Button disabled={building} onClick={build}>
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
              detail={`${plan.minStopsPerDay} to ${plan.maxStopsPerDay} visits and up to ${formatMinutes(plan.maxOnSiteMinutes)} inspecting a day`}
              label="Days outside the rules"
              tone={daysOutsideRules.length ? 'destructive' : 'success'}
              value={daysOutsideRules.length.toLocaleString()}
            />
          </StatGroup>

          <StatStrip>
            <StatStripItem
              label="Working days"
              value={`Weekdays except US holidays${holidays.length ? `: ${holidays.map(formatShortDay).join(', ')}` : ''}`}
            />
            {alsoClosed.length ? (
              <StatStripItem label="Also closed" value={alsoClosed.map(formatShortDay).join(', ')} />
            ) : null}
            <StatStripItem
              label="Visits a day"
              value={`${plan.minStopsPerDay} to ${plan.maxStopsPerDay} every day, the whole crew every day until every visit has one`}
            />
            <StatStripItem label="Neighbours" value="a property within 5 minutes of a day joins it, whatever its zone" />
            <StatStripItem label="Mondays" value="kept free for rescheduled visits from week 2" />
            {rotation.data ? (
              <StatStripItem
                label="Crew"
                value={
                  rotation.data.crew.length
                    ? `${rotation.data.crew.map((member) => member.displayName ?? 'Someone').join(', ')} · a zone each, moving weekly`
                    : 'nobody yet: set on the technicians’ planning profiles'
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
                <PlanStopsTable
                  allStops={stops.data ?? []}
                  editable={canChange && draft}
                  onOpen={setOpenStopId}
                  stops={(stops.data ?? []).filter((stop) => attentionIds.has(stop.id))}
                />
              )}
            </TabsContent>
          </Tabs>
        </div>
      )}

      <PlanStopDialog
        closedDays={closedDaysOfQuarter(quarter, plan?.holidays ?? [])}
        day={openStopDay}
        editable={canChange && draft}
        onOpenChange={(open) => !open && setOpenStopId(null)}
        quarter={quarter}
        stop={openStop}
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
