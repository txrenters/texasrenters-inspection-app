'use client';

import type { AdminInspection, JobberDayComparison, JobberDayRow } from '@texasrenters/shared';
import Link from 'next/link';
import { useState } from 'react';

import { PersonDisc, personOf } from '@/components/schedule/calendar-visit';
import { Button } from '@/components/ui/button';
import { SegmentedControl } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { businessTimeOfDay } from '@/lib/clock';
import { formatCount, formatScheduledDate } from '@/lib/format';
import { todayBuckets } from '@/lib/home-workflow';
import { typeTitle, typeTone } from '@/lib/inspection-type-tone';
import { JOBBER_DAY_LABEL, isOneSided } from '@/lib/jobber-day';
import { dayColumns, visitStart, weekdayOf } from '@/lib/schedule-calendar';
import { cn } from '@/lib/utils';

/** Rows a group lists before "See N more visits". */
const LISTED = 8;

const VIEWS = [
  { value: 'visit', label: 'Visit' },
  { value: 'employee', label: 'Employee' },
] as const;

interface ListedVisit {
  key: string;
  href: string;
  property: string;
  detail: string;
  person: string | null;
  type: string | null;
  dashed: boolean;
}

/**
 * Jobber's "Today's appointments", for inspections: the day's totals, then
 * the visits grouped Overdue / In progress / Remaining / Done, or the same day
 * by technician. Read from the day comparison the Schedule shows, so the two
 * cannot disagree, plus the visits booked for an earlier day and never started.
 */
export function TodaysVisits({
  date,
  day,
  loading,
  overdue,
  overdueTotal,
}: {
  date: string;
  day: JobberDayComparison | undefined;
  loading: boolean;
  overdue: readonly AdminInspection[];
  /** Null while it is being read, or when this account may not read inspections. */
  overdueTotal: number | null;
}) {
  const [view, setView] = useState<'visit' | 'employee'>('visit');
  const names = new Map(
    (day?.technicians ?? []).flatMap((person) => (person.technicianId ? [[person.technicianId, person.name] as const] : [])),
  );
  const nameOf = (row: JobberDayRow) => (row.technicianId ? (names.get(row.technicianId) ?? personOf(row)) : null);
  const buckets = todayBuckets(day?.rows ?? []);
  const total = buckets.active.length + buckets.remaining.length + buckets.done.length;

  const fromDay = (row: JobberDayRow): ListedVisit => ({
    key: row.key,
    href: row.inspectionId ? `/inspections/${row.inspectionId}` : `/schedule?mode=compare&view=day&date=${date}`,
    property: row.property,
    detail: [
      businessTimeOfDay(visitStart(row)) ?? 'Anytime',
      typeTitle(row.inspectionType),
      row.state !== 'MATCHES' ? JOBBER_DAY_LABEL[row.state] : null,
    ]
      .filter(Boolean)
      .join(' · '),
    person: nameOf(row),
    type: row.inspectionType,
    dashed: isOneSided(row.state),
  });
  const fromOverdue = (inspection: AdminInspection): ListedVisit => ({
    key: inspection.id,
    href: `/inspections/${inspection.id}`,
    property: `${inspection.propertywareBuilding?.name ?? 'Property snapshot'}${
      inspection.propertywareUnit?.name ? ` · ${inspection.propertywareUnit.name}` : ''
    }`,
    detail: `${weekdayOf(inspection.scheduledAt.slice(0, 10))}, ${formatScheduledDate(inspection.scheduledAt)} · ${typeTitle(inspection.inspectionType)}`,
    person: (inspection.assignments ?? []).find((entry) => entry.isCurrent)?.technician?.displayName ?? null,
    type: inspection.inspectionType,
    dashed: false,
  });

  return (
    <section aria-labelledby="today-heading" className="bg-card flex flex-col gap-4 rounded-lg border p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-heading text-xl font-bold" id="today-heading">
          Today&apos;s visits
        </h2>
        <Button asChild size="sm" variant="outline">
          <Link href="/schedule?view=day">View Schedule</Link>
        </Button>
      </div>

      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-5">
        <Total label="Total" value={loading ? null : total} />
        <Total label="In progress" value={loading ? null : buckets.active.length} />
        <Total label="Done" value={loading ? null : buckets.done.length} />
        <Total label="Remaining" value={loading ? null : buckets.remaining.length} />
        <Total label="Overdue" tone={overdueTotal ? 'warning' : undefined} value={overdueTotal} />
      </dl>

      <SegmentedControl aria-label="Show today by" onChange={setView} options={VIEWS} value={view} />

      {loading ? (
        <Skeleton className="h-40 rounded-lg" />
      ) : view === 'visit' ? (
        <div className="flex flex-col gap-5">
          {overdueTotal !== null ? (
            <Group
              count={overdueTotal}
              empty="Nothing booked for an earlier day is still waiting."
              label="Overdue"
              more={
                // Counted from the total, not from what came back: the group
                // lists at most LISTED whatever the answer held.
                overdueTotal > Math.min(overdue.length, LISTED)
                  ? {
                      // The list cannot ask for earlier days only, so the link
                      // says it opens every scheduled inspection.
                      href: '/inspections?status=SCHEDULED&day=all',
                      label: `${formatCount(overdueTotal - Math.min(overdue.length, LISTED))} more overdue · all scheduled inspections`,
                    }
                  : null
              }
              visits={overdue.map(fromOverdue)}
            />
          ) : null}
          <Group count={buckets.active.length} empty="Nobody is in a visit right now." label="In progress" visits={buckets.active.map(fromDay)} />
          <Group count={buckets.remaining.length} empty="Nothing else is booked today." label="Remaining" visits={buckets.remaining.map(fromDay)} />
          {buckets.done.length ? <Group count={buckets.done.length} empty="" label="Done" visits={buckets.done.map(fromDay)} /> : null}
        </div>
      ) : (
        <ByTechnician day={day} />
      )}
    </section>
  );
}

