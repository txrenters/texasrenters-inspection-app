'use client';

import type { AdminDashboard, AdminDashboardOutlook, JobberDayComparison } from '@texasrenters/shared';
import { ArrowRightIcon, PlusIcon } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { Kpi, Meter } from '@/components/dashboard/dash-card';
import { QuarterPlans } from '@/components/dashboard/quarter-plans';
import { ScheduleAhead } from '@/components/dashboard/schedule-ahead';
import { TechnicianLoad } from '@/components/dashboard/technician-load';

import { useConsoleShell } from '@/components/console-shell-context';
import { JobberHome } from '@/components/home/jobber-home';
import { JobberDayPanel } from '@/components/jobber-day-panel';
import { useNewJob } from '@/components/jobs/new-job-context';
import { Panel, PanelRow } from '@/components/panel';
import { StatStrip, StatStripItem } from '@/components/stat-card';
import { ErrorState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { businessToday } from '@/lib/clock';
import { aheadOfPlanLabel, percentDone, quarterPace, weekComparisonLabel } from '@/lib/dashboard-outlook';
import { formatCount, formatDateTime, formatDay, formatRelative, humanize } from '@/lib/format';
import { texasDayLabel } from '@/lib/home-workflow';
import { usePermissions } from '@/lib/auth';
import { useDashboard, useDashboardOutlook, useJobberDay } from '@/lib/queries';
import { cn } from '@/lib/utils';

/** Providers in these states need somebody; READY and CONFIGURED do not. */
const PROVIDER_NEEDS_A_PERSON = new Set(['NOT_CONFIGURED', 'DEGRADED', 'UNAVAILABLE', 'ERROR']);

/**
 * The page's own header, not `PageHeader`: this is the page the console opens
 * on, and its title is set a size above a list page's so the day reads first.
 * One filled button, the thing most often started from here.
 */
function Header() {
  const openNewJob = useNewJob();
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl leading-tight font-semibold tracking-tight">Operations</h1>
        <p className="text-muted-foreground mt-1 text-[13px]">{texasDayLabel(businessToday())} · Texas time</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button asChild variant="outline">
          <Link href="/inspections">Today&apos;s inspections</Link>
        </Button>
        <Button onClick={() => openNewJob()} type="button">
          <PlusIcon aria-hidden />
          New job
        </Button>
      </div>
    </div>
  );
}

/**
 * Two layouts of one dashboard. The Jobber-style shell (lib/console-shell.ts)
 * opens on Jobber's Home -- a greeting and the Workflow cards -- and the
 * classic console on its title and four figures. Everything under that is the
 * same two components in both, so neither layout can lose a chart or a panel.
 */
export default function DashboardPage() {
  const shell = useConsoleShell();
  const dashboard = useDashboard();
  const outlook = useDashboardOutlook();
  const { has } = usePermissions();
  const canReadInspections = has('inspections:read');
  const jobberDay = useJobberDay(businessToday(), canReadInspections);

  if (shell === 'jobber')
    return (
      <JobberHome
        canReadInspections={canReadInspections}
        dashboard={dashboard}
        jobberDay={jobberDay}
        lead={
          dashboard.data ? <LookAhead data={dashboard.data} jobberDay={jobberDay.data} outlook={outlook} /> : null
        }
      >
        {dashboard.data ? (
          <div className="flex flex-col gap-5">
            <PlansAndPeople
              canReadInspections={canReadInspections}
              data={dashboard.data}
              jobberDay={jobberDay.data}
              jobberDayLoading={jobberDay.isLoading}
              outlook={outlook}
            />
          </div>
        ) : null}
      </JobberHome>
    );

  if (dashboard.isError)
    return (
      <div className="flex flex-col gap-5">
        <Header />
        <ErrorState error={dashboard.error} retry={() => void dashboard.refetch()} />
      </div>
    );

  if (dashboard.isLoading || !dashboard.data)
    return (
      <div className="flex flex-col gap-5">
        <Header />
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton className="h-32 rounded-xl" key={index} />
          ))}
        </div>
        <Skeleton className="h-80 rounded-xl" />
      </div>
    );

  const data = dashboard.data;

  return (
    <div className="flex flex-col gap-5">
      <Header />

      <Figures data={data} outlook={outlook.data} />

      <LookAhead data={data} jobberDay={jobberDay.data} outlook={outlook} />

      <PlansAndPeople
        canReadInspections={canReadInspections}
        data={data}
        jobberDay={jobberDay.data}
        jobberDayLoading={jobberDay.isLoading}
        outlook={outlook}
      />
    </div>
  );
}

