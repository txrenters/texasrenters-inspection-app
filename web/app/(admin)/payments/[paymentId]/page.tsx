'use client';

import { INVOICE_STATUS_LABEL, PAYMENT_METHOD_LABEL, formatMoney } from '@texasrenters/shared';
import { ReceiptTextIcon } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';

import { PAYMENT_RECORD, formatInvoiceDay, formatInvoiceMoment } from '@/components/invoices/invoice-parts';
import { PageHeader } from '@/components/page-header';
import { AsideCard, FactTable, PlaceCard, RecordLayout, type Fact } from '@/components/record/record-kit';
import { ErrorState, PageSkeleton } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { usePayment } from '@/lib/invoice-queries';

/**
 * One payment, as Jobber's payment page shows it (2026-11-05: "payment items
 * are not clickable"): how much, when and how it was paid, its reference and
 * details, where it was recorded, and the invoice it went to with what that
 * invoice still owes. Reading only: changing or removing a payment is the next
 * step of the cutover.
 */
export default function PaymentPage() {
  const { paymentId } = useParams<{ paymentId: string }>();
  const payment = usePayment(paymentId);

  if (payment.isLoading) return <PageSkeleton />;
  if (payment.isError || !payment.data)
    return <ErrorState error={payment.error} retry={() => void payment.refetch()} />;

  const data = payment.data;
  const invoiceName = data.invoice.number ? `Invoice #${data.invoice.number}` : data.invoice.subject;
  const facts: Fact[] = [
    { label: 'Amount', value: <span className="font-bold tabular-nums">{formatMoney(data.amountCents)}</span> },
    { label: 'Payment date', value: formatInvoiceDay(data.paidOn) },
    {
      label: 'Method',
      value: PAYMENT_METHOD_LABEL[data.method],
      // Jobber's own word, when the console files it under a broader one.
      detail: data.jobberPaymentType ? `In Jobber: ${jobberTypeLabel(data.jobberPaymentType)}` : undefined,
    },
    { label: 'Reference', value: data.reference ?? '—' },
    {
      label: 'Recorded',
      value: data.recordedBy ? `By ${data.recordedBy.displayName}` : data.origin === 'JOBBER' ? 'In Jobber' : 'In the console',
      detail: data.origin === 'CONSOLE' ? formatInvoiceMoment(data.recordedAt) : undefined,
    },
  ];

  return (
    <>
      <PageHeader
        actions={
          <Button asChild size="sm" variant="outline">
            <Link href={`/invoices/${data.invoice.id}`}>
              <ReceiptTextIcon />
              Open the invoice
            </Link>
          </Button>
        }
        badges={<Badge variant="success">{data.origin === 'JOBBER' ? 'From Jobber' : 'Recorded here'}</Badge>}
        record={PAYMENT_RECORD}
        title={`Payment for ${invoiceName}`}
      />

      <RecordLayout
        aside={
          <AsideCard title="Applied to">
            <dl className="grid grid-cols-[1fr_auto] gap-y-1.5">
              <dt className="text-muted-foreground">Invoice</dt>
              <dd className="text-right">
                <Link className="underline underline-offset-2" href={`/invoices/${data.invoice.id}`}>
                  {data.invoice.number ? `#${data.invoice.number}` : data.invoice.subject}
                </Link>
              </dd>
              <dt className="text-muted-foreground">Invoice total</dt>
              <dd className="text-right tabular-nums">{formatMoney(data.invoiceTotalCents)}</dd>
              <dt className="text-muted-foreground">Still owed</dt>
              <dd className="text-heading text-right font-bold tabular-nums">{formatMoney(data.invoiceBalanceCents)}</dd>
            </dl>
            {data.invoiceBalanceCents === 0 ? (
              <p className="text-muted-foreground mt-2 text-xs">{INVOICE_STATUS_LABEL.PAID} in full.</p>
            ) : null}
          </AsideCard>
        }
        asideLabel="About this payment"
      >
        <div className="grid gap-4 lg:grid-cols-2">
          <PlaceCard
            address={data.property ? [data.property.address, data.property.city].filter(Boolean).join(', ') : null}
            href={data.property ? `/properties/${data.property.id}` : undefined}
            name={data.invoice.clientName}
          />
          <FactTable facts={facts} label="Payment details" />
        </div>

        {data.note ? (
          <section aria-label="Details" className="bg-card mt-6 rounded-lg border p-4">
            <h2 className="text-heading text-base font-bold">Details</h2>
            <p className="text-muted-foreground mt-2 text-sm whitespace-pre-line">{data.note}</p>
          </section>
        ) : null}
      </RecordLayout>
    </>
  );
}

/** Jobber's payment type as words: "ACH_BANK_PAYMENT" is "ACH bank payment". */
function jobberTypeLabel(type: string) {
  const words = type.toLowerCase().split('_').join(' ');
  return (words.charAt(0).toUpperCase() + words.slice(1)).replace(/\bach\b/i, 'ACH');
}
