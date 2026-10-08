'use client';

import type { AdminAreaComparison } from '@texasrenters/shared';
import { ChevronRightIcon } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import { ComparisonItemsTable } from '@/components/comparison-items-table';
import { ReportShareDialog } from '@/components/report-share-dialog';
import { Stat, StatGroup } from '@/components/stat-card';
import { ErrorState, PageSkeleton } from '@/components/states';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { usePermissions } from '@/lib/auth';
import { CLASSIFICATION_VARIANT, classLabel } from '@/lib/comparison-classification';
import {
  itemChanged,
  itemTotals,
  pairingNote,
  roomDigest,
  roomInFilter,
  type RoomFilter,
  waitingCount,
} from '@/lib/comparison-items';
import { comparisonWaitingOn } from '@/lib/comparison-waiting';
import { formatDateTime } from '@/lib/format';
import { useInspectionComparison } from '@/lib/queries';
import { cn } from '@/lib/utils';

/**
 * Move-in vs move-out comparison (spec §12).
 *
 * Nothing to approve (the office, 2026-10-07). It used to be a draft a
 * reviewer decided room by room and then approved before it could be shared,
 * and the office found itself marking reviewed what the technician had already
 * recorded. What the office reviews is the recordings -- confirming or
 * rejecting the findings on the inspection page -- and the comparison is drawn
 * from that and the two checklists, kept current by the server. It can be sent
 * to the owner or tenant as soon as it is here.
 *
 * Laid out to be scanned (2026-10-09). The office found this page "very messy":
 * the title three times, every room the same weight, each listing every AI
 * finding still to confirm, and "normalized name · 80%" under each name. Now
 * four figures, filters that open on the rooms needing something, one line a
 * room, and inside a room only what changed.
 */

const FILTERS: Array<{ value: RoomFilter; label: string }> = [
  { value: 'attention', label: 'Needs attention' },
  { value: 'damage', label: 'New damage' },
  { value: 'cleaning', label: 'Cleaning only' },
  { value: 'oneSide', label: 'Only in one inspection' },
  { value: 'all', label: 'All rooms' },
];

