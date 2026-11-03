'use client';

import type { AdminInspection } from '@texasrenters/shared';
import { ChevronDownIcon, PlusIcon } from 'lucide-react';
import Link from 'next/link';

import { ErrorState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { formatCount, formatRelative, formatScheduledDate } from '@/lib/format';
import { typeTitle, typeTone } from '@/lib/inspection-type-tone';
import { JOBBER_CREATE_TYPES } from '@/lib/jobber-navigation';
import { useInspections } from '@/lib/queries';
import { weekdayOf } from '@/lib/schedule-calendar';
import { cn } from '@/lib/utils';

import { AsideCard } from './record-kit';

/**
 * The property page's Jobber layout (the office, 2026-11-04: "we want the
 * features for familiarity"), as Jobber's client page: "+ Create" for work at
 * this place, the work it has had, and an overview at the side.
 */

/** Jobber's "+ Create" on a client, for this property: one item per inspection type. */
export function PropertyCreateMenu({ propertyId }: { propertyId: string }) {
  const base = `/inspections/new?propertyId=${encodeURIComponent(propertyId)}`;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button>
          <PlusIcon />
          Create
          <ChevronDownIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="text-muted-foreground text-xs font-medium">Inspection here</DropdownMenuLabel>
        {JOBBER_CREATE_TYPES.map((entry) => (
          <DropdownMenuItem asChild key={entry.type}>
            <Link href={`${base}&type=${encodeURIComponent(entry.type)}`}>
              <span aria-hidden className={cn('size-2 rounded-full', typeTone(entry.type).fill)} />
              {entry.title}
            </Link>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href={base}>Another type…</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** How many inspections the work list shows before "See all". */
const WORK_LISTED = 10;

/**
 * Jobber's "Work overview" for a client, as the inspections at this property,
 * newest first. One read of a ten-row page when the page opens, never polled.
 */
export function PropertyWork({ propertyId, propertyName }: { propertyId: string; propertyName: string }) {
  const work = useInspections({ propertyId, page: 1, pageSize: WORK_LISTED });
  const items = work.data?.items ?? [];
  const total = work.data?.total ?? 0;
  // The list has no property filter in its address, so "See all" searches it
  // by the property's name, which is what the list's search matches on.
  const allHref = `/inspections?q=${encodeURIComponent(propertyName)}&day=all`;

  return (
    <section aria-labelledby="property-work" className="bg-card mt-4 overflow-hidden rounded-lg border">
      <header className="flex items-center justify-between gap-3 px-4 pt-4 pb-3">
        <h2 className="text-heading text-base font-bold" id="property-work">
          Inspections
          {work.data ? <span className="text-muted-foreground ml-2 text-sm font-normal">({formatCount(total)})</span> : null}
        </h2>
        {total > items.length ? (
          <Button asChild className="h-7 px-2 text-xs" size="sm" variant="ghost">
            <Link href={allHref}>See all</Link>
          </Button>
        ) : null}
      </header>
      {work.isError ? (
        <ErrorState className="rounded-none border-0" error={work.error} retry={() => void work.refetch()} />
      ) : work.isLoading ? (
        <div className="flex flex-col gap-2 px-4 pb-4">
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton className="h-12 rounded-lg" key={index} />
          ))}
        </div>
      ) : items.length ? (
        <ul className="divide-y border-t">
          {items.map((inspection) => (
            <WorkRow inspection={inspection} key={inspection.id} />
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground border-t px-4 py-4 text-sm">No inspection has been booked here yet.</p>
      )}
    </section>
  );
}

function WorkRow({ inspection }: { inspection: AdminInspection }) {
  const technician = (inspection.assignments ?? []).find((entry) => entry.isCurrent)?.technician?.displayName;
  const day = inspection.scheduledAt.slice(0, 10);
  return (
    <li>
      <Link
        className="hover:bg-accent/50 focus-visible:ring-ring/50 flex items-center gap-3 px-4 py-3 outline-none focus-visible:ring-[3px]"
        href={`/inspections/${inspection.id}`}
      >
        <span aria-hidden className={cn('w-1 self-stretch rounded-full', typeTone(inspection.inspectionType).fill)} />
        <span className="min-w-0 flex-1">
          <span className="text-heading block truncate text-sm font-semibold">
            {typeTitle(inspection.inspectionType)}
            {inspection.propertywareUnit?.name ? ` · ${inspection.propertywareUnit.name}` : ''}
          </span>
          <span className="text-muted-foreground block truncate text-xs">
            {weekdayOf(day)}, {formatScheduledDate(inspection.scheduledAt)} · {technician ?? 'Nobody yet'}
          </span>
        </span>
        <StatusBadge value={inspection.status} />
      </Link>
    </li>
  );
}

/** Jobber's side panel, for a property: what it holds and when it was last heard from. */
export function PropertyRecordAside({
  inspections,
  lastSyncedAt,
  leases,
  units,
}: {
  inspections: number | undefined;
  lastSyncedAt: string | null | undefined;
  leases: number;
  units: number | undefined;
}) {
  const row = (label: string, value: string) => (
    <div className="flex items-center justify-between gap-2" key={label}>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-heading font-mono tabular-nums">{value}</dd>
    </div>
  );
  return (
    <AsideCard title="Overview">
      <dl className="flex flex-col gap-2">
        {row('Inspections', inspections === undefined ? '—' : formatCount(inspections))}
        {row('Active units', units === undefined ? '—' : formatCount(units))}
        {row('Relevant leases', formatCount(leases))}
        {row('Last synchronized', lastSyncedAt ? formatRelative(lastSyncedAt) : '—')}
      </dl>
    </AsideCard>
  );
}
