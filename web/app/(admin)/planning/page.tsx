'use client';

import { CalendarRangeIcon, RefreshCwIcon, RouteIcon, SendIcon, Settings2Icon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import { OfficeSheetImport } from '@/components/planning/office-sheet-import';
import { PlanDays } from '@/components/planning/plan-days';
import { DEFAULT_PLAN_SETTINGS, PlanSettingsDialog } from '@/components/planning/plan-settings-dialog';
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
import { formatRelative, formatScheduledDate } from '@/lib/format';
import { formatMinutes, quarterChoices, quarterKey, quarterName } from '@/lib/planning';
import {
  usePlanDays,
  usePlanQuarters,
  usePlanStops,
  usePlanningMutations,
  type PlanDay,
  type PlanQuarter,
  type PlanSettings,
  type PlanStatus,
} from '@/lib/planning-queries';
import { useUrlState } from '@/lib/url-state';

/**
 * A quarter of Tenant Benefit Package visits, before and after it is booked.
 *
 * The office's rules, as the planner applies them: whoever was first last
 * quarter is first again; Q2 and Q4 visits are HVAC inspections for tenancies
 * on the HVAC plan; and a technician-day is at most six hours on site and
 * ninety minutes driving between its properties. This page is where a
 * coordinator checks the days against those rules, fixes what the tenant report
 * could not settle, and publishes -- which creates the inspections and queues
 * their visits for Jobber.
 */

const STATUS: Record<PlanStatus, { label: string; variant: 'secondary' | 'info' | 'success' | 'destructive' | 'outline' }> = {
  DRAFT: { label: 'Draft', variant: 'secondary' },
  PUBLISHING: { label: 'Publishing', variant: 'info' },
  PUBLISHED: { label: 'Published', variant: 'success' },
  PUBLISH_FAILED: { label: 'Publish failed', variant: 'destructive' },
  CANCELLED: { label: 'Cancelled', variant: 'outline' },
};

const settingsOf = (plan: PlanQuarter | null): PlanSettings =>
  plan
    ? {
        occupiedVisitMinutes: plan.occupiedVisitMinutes,
        hvacVisitMinutes: plan.hvacVisitMinutes,
        maxOnSiteMinutes: plan.maxOnSiteMinutes,
        maxDriveMinutes: plan.maxDriveMinutes,
        holidays: plan.holidays,
      }
    : DEFAULT_PLAN_SETTINGS;

const overLimit = (day: PlanDay, settings: PlanSettings) =>
  day.onSiteMinutes > settings.maxOnSiteMinutes ||
  (day.totalDriveSeconds !== null && day.totalDriveSeconds > settings.maxDriveMinutes * 60);

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
  const mutations = usePlanningMutations();
  const settings = useMemo(() => settingsOf(plan), [plan]);
  const [settingsFor, setSettingsFor] = useState<'build' | 'route' | null>(null);
  const [publishing, setPublishing] = useState(false);

  const draft = plan?.status === 'DRAFT';
  const attention = (stops.data ?? []).filter((stop) => stop.status === 'BLOCKED' || stop.status === 'FAILED');
  const review = (stops.data ?? []).filter(
    (stop) => stop.inspectionTypeNeedsReview && stop.status !== 'EXCLUDED' && stop.status !== 'PUBLISHED',
  );
  const attentionIds = new Set([...attention, ...review].map((stop) => stop.id));
  const overLimitDays = (days.data ?? []).filter((day) => overLimit(day, settings));
  const planned = (stops.data ?? []).filter((stop) => stop.status === 'PLANNED');
  const technicians = new Set((days.data ?? []).map((day) => day.technicianId));

  const build = (values: PlanSettings) => {
    mutations.build.mutate(
      { year: choice.year, quarter: choice.quarter, ...values },
      {
        onSuccess: (result) => {
          setSettingsFor(null);
          toast.success(`${choice.label} is planned`, {
            description: `${result.routing.placed.toLocaleString()} visits over ${result.routing.days.toLocaleString()} technician-days${
              result.routing.unplaced.length ? `; ${result.routing.unplaced.length} need attention` : ''
            }.`,
          });
        },
        onError: (error) => toast.error(`${choice.label} could not be planned`, { description: error.message }),
      },
    );
  };

  const route = (values: PlanSettings) => {
    if (!plan) return;
    mutations.route.mutate(
      { planId: plan.id, ...values },
      {
        onSuccess: (result) => {
          setSettingsFor(null);
          toast.success('The days are laid out again', {
            description: `${result.placed.toLocaleString()} visits over ${result.days.toLocaleString()} technician-days${
              result.repaired ? `; ${result.repaired} moved off days that measured over the drive limit` : ''
            }.`,
          });
        },
        onError: (error) => toast.error('The days could not be laid out', { description: error.message }),
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
              <Button onClick={() => setSettingsFor('build')} size="sm" variant="outline">
                <RefreshCwIcon />
                Rebuild
              </Button>
              <Button onClick={() => setSettingsFor('route')} size="sm" variant="outline">
                <Settings2Icon />
                Lay out days
              </Button>
              <Button
                disabled={attention.length > 0 || planned.length === 0}
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
      description="Each quarter's Tenant Benefit Package visits, in last quarter's order, laid out over technician-days of at most six hours on site and ninety minutes driving between properties."
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
            <Button onClick={() => setSettingsFor('build')}>
              <RouteIcon />
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
              detail={`Limits: ${formatMinutes(settings.maxOnSiteMinutes)} on site, ${settings.maxDriveMinutes} min driving`}
              label="Days over the limits"
              tone={overLimitDays.length ? 'destructive' : 'success'}
              value={overLimitDays.length.toLocaleString()}
            />
          </StatGroup>

          <StatStrip>
            <StatStripItem label="Occupied visit" value={`${settings.occupiedVisitMinutes} min`} />
            <StatStripItem label="HVAC visit" value={`${settings.hvacVisitMinutes} min`} />
            <StatStripItem
              label="Closed"
              value={settings.holidays.length ? settings.holidays.map((day) => formatScheduledDate(day)).join(', ') : 'weekends only'}
            />
            <StatStripItem
              label="Details"
              value={plan.officeDetailsImportedAt ? `office sheet, ${formatRelative(plan.officeDetailsImportedAt)}` : 'from the tenant report'}
            />
            <StatStripItem label="Built" value={formatRelative(plan.generatedAt)} />
          </StatStrip>

          <Tabs onValueChange={(tab) => setState({ tab })} value={state.tab}>
            <TabsList>
              <TabsTrigger value="days">Days ({(days.data?.length ?? 0).toLocaleString()})</TabsTrigger>
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
                  description="No visit has a day yet. Lay the days out to place them."
                  icon={CalendarRangeIcon}
                  title="No technician-days"
                />
              ) : (
                <PlanDays
                  days={days.data}
                  onSelect={(day) => setState({ day })}
                  planId={plan.id}
                  selectedDayId={state.day}
                  settings={settings}
                />
              )}
            </TabsContent>

            <TabsContent className="mt-3" value="visits">
              {stops.isLoading ? (
                <PageSkeleton cards={1} />
              ) : stops.isError ? (
                <ErrorState error={stops.error} retry={() => void stops.refetch()} />
              ) : (
                <PlanStopsTable editable={canChange && draft} stops={stops.data ?? []} />
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
                  editable={canChange && draft}
                  stops={(stops.data ?? []).filter((stop) => attentionIds.has(stop.id))}
                />
              )}
            </TabsContent>
          </Tabs>
        </div>
      )}

      <PlanSettingsDialog
        description={
          settingsFor === 'build'
            ? plan
              ? 'Reads the tenant report again — who is enrolled, their plans and filter sizes — keeps every kind of visit a coordinator chose, and lays the days out again.'
              : `Builds ${choice.label} from the tenant report and lays its days out. Nothing is booked until it is published.`
            : 'Lays every visit out again with these numbers. Days a coordinator chose are kept.'
        }
        initial={settings}
        onOpenChange={(open) => !open && setSettingsFor(null)}
        onSubmit={settingsFor === 'build' ? build : route}
        open={settingsFor !== null}
        pending={mutations.build.isPending || mutations.route.isPending}
        submitLabel={settingsFor === 'build' ? (plan ? 'Rebuild' : `Build ${choice.label}`) : 'Lay out days'}
        title={
          settingsFor === 'build'
            ? plan
              ? `Rebuild ${choice.label} from the tenant report`
              : `Build the ${choice.label} plan`
            : `Lay out ${choice.label}`
        }
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