/**
 * The schedule leads: it is the one thing here that looks forward. What needs
 * somebody sits beside it, so neither is below the fold.
 */
function LookAhead({
  data,
  jobberDay,
  outlook,
}: {
  data: AdminDashboard;
  jobberDay: JobberDayComparison | undefined;
  outlook: ReturnType<typeof useDashboardOutlook>;
}) {
  return (
    <div className="grid items-start gap-5 xl:grid-cols-3">
      <div className="min-w-0 xl:col-span-2">
        <Outlook outlook={outlook}>{(loaded) => <ScheduleAhead outlook={loaded} />}</Outlook>
      </div>
      <NeedsAPerson
        attention={attentionOf(data, jobberDay)}
        data={data}
        heading
        jobberDate={jobberDay?.date}
        systems
      />
    </div>
  );
}

/** Each quarter's plan, today against Jobber beside who holds the week, and the portfolio. */
function PlansAndPeople({
  canReadInspections,
  data,
  jobberDay,
  jobberDayLoading,
  outlook,
}: {
  canReadInspections: boolean;
  data: AdminDashboard;
  jobberDay: JobberDayComparison | undefined;
  jobberDayLoading: boolean;
  outlook: ReturnType<typeof useDashboardOutlook>;
}) {
  return (
    <>
      <Outlook outlook={outlook} quiet>
        {(loaded) => <QuarterPlans outlook={loaded} />}
      </Outlook>

      <div className="grid items-start gap-5 xl:grid-cols-3">
        {canReadInspections ? (
          <JobberDayPanel className="min-w-0 xl:col-span-2" day={jobberDay} heading loading={jobberDayLoading} />
        ) : null}
        <div className={cn('min-w-0', !canReadInspections && 'xl:col-span-3')}>
          <Outlook outlook={outlook} quiet>
            {(loaded) => <TechnicianLoad outlook={loaded} />}
          </Outlook>
        </div>
      </div>

      <Portfolio data={data} />
    </>
  );
}

/**
 * A card that draws from the outlook: a placeholder while it loads, and its
 * own error with a retry, so a failed chart never takes the figures and the
 * queue above it down with it. `quiet` cards say nothing on failure: one
 * message for the one request is enough.
 */
function Outlook({
  outlook,
  quiet,
  children,
}: {
  outlook: ReturnType<typeof useDashboardOutlook>;
  quiet?: boolean;
  children: (outlook: AdminDashboardOutlook) => ReactNode;
}) {
  if (outlook.data) return <>{children(outlook.data)}</>;
  if (outlook.isError)
    return quiet ? null : <ErrorState error={outlook.error} retry={() => void outlook.refetch()} />;
  return <Skeleton className="h-72 rounded-xl" />;
}