export function InspectionComparisonPanel({ inspectionId }: { inspectionId: string }) {
  const permissions = usePermissions();
  const comparison = useInspectionComparison(inspectionId);
  const [sharing, setSharing] = useState(false);
  const [filter, setFilter] = useState<RoomFilter | null>(null);
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const data = comparison.data;
  const totals = data ? itemTotals(data.areas) : null;
  const count = (value: RoomFilter) =>
    data?.areas.filter((area) => roomInFilter(area, value)).length ?? 0;
  // Opens on what needs something, unless nothing does.
  const active = filter ?? (count('attention') ? 'attention' : 'all');
  const rooms = data?.areas.filter((area) => roomInFilter(area, active)) ?? [];
  // The findings to confirm have a figure of their own below.
  const recordings = data
    ? comparisonWaitingOn({ recordingsProcessing: data.recordingsProcessing, findingsToConfirm: 0 })
    : [];

  return (
    <section
      aria-labelledby="inspection-comparison-title"
      className="scroll-mt-20 space-y-4"
      id="comparison"
    >
      {/* The page header already says it; named here for the landmark only. */}
      <h2 className="sr-only" id="inspection-comparison-title">
        Move-in vs move-out
      </h2>

      {comparison.isLoading ? (
        <PageSkeleton cards={1} />
      ) : comparison.isError ? (
        <ErrorState error={comparison.error} retry={() => void comparison.refetch()} />
      ) : !data || !totals ? (
        <div className="rounded-lg border border-dashed p-6 text-center">
          <p className="text-muted-foreground text-sm">
            No comparison yet. It is made by itself once the move-out is submitted and its move-in
            is on record.
          </p>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-muted-foreground text-sm">
              Updated {formatDateTime(data.generatedAt)} · keeps itself up to date as findings are
              confirmed
            </p>
            <div className="flex items-center gap-2">
              {/* The same verdicts as a document: what the owner or tenant reads. */}
              <Button asChild size="sm" type="button" variant="outline">
                <Link href={`/inspections/${inspectionId}/comparison-report`}>Open report</Link>
              </Button>
              {permissions.has('reports:share') ? (
                <Button onClick={() => setSharing(true)} size="sm" type="button">
                  Share
                </Button>
              ) : null}
            </div>
          </div>

          {recordings.length ? (
            <Alert variant="info">
              <AlertDescription>{recordings.join(' ')}</AlertDescription>
            </Alert>
          ) : null}

          <StatGroup columns="grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Rooms with new damage"
              tone={totals.freshRooms ? 'destructive' : 'default'}
              value={totals.freshRooms}
            />
            <Stat
              detail={totals.unknown ? `${totals.unknown} more not graded at move-in` : undefined}
              label="Items damaged since move-in"
              tone={totals.fresh ? 'destructive' : 'default'}
              value={totals.fresh}
            />
            <Stat
              label="Items to clean"
              tone={totals.cleaning ? 'warning' : 'default'}
              value={totals.cleaning}
            />
            <Stat
              action={
                data.findingsToConfirm ? (
                  <Button asChild className="h-auto px-0 text-left whitespace-normal" size="sm" variant="link">
                    <Link href={`/inspections/${inspectionId}`}>Review on the inspection page</Link>
                  </Button>
                ) : undefined
              }
              detail="Not on the report until confirmed"
              label="Findings to confirm"
              tone={data.findingsToConfirm ? 'warning' : 'default'}
              value={data.findingsToConfirm}
            />
          </StatGroup>

          <div className="bg-card rounded-xl border">
            <div aria-label="Show rooms" className="flex flex-wrap gap-1.5 border-b p-3" role="group">
              {FILTERS.map((option) => (
                <Button
                  aria-pressed={active === option.value}
                  className="rounded-full"
                  key={option.value}
                  onClick={() => setFilter(option.value)}
                  size="sm"
                  type="button"
                  variant={active === option.value ? 'secondary' : 'ghost'}
                >
                  {option.label}
                  <span className="text-muted-foreground font-mono text-xs tabular-nums">
                    {count(option.value)}
                  </span>
                </Button>
              ))}
            </div>
            {rooms.length ? (
              <ul className="divide-y">
                {rooms.map((area) => (
                  <AreaComparisonRow
                    area={area}
                    inspectionId={inspectionId}
                    key={area.id}
                    onToggle={(next) => setOpened((current) => ({ ...current, [area.id]: next }))}
                    open={opened[area.id] ?? false}
                  />
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground p-4 text-sm">No rooms here.</p>
            )}
          </div>
        </>
      )}

      {sharing ? (
        <ReportShareDialog
          inspectionId={inspectionId}
          kind="COMPARISON"
          onClose={() => setSharing(false)}
        />
      ) : null}
    </section>
  );
}

/** Where a technician's own added rooms are filed: not a floor anyone has. */
const ADDED_AREAS = /^added areas?$/i;

/**
 * One room: a line until opened, then the items that changed and what the
 * office still has to confirm there.
 *
 * The verdict alone was the whole row once, and on Flower Gate it read
 * "uncertain" for thirteen rooms of fifteen. The items are what the verdict is
 * drawn from, so they are a click away.
 */
function AreaComparisonRow({
  area,
  inspectionId,
  open,
  onToggle,
}: {
  area: AdminAreaComparison;
  inspectionId: string;
  open: boolean;
  onToggle: (open: boolean) => void;
}) {
  const [everyItem, setEveryItem] = useState(false);
  const items = area.items ?? [];
  const changed = items.filter(itemChanged);
  const hidden = items.length - changed.length;
  const waiting = waitingCount(area);
  const pairing = pairingNote(area);
  const floor = area.floorName?.trim() || null;
  const subtitle = pairing
    ? `Compared with the move-in’s “${pairing.name}”`
    : floor && ADDED_AREAS.test(floor)
      ? 'Added by the technician'
      : floor;
  const evidence = area.moveOutAreaId
    ? `/inspections/${inspectionId}?area=${area.moveOutAreaId}`
    : null;

  return (
    <li>
      <button
        aria-expanded={open}
        className="hover:bg-muted/50 focus-visible:ring-ring/50 flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm focus-visible:ring-[3px] focus-visible:outline-none"
        onClick={() => onToggle(!open)}
        type="button"
      >
        <ChevronRightIcon
          aria-hidden="true"
          className={cn(
            'text-muted-foreground size-4 shrink-0 transition-transform',
            open && 'rotate-90',
          )}
        />
        {/* Name, then what changed: side by side on a wide screen, stacked on a phone. */}
        <span className="grid min-w-0 flex-1 gap-0.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] sm:items-center sm:gap-3">
          <span className="min-w-0">
            <span className="block font-medium">{area.areaName}</span>
            {subtitle ? (
              <span className="text-muted-foreground block text-xs">{subtitle}</span>
            ) : null}
          </span>
          <span className="text-muted-foreground text-xs sm:text-sm">
            {roomDigest(area).join(' · ')}
          </span>
        </span>
        {/* One width on every row, so the columns before it line up down the list. */}
        <span className="flex shrink-0 items-center justify-end gap-2 sm:w-52">
          {waiting ? (
            <span className="text-info text-xs whitespace-nowrap tabular-nums">
              {waiting} to confirm
            </span>
          ) : null}
          <Badge variant={CLASSIFICATION_VARIANT[area.classification] ?? 'secondary'}>
            {classLabel(area.classification)}
          </Badge>
        </span>
      </button>

      {open ? (
        <div className="space-y-3 px-4 pb-4 sm:pl-11">
          {pairing?.check ? (
            <p className="text-warning text-xs">
              Paired {pairing.check}: check that the move-in&rsquo;s &ldquo;{pairing.name}&rdquo; is
              the same room.
            </p>
          ) : null}
          {/* The comparison's own sentence, where there is no table to read instead. */}
          {!items.length && area.summary ? (
            <p className="text-muted-foreground text-sm">{area.summary}</p>
          ) : null}
          {items.length && !changed.length && !everyItem ? (
            <p className="text-muted-foreground text-sm">
              Nothing changed on the {items.length} {items.length === 1 ? 'item' : 'items'} checked.
            </p>
          ) : null}
          {everyItem || changed.length || (area.otherFindings ?? []).length ? (
            <ComparisonItemsTable
              items={everyItem ? items : changed}
              otherFindings={area.otherFindings ?? []}
            />
          ) : null}
          {hidden ? (
            <Button
              aria-expanded={everyItem}
              className="h-auto px-0"
              onClick={() => setEveryItem(!everyItem)}
              size="sm"
              type="button"
              variant="link"
            >
              {everyItem
                ? 'Show only what changed'
                : `Show ${hidden} more ${hidden === 1 ? 'item' : 'items'}`}
            </Button>
          ) : null}
          {waiting || evidence ? (
            <div className="bg-muted/50 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-lg px-3 py-2 text-sm">
              <span className="text-muted-foreground">
                {waiting
                  ? `${waiting} ${waiting === 1 ? 'finding' : 'findings'} here waiting to be confirmed; not on the report until confirmed.`
                  : 'Every finding here is decided.'}
              </span>
              {evidence ? (
                <Button asChild className="h-auto px-0" size="sm" variant="link">
                  <Link href={evidence}>
                    {waiting ? 'Review in the inspection' : "Open the room's evidence"}
                  </Link>
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
