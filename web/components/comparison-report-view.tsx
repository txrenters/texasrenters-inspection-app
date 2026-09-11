'use client';

import type {
  ComparisonReport,
  ComparisonReportArea,
  ComparisonReportAreaSide,
  PublicReportPhoto,
} from '@texasrenters/shared';
import type { ReactNode } from 'react';

import { Badge } from '@/components/ui/badge';
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

/**
 * How a photograph is fetched, which is the only thing that differs between the
 * two places this document is read.
 *
 * The console fetches bytes with credentials and renders a blob. A shared link
 * has no session, so it points an `<img>` straight at the API — which works only
 * because that route sets `Cross-Origin-Resource-Policy: cross-origin`; Helmet's
 * default blocks an image the browser has already downloaded, and it looks
 * exactly like a broken photo rather than a header problem.
 */
export type PhotoRenderer = (photo: PublicReportPhoto, areaName: string) => ReactNode;

/**
 * A tri-state condition cell.
 *
 * `null` is "not assessed" and renders blank. Printing "No" for a row nobody
 * graded would publish a defect that was never observed.
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
function SidePanel({
  side,
  label,
  renderPhoto,
}: {
  side: ComparisonReportAreaSide | null;
  label: string;
  renderPhoto: PhotoRenderer;
}) {
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
          {side.photos.map((photo) => renderPhoto(photo, side.name))}
        </div>
      ) : (
        <div className="text-xs text-muted-foreground">No photographs.</div>
      )}
    </div>
  );
}

/** One area, move-in on the left and move-out on the right, under its verdict. */
function AreaRow({ area, renderPhoto }: { area: ComparisonReportArea; renderPhoto: PhotoRenderer }) {
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
        {area.summary ? <p className="text-sm text-muted-foreground">{area.summary}</p> : null}
        {area.overrideReason ? (
          <p className="text-xs text-muted-foreground">Reviewer: {area.overrideReason}</p>
        ) : null}
      </CardHeader>
      <CardContent>
        <div className="grid gap-6 md:grid-cols-2">
          <div>
            <h4 className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">Move-in</h4>
            <SidePanel label="move-in" renderPhoto={renderPhoto} side={area.moveIn} />
          </div>
          <div className="md:border-l md:pl-6">
            <h4 className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">Move-out</h4>
            <SidePanel label="move-out" renderPhoto={renderPhoto} side={area.moveOut} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function propertyAddress(property: ComparisonReport['property']) {
  return (
    [
      property.addressLine1,
      property.unitName,
      [property.city, property.state].filter(Boolean).join(', '),
      property.postalCode,
    ]
      .filter(Boolean)
      .join(' · ') || EMPTY
  );
}

/**
 * The comparison document, rendered identically for the console and for a
 * shared link. Only how a photograph is fetched differs, so that is the only
 * thing the caller supplies.
 */
export function ComparisonReportView({
  report,
  renderPhoto,
}: {
  report: ComparisonReport;
  renderPhoto: PhotoRenderer;
}) {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Comparison report</CardTitle>
          <p className="text-sm text-muted-foreground">{propertyAddress(report.property)}</p>
        </CardHeader>
        <CardContent className="space-y-4">
          {/*
            Move-in left, move-out right — the same order every area row uses
            below, so the eye never has to re-learn which column is which.
          */}
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <h3 className="text-xs uppercase tracking-wide text-muted-foreground">Move-in</h3>
              <div className="mt-1 space-y-0.5 text-sm">
                <div>{report.moveIn.templateLabel ?? humanize(report.moveIn.type)}</div>
                <div className="text-muted-foreground">
                  {formatDate(report.moveIn.completedAt ?? report.moveIn.scheduledAt)}
                </div>
                <div className="text-muted-foreground">{report.moveIn.inspector ?? EMPTY}</div>
              </div>
            </div>
            <div className="md:border-l md:pl-4">
              <h3 className="text-xs uppercase tracking-wide text-muted-foreground">Move-out</h3>
              <div className="mt-1 space-y-0.5 text-sm">
                <div>{report.moveOut.templateLabel ?? humanize(report.moveOut.type)}</div>
                <div className="text-muted-foreground">
                  {formatDate(report.moveOut.completedAt ?? report.moveOut.scheduledAt)}
                </div>
                <div className="text-muted-foreground">{report.moveOut.inspector ?? EMPTY}</div>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t pt-3 text-sm">
            <Badge
              variant={CLASSIFICATION_VARIANT[report.comparison.overallCondition] ?? 'secondary'}
            >
              {classLabel(report.comparison.overallCondition)}
            </Badge>
            <span className="text-muted-foreground">
              {humanize(report.comparison.status)} · v{report.comparison.version}
            </span>
            {report.comparison.reviewedByName ? (
              <span className="text-muted-foreground">
                · reviewed by {report.comparison.reviewedByName}
              </span>
            ) : null}
          </div>
          {report.comparison.summary ? (
            <p className="text-sm text-muted-foreground">{report.comparison.summary}</p>
          ) : null}
        </CardContent>
      </Card>

      {report.areas.map((area) => (
        <AreaRow area={area} key={area.id} renderPhoto={renderPhoto} />
      ))}
    </div>
  );
}