/** The four figures the page opens on: today, the queue, the week ahead and the quarter. */
function Figures({ data, outlook }: { data: AdminDashboard; outlook: AdminDashboardOutlook | undefined }) {
  const quarter = outlook?.quarters.find((item) => item.phase === 'CURRENT');
  const pace = quarter && outlook ? quarterPace(quarter, outlook.today) : null;
  const today = outlook?.todayCounts;
  const toGo = today ? Math.max(0, today.total - today.done - today.inProgress) : 0;
  const pending = <Skeleton className="h-4 w-40" />;
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <Kpi
        label="Today"
        unit={today ? (today.total === 1 ? 'visit' : 'visits') : undefined}
        value={today ? formatCount(today.total) : '—'}
      >
        {today ? (
          <>
            <Meter
              className="mt-1"
              label={`${today.done} done, ${today.inProgress} in the field, ${toGo} to go`}
              parts={[
                { value: today.done, className: 'bg-plan-done' },
                { value: today.inProgress, className: 'bg-series-1' },
                { value: toGo, className: 'bg-transparent' },
              ]}
            />
            <p className="text-muted-foreground text-xs">
              {formatCount(today.done)} done · {formatCount(today.inProgress)} in the field · {formatCount(toGo)} to go
            </p>
          </>
        ) : (
          pending
        )}
      </Kpi>

      <Kpi
        label="Unassigned"
        tone={data.metrics.unassigned ? 'warning' : undefined}
        value={formatCount(data.metrics.unassigned)}
      >
        <p className="text-muted-foreground text-xs">
          {!data.metrics.unassigned
            ? 'Every upcoming visit has a technician'
            : outlook?.earliestUnassignedOn
              ? `Earliest is ${formatDay(outlook.earliestUnassignedOn, 'long')}`
              : 'Reach nobody until assigned'}
        </p>
        {data.metrics.unassigned ? (
          <div className="mt-1.5">
            <Button asChild size="sm" variant="outline">
              {/* Every date: the count is every upcoming visit with nobody on
                  it, not today's. */}
              <Link href="/inspections?tech=unassigned&day=all">Assign technicians</Link>
            </Button>
          </div>
        ) : null}
      </Kpi>

      <Kpi
        label="Next 7 days"
        unit={outlook ? 'visits booked' : undefined}
        value={outlook ? formatCount(outlook.next7) : '—'}
      >
        {outlook ? (
          <p className="text-muted-foreground text-xs">{weekComparisonLabel(outlook.next7, outlook.previous7)}</p>
        ) : (
          pending
        )}
      </Kpi>

      {quarter && pace ? (
        <Kpi
          label={`TBP · ${quarter.label}`}
          unit={`${formatCount(quarter.done)} of ${formatCount(quarter.total)} done`}
          value={`${percentDone(quarter)}%`}
        >
          <Meter
            className="mt-1"
            label={`${formatCount(quarter.done)} of ${formatCount(quarter.total)} done`}
            parts={[
              { value: quarter.done, className: 'bg-plan-done' },
              { value: quarter.total - quarter.done, className: 'bg-transparent' },
            ]}
          />
          <p className="text-muted-foreground text-xs">
            {aheadOfPlanLabel(pace.aheadOfPlan)} · {pace.daysLeft} {pace.daysLeft === 1 ? 'day' : 'days'} left
          </p>
        </Kpi>
      ) : (
        <Kpi label="TBP · this quarter" value="—">
          {outlook ? (
            <p className="text-muted-foreground text-xs">
              No plan for this quarter.{' '}
              <Link className="text-foreground font-medium hover:underline" href="/planning">
                Open planning
              </Link>
            </p>
          ) : (
            pending
          )}
        </Kpi>
      )}
    </div>
  );
}

type Attention = ReturnType<typeof attentionOf>;

/** What needs somebody, worked out once for both layouts. */
function attentionOf(data: AdminDashboard, jobberDay: JobberDayComparison | undefined) {
  // Grouped by code, entity and message: the same failure repeated forty times
  // is one problem, and listing it forty times buries the other three.
  const groupedErrors = Array.from(
    data.recentErrors
      .reduce((groups, error) => {
        const key = `${error.errorCode}:${error.entityType}:${error.sanitizedMessage}`;
        const current = groups.get(key);
        groups.set(key, current ? { ...current, count: current.count + 1 } : { ...error, count: 1 });
        return groups;
      }, new Map<string, (typeof data.recentErrors)[number] & { count: number }>())
      .values(),
  );
  const providersNeedingAPerson = data.providerReadiness.filter((provider) =>
    PROVIDER_NEEDS_A_PERSON.has(provider.status),
  );
  const jobberDifferences = jobberDay?.rows.filter((row) => row.state !== 'MATCHES').length ?? 0;
  return {
    groupedErrors,
    providersNeedingAPerson,
    jobberDifferences,
    count:
      (data.metrics.unassigned ? 1 : 0) +
      (jobberDifferences ? 1 : 0) +
      groupedErrors.length +
      providersNeedingAPerson.length,
  };
}

/**
 * What needs somebody, in one list, in the order it should be done.
 *
 * `systems` closes the list with one line for the integrations, in place of a
 * panel of five rows that all say Ready: the ones that need somebody are
 * already rows above it.
 */
