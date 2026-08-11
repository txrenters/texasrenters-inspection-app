'use client';

import type { AdminCharge } from '@texasrenters/shared';
import { ArrowLeftIcon, PrinterIcon } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { ReactNode } from 'react';

import { ErrorState, PageSkeleton } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
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
import { EMPTY, formatDate, humanize } from '@/lib/format';
import { useChargeReport } from '@/lib/queries';

function money(amount: number | null | undefined, currency = 'USD') {
  if (amount === null || amount === undefined) return EMPTY;
  return `${currency === 'USD' ? '$' : `${currency} `}${amount.toFixed(2)}`;
}

/**
 * A numbered section of the report.
 *
 * The number is part of the record: this document is printed and referred to by
 * section, so "see section 6" has to mean something on paper.
 */
function ReportSection({
  index,
  title,
  children,
}: {
  index: number;
  title: string;
  children: ReactNode;
}) {
  return (
    <Card className="break-inside-avoid">
      <CardHeader>
        <CardTitle className="text-base">
          <span className="text-muted-foreground mr-2 tabular-nums">{index}.</span>
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function Nothing({ children = 'None.' }: { children?: string }) {
  return <p className="text-muted-foreground text-sm">{children}</p>;
}

function ChargeTable({ charges, currency }: { charges: AdminCharge[]; currency: string }) {
  if (!charges.length) return <Nothing />;
  return (
    <div className="overflow-hidden rounded-lg border">
      <Table>
        <TableHeader className="bg-muted/40">
          <TableRow className="hover:bg-transparent">
            <TableHead>Description</TableHead>
            <TableHead>Source</TableHead>
            <TableHead className="text-right">Proposed</TableHead>
            <TableHead className="text-right">Approved</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {charges.map((charge) => (
            <TableRow key={charge.id}>
              <TableCell>{charge.description}</TableCell>
              <TableCell className="text-muted-foreground">{humanize(charge.source)}</TableCell>
              <TableCell className="text-right tabular-nums">
                {money(charge.proposedAmount, currency)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {money(charge.approvedAmount, currency)}
              </TableCell>
              <TableCell>
                <StatusBadge showIcon={false} value={charge.status} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export default function ChargeReportPage() {
  const id = useParams<{ inspectionId: string }>().inspectionId;
  const report = useChargeReport(id);

  // isError first: a failed fetch has no data either.
  if (report.isError) return <ErrorState error={report.error} retry={() => void report.refetch()} />;
  if (!report.data) return <PageSkeleton cards={4} />;
  const data = report.data;
  const currency = data.totals.currency;

  return (
    <div className="space-y-4">
      {/* `print:hidden` throughout: this page is printed and handed over, and
          navigation chrome on a printed page is noise. */}
      <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
        <Button asChild variant="outline">
          <Link href={`/inspections/${id}`}>
            <ArrowLeftIcon />
            Back to inspection
          </Link>
        </Button>
        <Button onClick={() => window.print()} type="button">
          <PrinterIcon />
          Print
        </Button>
      </div>

      <header className="space-y-2">
        <h1 className="text-xl font-semibold tracking-tight">Charge comparison report</h1>
        <p className="text-muted-foreground text-sm">
          {data.property.name}
          {data.property.unit ? ` · ${data.property.unit}` : ''} · {humanize(data.inspection.type)} ·{' '}
          {formatDate(data.inspection.scheduledAt)}
        </p>
        <p className="text-muted-foreground text-xs text-pretty">
          Sources are labelled: <em>system</em> / <em>ai suggested</em> are recommendations only;{' '}
          <em>administrator</em> reflects a human decision. No charge is final until approved.
        </p>
      </header>

      <ReportSection index={1} title="Property & lease">
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-muted-foreground text-xs">Property</dt>
            <dd className="mt-0.5 text-sm">
              {data.property.name}
              {data.property.address ? `, ${data.property.address}` : ''}
              {data.property.cityState ? `, ${data.property.cityState}` : ''}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs">Unit</dt>
            <dd className="mt-0.5 text-sm">{data.property.unit ?? 'Entire property'}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs">Lease</dt>
            <dd className="mt-0.5 text-sm">{data.property.lease ?? 'No lease selected'}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs">Scheduled move-out</dt>
            <dd className="mt-0.5 text-sm">{formatDate(data.property.scheduledMoveOut)}</dd>
          </div>
        </dl>
      </ReportSection>

      {data.comparison ? (
        <ReportSection index={2} title="Move-in vs move-out comparison">
          <p className="mb-3 flex flex-wrap items-center gap-2 text-sm">
            Overall: <StatusBadge value={data.comparison.overallCondition} /> · status{' '}
            {humanize(data.comparison.status).toLowerCase()}
          </p>
          <ul className="divide-y rounded-lg border">
            {data.comparison.areas.map((area) => (
              <li className="flex items-center justify-between gap-3 p-2.5 text-sm" key={area.areaName}>
                <span className="font-medium">{area.areaName}</span>
                <span className="text-muted-foreground">
                  {humanize(area.classification).toLowerCase()}
                  {area.requiresReview ? ' (needs review)' : ''}
                </span>
              </li>
            ))}
          </ul>
        </ReportSection>
      ) : null}

      <ReportSection index={3} title="New or worsened findings">
        {data.newOrWorsenedFindings.length ? (
          <ul className="divide-y rounded-lg border">
            {data.newOrWorsenedFindings.map((finding) => (
              <li className="flex flex-wrap items-center justify-between gap-2 p-2.5 text-sm" key={finding.id}>
                <span>
                  <span className="font-medium">{finding.area}</span> — {finding.title}
                </span>
                <span className="text-muted-foreground text-xs">
                  {humanize(finding.severity).toLowerCase()} ·{' '}
                  {humanize(finding.reviewStatus).toLowerCase()}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <Nothing />
        )}
      </ReportSection>

      <ReportSection index={4} title="Existing conditions excluded from charges">
        {data.existingConditionExclusions.length ? (
          <ul className="divide-y rounded-lg border">
            {data.existingConditionExclusions.map((finding) => (
              <li className="p-2.5 text-sm" key={finding.id}>
                <span className="font-medium">{finding.area}</span> — {finding.title}
              </li>
            ))}
          </ul>
        ) : (
          <Nothing />
        )}
      </ReportSection>

      <ReportSection index={5} title="Pet violation review">
        {data.petReview.length ? (
          <ul className="divide-y rounded-lg border">
            {data.petReview.map((pet) => (
              <li className="flex flex-wrap items-center justify-between gap-2 p-2.5 text-sm" key={pet.id}>
                <span>
                  <span className="font-medium">{pet.label}</span> ({pet.species})
                </span>
                <span className="text-muted-foreground text-xs">
                  {humanize(pet.reviewStatus).toLowerCase()},{' '}
                  {humanize(pet.authorizationStatus).toLowerCase()} · {pet.observationCount}{' '}
                  observation{pet.observationCount === 1 ? '' : 's'}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <Nothing>No pets observed.</Nothing>
        )}
      </ReportSection>

      <ReportSection index={6} title="Proposed charges">
        <ChargeTable charges={data.charges.proposed} currency={currency} />
      </ReportSection>

      <ReportSection index={7} title="Approved charges">
        <ChargeTable charges={data.charges.approved} currency={currency} />
      </ReportSection>

      <ReportSection index={8} title="Rejected or waived charges">
        <ChargeTable charges={data.charges.rejected} currency={currency} />
      </ReportSection>

      <ReportSection index={9} title="Totals">
        <dl className="grid gap-3 sm:grid-cols-2">
          <div className="bg-muted/50 rounded-lg p-3">
            <dt className="text-muted-foreground text-xs">Proposed</dt>
            <dd className="mt-0.5 text-lg font-semibold tabular-nums">
              {money(data.totals.proposedTotal, currency)}
            </dd>
          </div>
          <div className="bg-muted/50 rounded-lg p-3">
            <dt className="text-muted-foreground text-xs">Approved</dt>
            <dd className="mt-0.5 text-lg font-semibold tabular-nums">
              {money(data.totals.approvedTotal, currency)}
            </dd>
          </div>
        </dl>
        <p className="text-muted-foreground mt-3 text-xs">
          {data.rule
            ? `Unauthorized-pet rule: ${money(data.rule.amount, data.rule.currency)} per unique pet${data.rule.isActive ? '' : ' (inactive)'}.`
            : 'No unauthorized-pet charge rule configured.'}
        </p>
      </ReportSection>
    </div>
  );
}
