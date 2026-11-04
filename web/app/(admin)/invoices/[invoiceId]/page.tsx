'use client';

import { acceptsPayment, formatMoney } from '@texasrenters/shared';
import { BanknoteIcon, ExternalLinkIcon } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';

import {
  INVOICE_RECORD,
  InvoicePayments,
  InvoiceStatusBadge,
  LineItemsTable,
  formatInvoiceDay,
} from '@/components/invoices/invoice-parts';
import { RecordPaymentDialog } from '@/components/invoices/record-payment-dialog';
import { PageHeader } from '@/components/page-header';
import { AsideCard, FactTable, PlaceCard, RecordLayout } from '@/components/record/record-kit';
import { ErrorState, PageSkeleton } from '@/components/states';
import { Button } from '@/components/ui/button';
import { usePermissions } from '@/lib/auth';
import { useInvoice } from '@/lib/invoice-queries';

/**
 * One invoice, as Jobber's invoice page lays it out: its status and the one
 * thing to do next -- record a payment -- at the top; the property beside the
 * invoice's details; its products and services with the total; the payments
 * recorded against it and what it still owes.
 */
export default function InvoicePage() {
  const { invoiceId } = useParams<{ invoiceId: string }>();
  const invoice = useInvoice(invoiceId);
  const { has } = usePermissions();
  const [paying, setPaying] = useState(false);

  if (invoice.isLoading) return <PageSkeleton />;
  if (invoice.isError || !invoice.data)
    return <ErrorState error={invoice.error} retry={() => void invoice.refetch()} />;

  const data = invoice.data;
  const payable = acceptsPayment(data) && has('payments:record');
  const visitHref = data.inspectionId ? `/inspections/${data.inspectionId}` : null;

  return (
    <>
      <PageHeader
        actions={
          <>
            {data.jobberUrl ? (
              <Button asChild size="sm" variant="outline">
                <a href={data.jobberUrl} rel="noreferrer" target="_blank">
                  <ExternalLinkIcon />
                  Open in Jobber
                </a>
              </Button>
            ) : null}
            {payable ? (
              <Button className="jobber:bg-success jobber:hover:bg-success/90" onClick={() => setPaying(true)} size="sm">
                <BanknoteIcon />
                Record payment
              </Button>
            ) : null}
          </>
        }
        badges={<InvoiceStatusBadge status={data.status} />}
        record={INVOICE_RECORD}
        title={data.subject}
      />

      <RecordLayout
        aside={
          <>
            <AsideCard title="Balance">
              <dl className="grid grid-cols-[1fr_auto] gap-y-1.5">
                <dt className="text-muted-foreground">Invoice balance</dt>
                <dd className="text-heading text-right font-bold tabular-nums">{formatMoney(data.balanceCents)}</dd>
                {data.accountBalanceCents !== null ? (
                  <>
                    <dt className="text-muted-foreground">Account balance</dt>
                    <dd className="text-right tabular-nums">{formatMoney(data.accountBalanceCents)}</dd>
                  </>
                ) : null}
              </dl>
            </AsideCard>
            {data.clientMessage ? (
              <AsideCard title="Client message">
                <p className="text-muted-foreground whitespace-pre-line">{data.clientMessage}</p>
              </AsideCard>
            ) : null}
          </>
        }
        asideLabel="About this invoice"
      >
        <div className="grid gap-4 lg:grid-cols-2">
          <PlaceCard
            address={data.property ? [data.property.address, data.property.city].filter(Boolean).join(', ') : null}
            href={data.property ? `/properties/${data.property.id}` : undefined}
            lines={data.billingAddress ? [{ label: 'Billing address', value: data.billingAddress }] : []}
            name={data.clientName}
          />
          <FactTable
            facts={[
              { label: 'Invoice #', value: data.number ?? 'Not numbered yet' },
              {
                label: 'Invoice for',
                value: visitHref ? (
                  <Link className="underline underline-offset-2" href={visitHref}>
                    {data.jobNumber ? `Job #${data.jobNumber}` : 'The visit'}
                  </Link>
                ) : data.jobNumber ? (
                  `Job #${data.jobNumber}`
                ) : (
                  '—'
                ),
              },
              { label: 'Issued', value: formatInvoiceDay(data.issuedOn) },
              { label: 'Payment terms', value: data.paymentTerms ?? '—' },
              { label: 'Due date', value: formatInvoiceDay(data.dueOn) },
            ]}
            label="Invoice details"
          />
        </div>

        <section aria-label="Products and services" className="bg-card mt-6 overflow-hidden rounded-lg border">
          <h2 className="text-heading px-4 pt-4 text-lg font-bold">Product / Service</h2>
          <LineItemsTable lineItems={data.lineItems} subtotalCents={data.subtotalCents} totalCents={data.totalCents} />
        </section>

        <section aria-label="Payments recorded" className="bg-card mt-6 rounded-lg border p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-heading text-lg font-bold">Payments</h2>
            <span className="text-sm">
              Balance <span className="text-heading font-bold tabular-nums">{formatMoney(data.balanceCents)}</span>
            </span>
          </div>
          <div className="mt-2">
            <InvoicePayments payments={data.payments} />
          </div>
        </section>
      </RecordLayout>

      {payable ? <RecordPaymentDialog invoice={data} onClose={() => setPaying(false)} open={paying} /> : null}
    </>
  );
}