function Total({ label, value, tone }: { label: string; value: number | null; tone?: 'warning' }) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className={cn('font-display text-2xl font-extrabold tabular-nums', tone === 'warning' ? 'text-warning' : 'text-heading')}>
        {value === null ? '…' : formatCount(value)}
      </dd>
    </div>
  );
}

/** "3 REMAINING", then its visits, or a quiet box saying there are none, as Jobber's. */
function Group({
  count,
  empty,
  label,
  more,
  visits,
}: {
  count: number;
  empty: string;
  label: string;
  /** Where the rest are, when the group lists fewer than it holds. */
  more?: { href: string; label: string } | null;
  visits: readonly ListedVisit[];
}) {
  const shown = visits.slice(0, LISTED);
  const hidden = visits.length - LISTED;
  const rest =
    more ??
    (hidden > 0
      ? { href: '/schedule?view=day', label: `See ${formatCount(hidden)} more ${hidden === 1 ? 'visit' : 'visits'}` }
      : null);
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-heading font-mono text-[11px] font-semibold tracking-[0.08em] uppercase">
        {formatCount(count)} {label}
      </h3>
      {shown.length ? (
        <ul className="flex flex-col divide-y rounded-lg border">
          {shown.map((visit) => (
            <li key={visit.key}>
              <Link
                className="hover:bg-accent/50 focus-visible:ring-ring/50 flex items-center gap-3 px-3 py-2.5 outline-none focus-visible:ring-[3px]"
                href={visit.href}
              >
                <span
                  aria-hidden
                  className={cn('w-1 self-stretch rounded-full', typeTone(visit.type).fill, visit.dashed && 'opacity-50')}
                />
                <span className="min-w-0 flex-1">
                  <span className="text-heading block truncate text-sm font-semibold">{visit.property}</span>
                  <span className="text-muted-foreground block truncate text-xs">{visit.detail}</span>
                </span>
                <PersonDisc className="size-6 text-[10px]" name={visit.person} />
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="bg-muted text-muted-foreground rounded-lg px-3 py-3 text-sm">{empty}</p>
      )}
      {rest ? (
        <Button asChild className="self-start" size="sm" variant="ghost">
          <Link href={rest.href}>{rest.label}</Link>
        </Button>
      ) : null}
    </div>
  );
}

/** Jobber's "Employee" toggle: the same day, a row per technician, Unassigned first. */
function ByTechnician({ day }: { day: JobberDayComparison | undefined }) {
  const people = dayColumns(day).map((column) => {
    const stats = day?.technicians.find((person) => person.technicianId === column.technicianId);
    return { ...column, here: stats?.here ?? 0, done: stats?.done ?? 0, differences: stats?.differences ?? 0 };
  });

  return (
    <ul className="flex flex-col divide-y rounded-lg border">
      {people.map((person) => {
        const share = person.here ? Math.round((person.done / person.here) * 100) : 0;
        return (
          <li key={person.technicianId ?? 'nobody'}>
            <Link
              className="hover:bg-accent/50 focus-visible:ring-ring/50 flex items-center gap-3 px-3 py-2.5 outline-none focus-visible:ring-[3px]"
              href="/schedule?view=day"
            >
              <PersonDisc className="size-7 text-[10px]" name={person.technicianId ? person.name : null} />
              <span className="min-w-0 flex-1">
                <span
                  className={cn('block truncate text-sm font-semibold', person.technicianId ? 'text-heading' : 'text-warning')}
                >
                  {person.name}
                </span>
                <span className="text-muted-foreground block text-xs">
                  {person.technicianId
                    ? `${formatCount(person.done)} of ${formatCount(person.here)} done`
                    : `${formatCount(person.here)} with nobody on ${person.here === 1 ? 'it' : 'them'}`}
                  {person.differences ? (
                    <span className="text-warning">
                      {' '}
                      · {person.differences} {person.differences === 1 ? 'differs' : 'differ'} from Jobber
                    </span>
                  ) : null}
                </span>
              </span>
              {person.technicianId ? (
                <span aria-hidden className="bg-muted hidden h-1.5 w-24 overflow-hidden rounded-full sm:block">
                  <span className="bg-primary block h-full rounded-full" style={{ width: `${share}%` }} />
                </span>
              ) : null}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
