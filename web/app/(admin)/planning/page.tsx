'use client';

import { closedDaysOfQuarter, zoneNumberOf, type Quarter } from '@texasrenters/shared';
import { CalendarRangeIcon, EllipsisIcon, FileSpreadsheetIcon, MapIcon, RefreshCwIcon, RouteIcon, SendIcon, WindIcon } from 'lucide-react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import { GroupFileView, useGroupFileChoice, useGroupFilePicker, type LoadedGroupFile } from '@/components/planning/group-file-view';
import { useOfficeSheetImport } from '@/components/planning/office-sheet-import';
import type { AttentionMapStop } from '@/components/planning/plan-attention-map';
import { PlanBuildDialog, type PlanBuildChoice } from '@/components/planning/plan-build-dialog';
import type { CalendarView } from '@/components/planning/plan-calendar';
import { LateMoveOutsPanel } from '@/components/planning/late-move-outs';
import { PlanRules } from '@/components/planning/plan-rules';
import { bookedProblem, PlanSchedule } from '@/components/planning/plan-schedule';
import { PlanStopDialog } from '@/components/planning/plan-stop-dialog';
import { PlanStopsTable } from '@/components/planning/plan-stops-table';
import { PageHeader } from '@/components/page-header';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { usePermissions } from '@/lib/auth';
import { businessToday } from '@/lib/clock';
import { formatRelative } from '@/lib/format';
import {
  attentionOf,
  bookedInWords,
  dayOutsideRules,
  formatShortDay,
  needsUnit,
  planStartText,
  quarterChoices,
  quarterKey,
  quarterName,
} from '@/lib/planning';
import {
  usePlanDays,
  usePlanLateMoveOuts,
  usePlanQuarters,
  usePlanRotation,
  usePlanStops,
  usePlanningMutations,
  type PlanStatus,
} from '@/lib/planning-queries';
import { useUrlState } from '@/lib/url-state';
import { cn } from '@/lib/utils';

/**
 * A quarter of Tenant Benefit Package visits, before and after it is booked.
 *
 * The office's rules, as the planner applies them: Q2 and Q4 visits are HVAC inspections for tenancies
 * on the HVAC plan; the visits are grouped into days of nine for the least
 * driving, never more than twenty minutes from one property to the next, and a
 * tenth where it is within five minutes of the day (2026-09-19 and -20); a day
 * short of nine fills from the fuller days near it; everyone chosen works every
 * day from the plan's first until every visit has a day -- the quarter is
 * finished as early as the crew can and the days after that stay empty
 * (2026-09-20) -- each taking a group in a zone of their own each day and moving
 * one zone on each day, the group furthest from downtown Houston first
 * (2026-10-03), with a property within five minutes of a group joining it; a zone too far for a day's drive
 * is a trip of days in a row for whoever lives nearest; visits go on weekdays
 * that are not US holidays, with Mondays from the second week kept for
 * rescheduled visits. Building a quarter asks two things only -- who goes out,
 * and the first day, up to fifteen days either side of the quarter's
 * (2026-09-19) -- and applies the rest (the office found a form of minutes and
 * closed days confusing, 2026-09-16). This page is where a coordinator checks
 * the days, changes any draft visit in its window -- the day, technician, unit,
 * title, Details -- and publishes, which creates the inspections and queues
 * their visits for Jobber.
 *
 * Two tabs since 2026-10-05, when the office found seven too many: the
 * Schedule -- the calendar beside the map, as Jobber's -- and the Visits, one
 * table with the scheduled, unscheduled and needing attention a click apart.
 * The rules are behind an ⓘ rather than above every plan.
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

type VisitFilter = 'all' | 'scheduled' | 'unscheduled' | 'attention';

const VISIT_FILTERS: VisitFilter[] = ['all', 'scheduled', 'unscheduled', 'attention'];

/** The tabs this page had before 2026-10-05, so a bookmark to one still lands where its content went. */
const OLD_TABS: Record<string, { tab: 'schedule' | 'visits'; show?: VisitFilter }> = {
  days: { tab: 'schedule' },
  calendar: { tab: 'schedule' },
  groups: { tab: 'schedule' },
  scheduled: { tab: 'visits', show: 'scheduled' },
  unscheduled: { tab: 'visits', show: 'unscheduled' },
  attention: { tab: 'visits', show: 'attention' },
};