function NeedsAPerson({
  attention,
  data,
  jobberDate,
  className,
  heading,
  systems,
}: {
  attention: Attention;
  data: AdminDashboard;
  jobberDate: string | undefined;
  className?: string;
  heading?: boolean;
  systems?: boolean;
}) {
  return (
    <Panel
      className={className}
      count={attention.count || undefined}
      countTone="warning"
      heading={heading}
      title="Needs a person"
    >
      {attention.count || systems ? (
        <div className="divide-y">
          {data.metrics.unassigned ? (
            <PanelRow
              title={
                <Link className="hover:underline" href="/inspections?tech=unassigned&day=all">
                  {data.metrics.unassigned === 1
                    ? '1 inspection has no technician'
                    : `${formatCount(data.metrics.unassigned)} inspections have no technician`}
                </Link>
              }
              detail="Upcoming, any date"
              tone="warning"
            />
          ) : null}
          {attention.jobberDifferences ? (
            <PanelRow
              detail="Today, as of the last Jobber sync"
              title={
                <Link className="hover:underline" href={jobberDate ? `/schedule?date=${jobberDate}` : '/schedule'}>
                  {attention.jobberDifferences === 1
                    ? '1 visit differs from Jobber'
                    : `${attention.jobberDifferences} visits differ from Jobber`}
                </Link>
              }
              tone="warning"
            />
          ) : null}
          {attention.groupedErrors.map((error) => (
            <PanelRow
              detail={
                <>
                  {error.sanitizedMessage}
                  <span className="block">
                    {error.entityType} · {formatDateTime(error.createdAt)}
                  </span>
                </>
              }
              key={`${error.errorCode}:${error.entityType}:${error.id}`}
              title={humanize(error.errorCode)}
              tone="destructive"
              trailing={
                error.count > 1 ? (
                  <span className="text-muted-foreground font-mono text-xs tabular-nums">
                    ×{error.count}
                  </span>
                ) : null
              }
            />
          ))}
          {attention.providersNeedingAPerson.map((provider) => (
            <PanelRow
              detail={provider.detail ?? 'Operational configuration check'}
              key={provider.provider}
              title={
                <Link className="hover:underline" href="/integrations/providers">
                  {provider.provider}: {humanize(provider.status).toLowerCase()}
                </Link>
              }
              tone="warning"
            />
          ))}
          {systems ? <SystemsRow data={data} needing={attention.providersNeedingAPerson.length} /> : null}
        </div>
      ) : (
        <p className="text-muted-foreground px-4 py-6 text-sm">
          Nothing needs a person right now.
        </p>
      )}
    </Panel>
  );
}

function SystemsRow({ data, needing }: { data: AdminDashboard; needing: number }) {
  const all = data.providerReadiness.length;
  return (
    <PanelRow
      detail={
        data.lastSync
          ? `Propertyware synced ${formatRelative(data.lastSync.completedAt)}`
          : 'No Propertyware sync recorded'
      }
      title={
        <Link className="hover:underline" href="/integrations/providers">
          {needing ? `${all - needing} of ${all} systems ready` : `All ${all} systems ready`}
        </Link>
      }
      tone={needing ? 'muted' : 'success'}
    />
  );
}

/** Synchronized overnight and nobody acts on them from here: a strip, not a panel of boxes. */
function Portfolio({ data, className }: { data: AdminDashboard; className?: string }) {
  return (
    <StatStrip
      action={
        <Button asChild className="h-7 px-2 text-xs" size="sm" variant="ghost">
          <Link href="/properties">
            Browse properties
            <ArrowRightIcon />
          </Link>
        </Button>
      }
      className={className}
      title="Portfolio · Propertyware"
    >
      <StatStripItem label="Portfolios" value={formatCount(data.metrics.portfolios)} />
      <StatStripItem label="Properties" value={formatCount(data.metrics.properties)} />
      <StatStripItem label="Units" value={formatCount(data.metrics.units)} />
      <StatStripItem label="Leases" value={formatCount(data.metrics.leases)} />
      <StatStripItem label="Technicians" value={formatCount(data.metrics.technicians)} />
    </StatStrip>
  );
}
