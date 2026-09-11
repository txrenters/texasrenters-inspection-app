'use client';

import type { ComparisonReportArea, ComparisonReportAreaSide } from '@texasrenters/shared';
import { ArrowLeftIcon, PrinterIcon } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';

import { LazyPhoto } from '@/components/area-evidence/LazyPhoto';
import { ErrorState, PageSkeleton } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { CLASSIFICATION_VARIANT, classLabel } from '@/lib/comparison-classification';
import { EMPTY, formatDate, humanize } from '@/lib/format';
import { useComparisonReport } from '@/lib/queries';

/**
 * A tri-state condition cell.
 *
 * `null` is "not assessed" and must render blank. Printing "No" for a row
 * nobody graded would publish a defect that was never observed — the same rule
 * the inspection report follows, and the reason these are three booleans rather
 * than a pass/fail flag.
 */
function Grade({ value }: { value: boolean | null }) {
  if (value === null || value === undefined) return <span className="text-muted-foreground">—</span>;
  return value ? (
    <span className="text-success">Y</span>
  ) : (
    <span className="font-semibold text-destructive">N</span>
  );
}

/** One inspection's evidence for one area: condition, findings, photographs. */
function SidePanel({ side, label }: { side: ComparisonReportAreaSide | null; label: string }) {
  if (!side)
    return (
      <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
        No {label} record for this area.
      </div>
    );

  const graded = side.checklist.filter(
    (item) => item.isClean !== null || item.isUndamaged !== null || item.isWorking !== null,
  );

  return (
    <div className="space-y-3">
      <div className="text-xs text-muted-foreground">
        {humanize(side.completionStatus)}
        {side.skipReason ? ` · ${side.skipReason}` : ''}
      </div>

      {graded.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Item</TableHead>
              <TableHead className="w-8 text-center" title="Clean">
                C
              </TableHead>
              <TableHead className="w-8 text-center" title="Undamaged">
                U
              </TableHead>
              <TableHead className="w-8 text-center" title="Working">
                W
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {graded.map((item) => (
              <TableRow key={item.id}>
                <TableCell>
                  {item.label}
                  {item.comment ? (
                    <div className="text-xs text-muted-foreground">{item.comment}</div>
                  ) : null}
                </TableCell>
                <TableCell className="text-center">
                  <Grade value={item.isClean} />
                </TableCell>
                <TableCell className="text-center">
                  <Grade value={item.isUndamaged} />
                </TableCell>
                <TableCell className="text-center">
                  <Grade value={item.isWorking} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <div className="text-sm text-muted-foreground">No condition was graded here.</div>
      )}

      {side.findings.length > 0 ? (
        <ul className="space-y-1 text-sm">
          {side.findings.map((finding) => (
            <li key={finding.id}>
              <span className="font-medium">{finding.title}</span>
              <span className="text-muted-foreground">
                {' '}
                · {humanize(finding.severity).toLowerCase()}
              </span>
              {finding.description ? (
                <div className="text-xs text-muted-foreground">{finding.description}</div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {side.photos.length > 0 ? (
        <div className="grid grid-cols-3 gap-2">
          {side.photos.map((photo) => (
            <LazyPhoto key={photo.id} photo={photo} areaName={side.name} />
          ))}
        </div>
      ) : (
        <div className="text-xs text-muted-foreground">No photographs.</div>
      )}
    </div>
  );
}

/** One area, move-in on the left and move-out on the right, under its verdict. */
function AreaRow({ area }: { area: ComparisonReportArea }) {
  const overridden =
    area.originalClassification && area.originalClassification !== area.classification;

  return (
    <Card className="break-inside-avoid">
      <CardHeader className="gap-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">
            {area.areaName}
            {area.floorName ? (
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                {area.floorName}
              </span>
            ) : null}
          </CardTitle>
          <div className="flex items-center gap-2">
            {overridden ? (
              <span className="text-xs text-muted-foreground">
                overridden from {classLabel(area.originalClassification as string)}
              </span>
            ) : null}
            <Badge variant={CLASSIFICATION_VARIANT[area.classification] ?? 'secondary'}>
              {classLabel(area.classification)}
            </Badge>
          </div>
        </div>
        {area.summary ? (
          <p className="text-sm text-muted-foreground">{area.summary}</p>
        ) : null}
        {area.overrideReason ? (
          <p className="text-xs text-muted-foreground">Reviewer: {area.overrideReason}</p>
        ) : null}
      </CardHeader>
      <CardContent>
        <div className="grid gap-6 md:grid-cols-2">
          <div>
            <h4 className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">Move-in</h4>
            <SidePanel side={area.moveIn} label="move-in" />
          </div>
          <div className="md:border-l md:pl-6">
            <h4 className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">Move-out</h4>
            <SidePanel side={area.moveOut} label="move-out" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function ComparisonReportPage() {
  const params = useParams<{ inspectionId: string }>();
  const inspectionId = params?.inspectionId ?? '';
  const { data, isLoading, error, refetch } = useComparisonReport(inspectionId);

  if (isLoading) return <PageSkeleton />;
  if (error || !data)
    return <ErrorState error={error ?? new Error('Report unavailable')} retry={() => void refetch()} />;

  const address = [
    data.property.addressLine1,
    data.property.unitName,
    [data.property.city, data.property.state].filter(Boolean).join(', '),
    data.property.postalCode,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
        <Button asChild variant="ghost" size="sm">
          <Link href={`/inspections/${inspectionId}/comparison`}>
            <ArrowLeftIcon className="size-4" />
            Back to comparison
          </Link>
        </Button>
        <Button onClick={() => window.print()} size="sm" variant="outline">
          <PrinterIcon className="size-4" />
          Print
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Comparison report</CardTitle>
          <p className="text-sm text-muted-foreground">{address || EMPTY}</p>
        </CardHeader>
        <CardContent className="space-y-4">
          {/*
            Move-in left, move-out right — the same order every area row uses
            below, so the eye never has to re-learn which column is which.
          */}
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <h3 className="text-xs uppercase tracking-wide text-muted-foreground">Move-in</h3>
              <dl className="mt-1 space-y-0.5 text-sm">
                <div>{data.moveIn.templateLabel ?? humanize(data.moveIn.type)}</div>
                <div className="text-muted-foreground">
                  {formatDate(data.moveIn.completedAt ?? data.moveIn.scheduledAt)}
                </div>
                <div className="text-muted-foreground">{data.moveIn.inspector ?? EMPTY}</div>
              </dl>
            </div>
            <div className="md:border-l md:pl-4">
              <h3 className="text-xs uppercase tracking-wide text-muted-foreground">Move-out</h3>
              <dl className="mt-1 space-y-0.5 text-sm">
                <div>{data.moveOut.templateLabel ?? humanize(data.moveOut.type)}</div>
                <div className="text-muted-foreground">
                  {formatDate(data.moveOut.completedAt ?? data.moveOut.scheduledAt)}
                </div>
                <div className="text-muted-foreground">{data.moveOut.inspector ?? EMPTY}</div>
              </dl>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t pt-3 text-sm">
            <Badge variant={CLASSIFICATION_VARIANT[data.comparison.overallCondition] ?? 'secondary'}>
              {classLabel(data.comparison.overallCondition)}
            </Badge>
            <span className="text-muted-foreground">
              {humanize(data.comparison.status)} · v{data.comparison.version}
            </span>
            {data.comparison.reviewedByName ? (
              <span className="text-muted-foreground">
                · reviewed by {data.comparison.reviewedByName}
              </span>
            ) : null}
          </div>
          {data.comparison.summary ? (
            <p className="text-sm text-muted-foreground">{data.comparison.summary}</p>
          ) : null}
        </CardContent>
      </Card>

      {data.areas.map((area) => (
        <AreaRow area={area} key={area.id} />
      ))}
    </div>
  );
}