const CALENDAR_VIEWS: CalendarView[] = ['month', 'week', 'day'];

export default function PlanningPage() {
  const { has } = usePermissions();
  const canChange = has('planning:publish');
  const [state, setState] = useUrlState({ quarter: '', tab: 'schedule', day: '', view: 'month', show: 'all' });
  const tab = state.tab === 'visits' ? 'visits' : (OLD_TABS[state.tab]?.tab ?? 'schedule');
  const show: VisitFilter =
    OLD_TABS[state.tab]?.show ?? (VISIT_FILTERS.includes(state.show as VisitFilter) ? (state.show as VisitFilter) : 'all');
  const view: CalendarView = CALENDAR_VIEWS.includes(state.view as CalendarView) ? (state.view as CalendarView) : 'month';
  const quarters = usePlanQuarters();
  const choices = useMemo(() => quarterChoices(quarters.data ?? [], new Date()), [quarters.data]);
  const choice = choices.find((entry) => entry.key === state.quarter) ?? choices[0]!;
  const plan =
    quarters.data?.find((entry) => quarterKey(entry.quarterYear, entry.quarterNumber) === choice.key) ?? null;
  const stops = usePlanStops(plan?.id);
  const days = usePlanDays(plan?.id);
  const rotation = usePlanRotation(plan?.id);
  const mutations = usePlanningMutations();
  const officeSheet = useOfficeSheetImport(plan?.id);
  /**
   * A groups file drawn in place of the calendar: the server's, or one chosen
   * here (the office works groupings out in a spreadsheet too). Never stored in
   * the browser: it names tenants.
   */
  const groupFiles = useGroupFileChoice();
  const mapGroupFile = (loaded: LoadedGroupFile) => {
    groupFiles.choose(loaded);
    setState({ tab: 'schedule', show: 'all' });
  };
  const groupFilePicker = useGroupFilePicker(mapGroupFile);
  const [publishing, setPublishing] = useState(false);
  // Build and Rebuild ask who goes out and the first day before anything is laid out (2026-09-19).
  const [choosing, setChoosing] = useState(false);
  // The visit whose details are open, from its pin, its row in a day, or the table.
  const [openStopId, setOpenStopId] = useState<string | null>(null);
  /** Every visit as the schedule's map draws it: with its day, or none yet. */
  const dayStops = useMemo(
    () =>
      (stops.data ?? []).map((stop) => ({
        id: stop.id,
        latitude: stop.latitude,
        longitude: stop.longitude,
        scheduledOn: stop.scheduledOn,
        positionInDay: stop.positionInDay,
        technician: stop.assignedTechnician,
        zone: stop.zone,
        address: stop.propertywareUnit?.addressLine1 ?? stop.tenant.addressLine1,
        unit: stop.propertywareUnit?.name ?? null,
        city: stop.tenant.city,
        postalCode: stop.tenant.postalCode,
        lease: stop.tenant.leaseName,
        hvacPlan: stop.tenant.hvacPlan,
        status: stop.status,
      })),
    [stops.data],
  );

  const draft = plan?.status === 'DRAFT';
  // A published quarter is still open for the visits it could not place: they
  // have no inspection, and giving one a day here is what makes it real
  // (2026-09-20). The table and the visit's window refuse a published or
  // excluded visit themselves.
  const canPlace = canChange && (draft || plan?.status === 'PUBLISHED' || plan?.status === 'PUBLISH_FAILED');
  /**
   * Move-outs booked onto a published day since the plan (2026-10-01): only a
   * published quarter has visits to move. Moving one reschedules it, here and
   * in Jobber, so it takes the inspections grant as well as the planner's.
   */
  const lateMoveOuts = usePlanLateMoveOuts(plan?.id, plan?.status === 'PUBLISHED' || plan?.status === 'PUBLISH_FAILED');
  const canMoveVisits = canChange && has('inspections:manage');
  const moveToMonday = (conflict: { date: string; technician: { id: string } }, inspectionIds: string[]) => {
    if (!plan) return;
    mutations.moveToMonday.mutate(
      { planId: plan.id, date: conflict.date, technicianId: conflict.technician.id, inspectionIds },
      {
        onSuccess: (result) => {
          const moved = `${result.moved.toLocaleString()} ${result.moved === 1 ? 'visit' : 'visits'} moved to ${formatShortDay(result.monday)}`;
          if (result.failed.length)
            toast.warning(moved, {
              description: `${result.failed.length.toLocaleString()} could not be: ${result.failed.map((entry) => entry.message).join(' ')}`,
            });
          else toast.success(moved, { description: 'Here and in Jobber.' });
        },
        onError: (error) => toast.error('The visits were not moved', { description: error.message }),
      },
    );
  };
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
      const problem = bookedProblem(day, anchor);
      return problem ? [{ day, anchor, problem }] : [];
    }),
  );
  const daysOutsideRules = plan ? (days.data ?? []).filter((day) => dayOutsideRules(day, plan)) : [];
  const planned = (stops.data ?? []).filter((stop) => stop.status === 'PLANNED');
  // On a day, whether or not it has been created yet: what the crew is going
  // out to. The office wants the two counts side by side (2026-09-20).
  const scheduled = (stops.data ?? []).filter(
    (stop) => stop.scheduledOn && (stop.status === 'PLANNED' || stop.status === 'PUBLISHED'),
  );
  // No day yet: published to Jobber's own Unscheduled list (2026-09-20), or
  // going there with the next publish.
  const unscheduled = (stops.data ?? []).filter((stop) => !stop.scheduledOn && stop.status !== 'EXCLUDED');
  // A visit the planner could not place is published too, with no day on it: it
  // goes to Jobber's unscheduled work for the office to put on the calendar
  // there (2026-09-20).
  const unplaced = (stops.data ?? []).filter((stop) => stop.status === 'BLOCKED' && !stop.scheduledOn);
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
      description: 'Drive times are measured on the road, so this takes a few minutes. Keep this page open.',
    });
    const { stopsPerDay, groupTemplateId, ...rest } = picked;
    mutations.build.mutate(
      {
        year: choice.year,
        quarter: choice.quarter,
        ...rest,
        // Only when a template is in it, either way: a build that never touched
        // one says nothing, and so means nothing to a server that has none.
        ...(groupTemplateId || plan?.groupTemplateId ? { groupTemplateId } : {}),
        // Both ends, so the planner fills to the number asked for rather than
        // stopping at its own nine and treating the rest as a ceiling. Neither
        // from a template, which sets each day itself: the plan keeps its own.
        ...(stopsPerDay === null ? {} : { minStopsPerDay: stopsPerDay, maxStopsPerDay: Math.max(stopsPerDay, 12) }),
      },
      {
        onSuccess: (result) => {
          toast.success(`${choice.label} is planned`, {
            id,
            description: `${result.routing.placed.toLocaleString()} visits over ${result.routing.days.toLocaleString()} technician-days${
              result.routing.unplaced.length ? `; ${result.routing.unplaced.length} need attention` : ''
            }.${
              result.routing.template
                ? ` ${result.routing.template.days.toLocaleString()} days are groups of “${result.routing.template.name}”${
                    result.routing.template.notInTemplate
                      ? `; ${result.routing.template.notInTemplate.toLocaleString()} visits were in none of its groups and joined the nearest`
                      : ''
                  }${
                    result.routing.template.toMondays
                      ? `; ${result.routing.template.toMondays.toLocaleString()} ${
                          result.routing.template.toMondays === 1 ? 'visit' : 'visits'
                        } a move-out day gave up went to the Monday after`
                      : ''
                  }.`
                : ''
            }`,
          });
        },
        onError: (error) => toast.error(`${choice.label} could not be planned`, { id, description: error.message }),
      },
    );
  };

  /**
   * Re-read the quarter's filter sizes from the tenant report.
   *
   * A quarter freezes its sizes when it is built, so a size the office fills
   * into Propertyware afterwards never reaches the visit by itself. Offered on
   * a published quarter too, which is the case it exists for -- those are the
   * visits a technician is already holding.
   */
  const refreshFilterSizes = () => {
    if (!plan) return;
    mutations.refreshFilterSizes.mutate(plan.id, {
      onSuccess: (result) => {
        if (result.updated)
          toast.success(
            `${result.updated.toLocaleString()} ${result.updated === 1 ? 'visit' : 'visits'} took new filter sizes`,
            {
              description: [
                result.jobberQueued ? `${result.jobberQueued.toLocaleString()} sent on to Jobber.` : null,
                // Said plainly rather than left to be discovered: the visit in
                // front of the technician still reads the old size.
                result.notSentToJobber
                  ? `${result.notSentToJobber.toLocaleString()} changed here only — this server does not send edits to Jobber.`
                  : null,
                result.keptOverridden
                  ? `${result.keptOverridden.toLocaleString()} kept the Details a coordinator wrote.`
                  : null,
              ]
                .filter(Boolean)
                .join(' '),
            },
          );
        else toast.info('Every visit already had the sizes the tenant report holds');
        // What it deliberately did not touch. Each of these is a visit the
        // office may still expect to have changed, so none of them are silent.
        const left = [
          result.keptFinished ? `${result.keptFinished.toLocaleString()} already walked or called off` : null,
          result.keptEditedInConsole ? `${result.keptEditedInConsole.toLocaleString()} edited here by hand` : null,
          result.keptUnresolvedUnit ? `${result.keptUnresolvedUnit.toLocaleString()} at a unit no longer active` : null,
        ].filter(Boolean);
        if (left.length)
          toast.info(`${left.join(', ')} — left as they are`, {
            description: 'A finished visit is the record of what the technician was told, and a hand-written note is somebody’s own words.',
            duration: 12_000,
          });
        if (result.failed)
          toast.error(`${result.failed.toLocaleString()} could not be refreshed`, {
            description: 'The rest were saved. Run it again — the ones that worked are already up to date.',
          });
        // The other half of the answer: a refresh cannot invent a size
        // Propertyware does not hold, and naming those is what lets the office
        // fix them at the source.
        if (result.stillMissing.length)
          toast.warning(
            `${result.stillMissing.length.toLocaleString()} ${result.stillMissing.length === 1 ? 'property has' : 'properties have'} no filter size in Propertyware`,
            {
              description: 'Copy the list and fill the sizes in there; refresh again after the nightly sync.',
              duration: 15_000,
              action: {
                label: 'Copy addresses',
                onClick: () => {
                  void navigator.clipboard
                    .writeText(result.stillMissing.map((tenancy) => tenancy.address).join('\n'))
                    .then(() => toast.success('Addresses copied'))
                    .catch(() => toast.error('The addresses could not be copied'));
                },
              },
            },
          );
      },
      onError: (error) => toast.error('The filter sizes could not be refreshed', { description: error.message }),
    });
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
        else
          toast.success(`${(result.published + result.adopted).toLocaleString()} inspections created for ${choice.label}`, {
            description: result.unscheduled
              ? `${result.unscheduled.toLocaleString()} visits with no day went to Jobber unscheduled.`
              : undefined,
          });
      },
      onError: (error) => toast.error(`${choice.label} could not be published`, { description: error.message }),
    });
  };

  /** What is behind the ⓘ: this quarter's facts, in a line each. */
  const facts = plan
    ? [
        { label: 'First day', value: planStartText(quarter, startsOn) },
        { label: 'US holidays', value: holidays.length ? holidays.map(formatShortDay).join(', ') : 'none' },
        ...(alsoClosed.length ? [{ label: 'Also closed', value: alsoClosed.map(formatShortDay).join(', ') }] : []),
        ...(rotation.data
          ? [
              {
                label: 'Crew',
                value: plan.jobberUnassigned
                  ? `sent out unassigned, to hand out in Jobber · ${rotation.data.crew.length} day ${
                      rotation.data.crew.length === 1 ? 'group' : 'groups'
                    } at a time`
                  : rotation.data.crew.length
                    ? rotation.data.crew.map((member) => member.displayName ?? 'Someone').join(', ')
                    : 'nobody yet: choose who goes out when you rebuild',
              },
            ]
          : []),
        ...(trips.length ? [{ label: trips.length === 1 ? 'Trip' : 'Trips', value: trips.join(' · ') }] : []),
        {
          label: 'Details',
          value: plan.officeDetailsImportedAt ? `office sheet, ${formatRelative(plan.officeDetailsImportedAt)}` : 'from the tenant report',
        },
        { label: 'Built', value: formatRelative(plan.generatedAt) },
      ]
    : [];

  const showVisits = (filter: VisitFilter) => setState({ tab: 'visits', show: filter });
  /** The quarter today is in, in Texas: where Today goes from a quarter whose calendar does not reach it. */
  const today = businessToday();
  const todayQuarter = quarterKey(Number(today.slice(0, 4)), Math.floor((Number(today.slice(5, 7)) - 1) / 3) + 1);

  /** The quarter in a line, with what needs a look said in its colour (the office, 2026-10-05: no paragraphs). */
  const summary = plan
    ? (() => {
        const parts = [
          <span key="visits">
            {(plan.hvacStopCount + plan.occupiedStopCount).toLocaleString()} visits
            {plan.hvacStopCount ? ` (${plan.hvacStopCount.toLocaleString()} HVAC)` : ''}
          </span>,
          ...(days.data?.length
            ? [
                <span key="days">
                  {days.data.length.toLocaleString()} technician-days, {technicians.size}{' '}
                  {technicians.size === 1 ? 'technician' : 'technicians'}
                </span>,
              ]
            : []),
          ...(attentionIds.size
            ? [
                <button
                  className="text-warning font-medium underline-offset-4 hover:underline"
                  key="attention"
                  onClick={() => showVisits('attention')}
                  type="button"
                >
                  {attentionIds.size.toLocaleString()} {attentionIds.size === 1 ? 'needs' : 'need'} attention
                </button>,
              ]
            : []),
          ...(daysOutsideRules.length
            ? [
                <span
                  className="text-destructive font-medium"
                  key="outside"
                  title={`Over ${plan.maxStopsPerDay} visits, the inspecting limit, or ${plan.maxLegMinutes} min between properties`}
                >
                  {daysOutsideRules.length.toLocaleString()} {daysOutsideRules.length === 1 ? 'day' : 'days'} outside the rules
                </span>,
              ]
            : []),
        ];
        return (
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {parts.flatMap((part, index) => (index ? [<span aria-hidden key={`dot-${index}`}>·</span>, part] : [part]))}
            <PlanRules
              facts={facts}
              maxLegMinutes={plan.maxLegMinutes}
              maxStopsPerDay={plan.maxStopsPerDay}
              minStopsPerDay={plan.minStopsPerDay}
            />
          </span>
        );
      })()
    : 'Each quarter’s Tenant Benefit Package visits, planned into days and published to Jobber.';

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
          {canPlace && plan ? (
            <Button
              disabled={building}
              onClick={() => setChoosing(true)}
              size="sm"
              title="Reads the tenant report again and lays the days out again. Changes made to visits are kept."
              variant="outline"
            >
              {building ? <Spinner /> : <RefreshCwIcon />}
              Rebuild
            </Button>
          ) : null}
          {plan ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline">
                  {officeSheet.pending || mutations.refreshFilterSizes.isPending ? <Spinner /> : <EllipsisIcon />}
                  More
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {canPlace ? (
                  <>
                    <DropdownMenuItem disabled={officeSheet.pending} onSelect={officeSheet.choose}>
                      <FileSpreadsheetIcon />
                      Import office sheet
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={building || mutations.refreshFilterSizes.isPending} onSelect={refreshFilterSizes}>
                      <WindIcon />
                      Refresh filter sizes
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                  </>
                ) : null}
                <DropdownMenuItem
                  onSelect={() => {
                    groupFiles.showServerFile();
                    setState({ tab: 'schedule', show: 'all' });
                  }}
                >
                  <MapIcon />
                  Show the server’s groups file
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={groupFilePicker.choose}>
                  <MapIcon />
                  Map a groups file
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          {canPlace && plan ? (
            <Button
              disabled={building || planned.length + unplaced.length === 0}
              onClick={() => setPublishing(true)}
              size="sm"
              title={
                unplaced.length
                  ? `${unplaced.length.toLocaleString()} visits with no day go to Jobber unscheduled.`
                  : undefined
              }
            >
              <SendIcon />
              {draft ? 'Publish' : 'Publish the rest'}
            </Button>
          ) : null}
        </>
      }
      badges={plan ? <Badge variant={STATUS[plan.status].variant}>{STATUS[plan.status].label}</Badge> : null}
      description={summary}
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

  const visitFilters: { value: VisitFilter; label: string; count: number }[] = [
    { value: 'all', label: 'All', count: stops.data?.length ?? 0 },
    { value: 'scheduled', label: 'Scheduled', count: scheduled.length },
    { value: 'unscheduled', label: 'Unscheduled', count: unscheduled.length },
    { value: 'attention', label: 'Needs attention', count: attentionIds.size },
  ];
  const listed =
    show === 'scheduled'
      ? scheduled
      : show === 'unscheduled'
        ? unscheduled
        : show === 'attention'
          ? (stops.data ?? []).filter((stop) => attentionIds.has(stop.id))
          : (stops.data ?? []);

  return (
    <>
      {header}
      {officeSheet.element}
      {groupFilePicker.element}

      {!plan ? (
        choice.started ? (
          // A quarter already under way with no plan was run somewhere else:
          // its visits are inspections, and a plan built now would lay today's
          // tenancies over days that have passed (2026-09-21).
          <EmptyState
            description={`${choice.label} is already under way and was never planned here. Its visits are in Inspections.`}
            icon={CalendarRangeIcon}
            title={`${choice.label} was run outside this plan`}
          >
            <Button asChild variant="outline">
              <Link href="/inspections">See the inspections</Link>
            </Button>
          </EmptyState>
        ) : (
          <EmptyState
            description={`Built from the tenant report, in ${quarterName(
              choice.quarter === 1 ? choice.year - 1 : choice.year,
              choice.quarter === 1 ? 4 : choice.quarter - 1,
            )}'s order${choice.quarter % 2 === 0 ? ', with HVAC inspections for tenancies on the HVAC plan' : ''}. Nothing is booked until it is published.`}
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
        )
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

          {lateMoveOuts.data ? (
            <LateMoveOutsPanel
              canMove={canMoveVisits}
              data={lateMoveOuts.data}
              onMove={moveToMonday}
              pending={mutations.moveToMonday.isPending}
            />
          ) : null}

          <Tabs onValueChange={(next) => setState({ tab: next, show: 'all' })} value={tab}>
            <TabsList>
              <TabsTrigger value="schedule">Schedule</TabsTrigger>
              <TabsTrigger value="visits">Visits ({(stops.data?.length ?? 0).toLocaleString()})</TabsTrigger>
            </TabsList>

            {/*
              The calendar beside the map, as Jobber's schedule (the office,
              2026-10-05): a technician-day picked on the calendar is the one
              day the map draws.
            */}
            <TabsContent className="mt-3" value="schedule">
              {groupFiles.serverNote ? (
                <div className="text-muted-foreground mb-3 flex flex-wrap items-center gap-2 text-sm">
                  {groupFiles.serverNote}
                  <Button onClick={groupFiles.close} size="sm" variant="ghost">
                    Dismiss
                  </Button>
                </div>
              ) : null}
              {groupFiles.shown ? (
                <GroupFileView
                  key={`${groupFiles.shown.source}:${groupFiles.shown.name}:${groupFiles.shown.loadedAt}`}
                  loaded={groupFiles.shown}
                  onClose={groupFiles.close}
                  onLoad={mapGroupFile}
                />
              ) : days.isLoading ? (
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
                <PlanSchedule
                  canChange={canChange}
                  canMoveVisits={canMoveVisits}
                  days={days.data}
                  jobberEditsPushed={lateMoveOuts.data?.jobberEditsPushed ?? null}
                  key={plan.id}
                  onOpenStop={setOpenStopId}
                  onSelect={(day) => setState({ day })}
                  onShowUnscheduled={() => showVisits('unscheduled')}
                  // A new quarter opens on its first day from today on: today, when today is worked.
                  onToday={todayQuarter === choice.key ? undefined : () => setState({ quarter: todayQuarter, day: '' })}
                  onViewChange={(next) => setState({ view: next })}
                  planId={plan.id}
                  quarter={quarter}
                  rotation={rotation.data ?? null}
                  selectedDayId={state.day}
                  settings={plan}
                  startsOn={startsOn}
                  unscheduledCount={unscheduled.length}
                  view={view}
                  visits={dayStops}
                />
              )}
            </TabsContent>

            <TabsContent className="mt-3" value="visits">
              {stops.isLoading ? (
                <PageSkeleton cards={1} />
              ) : stops.isError ? (
                <ErrorState error={stops.error} retry={() => void stops.refetch()} />
              ) : (
                <div className="grid gap-3">
                  <div aria-label="Show" className="flex flex-wrap gap-1.5" role="group">
                    {visitFilters.map((filter) => (
                      <button
                        aria-pressed={show === filter.value}
                        className={cn(
                          'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-sm transition-colors',
                          show === filter.value ? 'bg-accent text-foreground border-ring/40 font-medium' : 'text-muted-foreground hover:text-foreground',
                        )}
                        key={filter.value}
                        onClick={() => showVisits(filter.value)}
                        type="button"
                      >
                        {filter.label}{' '}
                        <span className="font-mono text-xs tabular-nums">{filter.count.toLocaleString()}</span>
                      </button>
                    ))}
                  </div>

                  {(show === 'unscheduled' || show === 'attention') && listed.length ? (
                    <>
                      <div className="h-80 lg:h-[30rem]">
                        <PlanAttentionMap
                          onSelectStop={setOpenStopId}
                          planned={plannedMap}
                          stops={
                            show === 'attention'
                              ? needingMap
                              : unscheduled.map((stop) => ({ ...onMap(stop), attention: attentionOf(stop) ?? ('NO_DAY' as const) }))
                          }
                        />
                      </div>
                      <p className="text-muted-foreground text-xs">
                        {show === 'unscheduled'
                          ? 'Visits with no day. Give one a day and a technician here; a published one is also in Jobber’s Unscheduled list.'
                          : 'Visits waiting for something, with the planned ones behind them in grey. Click one to fix it.'}
                        {show === 'attention' && withoutLocation
                          ? ` ${withoutLocation.toLocaleString()} ${withoutLocation === 1 ? 'is' : 'are'} not on the map: Propertyware has no location for the property.`
                          : ''}
                      </p>
                    </>
                  ) : null}

                  {listed.length ? (
                    <PlanStopsTable
                      allStops={stops.data ?? []}
                      editable={canPlace}
                      onOpen={setOpenStopId}
                      stops={listed}
                    />
                  ) : (
                    <EmptyState
                      description={
                        show === 'attention'
                          ? 'Every visit has a day and a technician, and every kind of visit is settled.'
                          : show === 'unscheduled'
                            ? 'Every visit this quarter has a day.'
                            : 'No visit has a day yet. Rebuild the quarter to lay them out.'
                      }
                      title={show === 'attention' ? 'Nothing needs attention' : show === 'unscheduled' ? 'Nothing unscheduled' : 'No visits'}
                    />
                  )}
                </div>
              )}
            </TabsContent>
          </Tabs>
        </div>
      )}

      <PlanStopDialog
        closedDays={closedDaysOfQuarter(quarter, plan?.holidays ?? [], startsOn)}
        day={openStopDay}
        dayGroups={
          plan?.jobberUnassigned
            ? (rotation.data?.crew ?? []).map((member) => ({
                id: member.technicianId,
                name: member.displayName ?? 'Day group',
              }))
            : null
        }
        editable={canPlace}
        // A booked visit is changed here too, and its changes reach Jobber (the office, 2026-10-06).
        booked={{
          manage: has('inspections:manage'),
          assign: has('inspections:assign'),
          jobberEditsPushed: lateMoveOuts.data?.jobberEditsPushed ?? null,
        }}
        onOpenChange={(open) => !open && setOpenStopId(null)}
        quarter={quarter}
        startsOn={startsOn}
        stop={openStop}
      />

      <PlanBuildDialog
        chosen={plan?.crewTechnicianIds ?? []}
        // The plan's own answer, so a rebuild opens on the last one given rather
        // than quietly reverting to assigning everybody.
        jobberUnassigned={plan?.jobberUnassigned ?? false}
        // The grouping the quarter was last built with, so a rebuild keeps it unless changed.
        groupTemplate={plan?.groupTemplate ?? null}
        groupTemplateRevision={plan?.groupTemplateRevision ?? null}
        // The plan's own visits a day, so a rebuild reopens on it rather than on nine.
        stopsPerDay={plan?.minStopsPerDay ?? null}
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
              office&rsquo;s Details.
              {unplaced.length
                ? ` The ${unplaced.length.toLocaleString()} visits with no day go to Jobber with no day on them, for you to schedule there; each comes back here as an inspection once it has one.`
                : ''}{' '}
              There is no bulk undo.
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
              {unplaced.length ? ` and ${unplaced.length.toLocaleString()} unscheduled` : ''}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
