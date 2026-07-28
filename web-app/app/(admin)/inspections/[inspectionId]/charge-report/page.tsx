'use client';

import type { AdminCharge } from '@texasrenters/shared';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { buttonVariants } from '@/components/ui/button';

import { Badge, ErrorState, LoadingState, formatDate } from '@/components/shared';
import { useChargeReport } from '@/lib/queries';

function money(amount: number | null | undefined, currency = 'USD') {
  if (amount === null || amount === undefined) return '—';
  return `${currency === 'USD' ? '$' : `${currency} `}${amount.toFixed(2)}`;
}

function ChargeTable({ charges, currency }: { charges: AdminCharge[]; currency: string }) {
  if (!charges.length) return <p className="charge-report-empty">None.</p>;
  return (
    <Table className="text-sm">
      <TableHeader>
        <TableRow>
          <TableHead>Description</TableHead>
          <TableHead>Source</TableHead>
          <TableHead>Proposed</TableHead>
          <TableHead>Approved</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {charges.map((charge) => (
          <TableRow key={charge.id}>
            <TableCell>{charge.description}</TableCell>
            <TableCell className="charge-report-source">
              {charge.source.replaceAll('_', ' ').toLowerCase()}
            </TableCell>
            <TableCell>{money(charge.proposedAmount, currency)}</TableCell>
            <TableCell>{money(charge.approvedAmount, currency)}</TableCell>
            <TableCell>{charge.status.replaceAll('_', ' ').toLowerCase()}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export default function ChargeReportPage() {
  const id = useParams<{ inspectionId: string }>().inspectionId;
  const report = useChargeReport(id);

  if (report.isLoading) return <LoadingState label="Loading charge report…" />;
  if (report.isError)
    return <ErrorState error={report.error} retry={() => void report.refetch()} />;
  const data = report.data!;
  const currency = data.totals.currency;

  return (
    <div className="charge-report">
      <div className="charge-report-toolbar">
        <Link className={buttonVariants({ variant: 'secondary' })} href={`/inspections/${id}`}>
          ← Back to inspection
        </Link>
        <button type="button" className={buttonVariants({ variant: 'primary' })} onClick={() => window.print()}>
          Print
        </button>
      </div>

      <header className="charge-report-header">
        <h1>Charge comparison report</h1>
        <p>
          {data.property.name}
          {data.property.unit ? ` · ${data.property.unit}` : ''} · {data.inspection.type} ·{' '}
          {formatDate(data.inspection.scheduledAt)}
        </p>
        <p className="charge-report-legend">
          Sources are labelled: <em>system</em>/<em>ai suggested</em> are recommendations only;{' '}
          <em>administrator</em> reflects a human decision. No charge is final until approved.
        </p>
      </header>

      <section className="charge-report-section">
        <h2>1. Property &amp; lease</h2>
        <dl className="charge-report-facts">
          <div>
            <dt>Property</dt>
            <dd>
              {data.property.name}
              {data.property.address ? `, ${data.property.address}` : ''}
              {data.property.cityState ? `, ${data.property.cityState}` : ''}
            </dd>
          </div>
          <div>
            <dt>Unit</dt>
            <dd>{data.property.unit ?? 'Entire property'}</dd>
          </div>
          <div>
            <dt>Lease</dt>
            <dd>{data.property.lease ?? 'No lease selected'}</dd>
          </div>
          <div>
            <dt>Scheduled move-out</dt>
            <dd>{data.property.scheduledMoveOut ? formatDate(data.property.scheduledMoveOut) : '—'}</dd>
          </div>
        </dl>
      </section>

      {data.comparison ? (
        <section className="charge-report-section">
          <h2>2. Move-in vs move-out comparison</h2>
          <p>
            Overall: <Badge value={data.comparison.overallCondition} /> · status{' '}
            {data.comparison.status.toLowerCase()}
          </p>
          <ul className="charge-report-list">
            {data.comparison.areas.map((area) => (
              <li key={area.areaName}>
                <strong>{area.areaName}</strong> — {area.classification.replaceAll('_', ' ').toLowerCase()}
                {area.requiresReview ? ' (needs review)' : ''}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="charge-report-section">
        <h2>3. New or worsened findings</h2>
        {data.newOrWorsenedFindings.length ? (
          <ul className="charge-report-list">
            {data.newOrWorsenedFindings.map((finding) => (
              <li key={finding.id}>
                <strong>{finding.area}</strong> — {finding.title} ({finding.severity.toLowerCase()},{' '}
                {finding.reviewStatus.replaceAll('_', ' ').toLowerCase()})
              </li>
            ))}
          </ul>
        ) : (
          <p className="charge-report-empty">None.</p>
        )}
      </section>

      <section className="charge-report-section">
        <h2>4. Existing conditions excluded from charges</h2>
        {data.existingConditionExclusions.length ? (
          <ul className="charge-report-list">
            {data.existingConditionExclusions.map((finding) => (
              <li key={finding.id}>
                <strong>{finding.area}</strong> — {finding.title}
              </li>
            ))}
          </ul>
        ) : (
          <p className="charge-report-empty">None.</p>
        )}
      </section>

      <section className="charge-report-section">
        <h2>5. Pet violation review</h2>
        {data.petReview.length ? (
          <ul className="charge-report-list">
            {data.petReview.map((pet) => (
              <li key={pet.id}>
                <strong>{pet.label}</strong> ({pet.species}) — {pet.reviewStatus.replaceAll('_', ' ').toLowerCase()},{' '}
                {pet.authorizationStatus.toLowerCase()} · {pet.observationCount} observation
                {pet.observationCount === 1 ? '' : 's'}
              </li>
            ))}
          </ul>
        ) : (
          <p className="charge-report-empty">No pets observed.</p>
        )}
      </section>

      <section className="charge-report-section">
        <h2>6. Proposed charges</h2>
        <ChargeTable charges={data.charges.proposed} currency={currency} />
      </section>

      <section className="charge-report-section">
        <h2>7. Approved charges</h2>
        <ChargeTable charges={data.charges.approved} currency={currency} />
      </section>

      <section className="charge-report-section">
        <h2>8. Rejected or waived charges</h2>
        <ChargeTable charges={data.charges.rejected} currency={currency} />
      </section>

      <section className="charge-report-section charge-report-totals">
        <h2>9. Totals</h2>
        <p>
          Proposed: <strong>{money(data.totals.proposedTotal, currency)}</strong> · Approved:{' '}
          <strong>{money(data.totals.approvedTotal, currency)}</strong>
        </p>
        {data.rule ? (
          <p className="charge-report-legend">
            Unauthorized-pet rule: {money(data.rule.amount, data.rule.currency)} per unique pet
            {data.rule.isActive ? '' : ' (inactive)'}.
          </p>
        ) : (
          <p className="charge-report-legend">No unauthorized-pet charge rule configured.</p>
        )}
      </section>
    </div>
  );
}
