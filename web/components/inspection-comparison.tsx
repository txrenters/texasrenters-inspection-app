'use client';

import type { AdminAreaComparison } from '@texasrenters/shared';
import Link from 'next/link';
import { useState } from 'react';

import { ComparisonItemsTable } from '@/components/comparison-items-table';
import { ReportShareDialog } from '@/components/report-share-dialog';
import { ErrorState, PageSkeleton } from '@/components/states';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { usePermissions } from '@/lib/auth';
import { CLASSIFICATION_VARIANT, classLabel } from '@/lib/comparison-classification';
import { itemTotals } from '@/lib/comparison-items';
import { comparisonWaitingOn } from '@/lib/comparison-waiting';
import { formatDateTime, humanize } from '@/lib/format';
import { useInspectionComparison } from '@/lib/queries';

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
 */
export function InspectionComparisonPanel({ inspectionId }: { inspectionId: string }) {
  const permissions = usePermissions();
  const comparison = useInspectionComparison(inspectionId);
  const [sharing, setSharing] = useState(false);
  // Rooms whose items are open. Unset means the default: open where a finding
  // is waiting to be confirmed, so the office lands on what it has to look at.
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const data = comparison.data;
  const totals = data ? itemTotals(data.areas) : null;
  const itemized = data?.areas.some((area) => area.items?.length) ?? false;
  const waiting = data ? comparisonWaitingOn(data) : [];

  return (
    <Card aria-labelledby="inspection-comparison-title" className="scroll-mt-20" id="comparison">
      <CardHeader className="flex-row items-start justify-between">
        <div className="space-y-1">
          <CardTitle id="inspection-comparison-title">Move-in vs move-out</CardTitle>
          <CardDescription>
            Drawn from both inspections&apos; checklists and the findings confirmed from the
            recordings, and kept up to date as they change. Share it with the owner or tenant
            whenever it is ready.
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          {/* The same verdicts as a document: both inspections side by side. */}
          {data ? (
            <Button asChild size="sm" type="button" variant="outline">
              <Link href={`/inspections/${inspectionId}/comparison-report`}>Comparison report</Link>
            </Button>
          ) : null}
          {data && permissions.has('reports:share') ? (
            <Button onClick={() => setSharing(true)} size="sm" type="button">
              Share
            </Button>
          ) : null}
          {data ? (
            <Badge variant={CLASSIFICATION_VARIANT[data.overallCondition] ?? 'secondary'}>
              {classLabel(data.overallCondition)}
            </Badge>
          ) : null}
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {comparison.isLoading ? (
          <PageSkeleton cards={1} />
        ) : comparison.isError ? (
          <ErrorState error={comparison.error} retry={() => void comparison.refetch()} />
        ) : !data ? (
          <div className="rounded-lg border border-dashed p-6 text-center">
            <p className="text-muted-foreground text-sm">
              No comparison yet. It is made by itself once the move-out is submitted and its move-in
              is on record.
            </p>
          </div>
        ) : (
          <>
            {/* What has not reached the report yet. Nothing to press: it
                follows by itself. */}
            {waiting.length ? (
              <Alert variant="info">
                <AlertDescription>
                  <ul className="space-y-0.5">
                    {waiting.map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            ) : null}
            <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="bg-muted/50 rounded-lg p-3">
                <dt className="text-muted-foreground text-xs">Updated</dt>
                <dd className="mt-1 text-sm font-medium">{formatDateTime(data.generatedAt)}</dd>
              </div>
              {itemized && totals ? (
                <div className="bg-muted/50 rounded-lg p-3">
                  <dt className="text-muted-foreground text-xs">Item by item</dt>
                  <dd className="mt-1 text-sm font-medium">
                    {totals.fresh} new since move-in
                    {totals.fresh ? ` (${totals.freshRooms} room${totals.freshRooms === 1 ? '' : 's'})` : ''}
                  </dd>
                  <dd className="text-muted-foreground text-xs">
                    {totals.existing} already at move-in · {totals.cleaning} need cleaning
                    {totals.unknown ? ` · ${totals.unknown} not graded at move-in` : ''}
                  </dd>
                </div>
              ) : null}
            </dl>

            <ul className="divide-y rounded-lg border">
              {data.areas.map((area) => (
                <AreaComparisonRow
                  area={area}
                  inspectionId={inspectionId}
                  key={area.id}
                  onToggle={(next) => setOpened((current) => ({ ...current, [area.id]: next }))}
                  open={opened[area.id] ?? (Boolean(area.aiNote) && (area.items?.length ?? 0) > 0)}
                />
              ))}
            </ul>
          </>
        )}
      </CardContent>

      {sharing ? (
        <ReportShareDialog inspectionId={inspectionId} kind="COMPARISON" onClose={() => setSharing(false)} />
      ) : null}
    </Card>
  );
}

/**
 * One room's verdict, and under it the room's checklist item by item.
 *
 * The verdict alone was the whole row once, and on Flower Gate it read
 * "uncertain" for thirteen rooms of fifteen. The items are what the verdict is
 * drawn from, so they are a click away, and open where a finding waits.
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
  const items = area.items ?? [];
  return (
    <li className="grid gap-3 p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm font-medium">
            {area.areaName}
            {area.floorName ? (
              <span className="text-muted-foreground font-normal"> · {area.floorName}</span>
            ) : null}
          </p>
          {area.summary ? <p className="text-muted-foreground text-sm">{area.summary}</p> : null}
          {/* About unconfirmed AI output, so on screen only: never on the report. */}
          {area.aiNote ? <p className="text-info text-xs">{area.aiNote}</p> : null}
          <p className="text-muted-foreground text-xs">
            {humanize(area.matchMethod).toLowerCase()}
            {area.matchConfidence ? ` · ${Math.round(area.matchConfidence * 100)}%` : ''}
          </p>
        </div>

        <Badge variant={CLASSIFICATION_VARIANT[area.classification] ?? 'secondary'}>
          {classLabel(area.classification)}
        </Badge>
      </div>

      {items.length || area.moveOutAreaId ? (
        <div className="flex flex-wrap items-center gap-2">
          {items.length ? (
            <Button
              aria-expanded={open}
              onClick={() => onToggle(!open)}
              size="sm"
              type="button"
              variant="outline"
            >
              {open ? 'Hide items' : `Show ${items.length} items`}
            </Button>
          ) : null}
          {area.moveOutAreaId ? (
            <Button asChild size="sm" type="button" variant="ghost">
              <Link href={`/inspections/${inspectionId}?area=${area.moveOutAreaId}`}>
                Open the room&apos;s evidence
              </Link>
            </Button>
          ) : null}
        </div>
      ) : null}
      {open && items.length ? (
        <ComparisonItemsTable items={items} otherFindings={area.otherFindings ?? []} />
      ) : null}
    </li>
  );
}
