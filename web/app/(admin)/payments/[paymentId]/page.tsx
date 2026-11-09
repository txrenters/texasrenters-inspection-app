'use client';

import { INVOICE_STATUS_LABEL, PAYMENT_METHOD_LABEL, formatMoney, paymentLockedReason } from '@texasrenters/shared';
import { DownloadIcon, PencilIcon, ReceiptTextIcon, Trash2Icon } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import { ChangePaymentDialog, RemovePaymentDialog } from '@/components/invoices/change-payment-dialog';
import { PAYMENT_RECORD, formatInvoiceDay, formatInvoiceMoment } from '@/components/invoices/invoice-parts';
import { PageHeader } from '@/components/page-header';
import { AsideCard, FactTable, PlaceCard, RecordLayout, type Fact } from '@/components/record/record-kit';
import { ErrorState, PageSkeleton } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { usePermissions } from '@/lib/auth';
import { usePayment } from '@/lib/invoice-queries';
import { downloadReceipt } from '@/lib/receipt-pdf/download-receipt';

/**
 * One payment, as Jobber's payment page shows it (2026-11-05: "payment items
 * are not clickable"): how much, when and how it was paid, its reference and
 * details, where it was recorded, and the invoice it went to with what that
 * invoice still owes. Its receipt downloads as a PDF. Once the console owns
 * payments (2026-11-06), whoever records payments can correct one or take it
 * off its invoice; until then Jobber holds them, and the page says so.
 */
export default function PaymentPage() {
  const { paymentId } = useParams<{ paymentId: string }>();
  const payment = usePayment(paymentId);
  const { has } = usePermissions();
  const router = useRouter();
  const [changing, setChanging] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [downloading, setDownloading] = useState(false);

  if (payment.isLoading) return <PageSkeleton />;
  if (payment.isError || !payment.data)
    return <ErrorState error={payment.error} retry={() => void payment.refetch()} />;

  const data = payment.data;
  const mayRecord = has('payments:record');
  const locked = paymentLockedReason(data);
  const changeable = mayRecord && data.writesEnabled && !locked;
  const receipt = async () => {
    setDownloading(true);
    try {
      await downloadReceipt(data);
    } catch {
      toast.error('The receipt could not be made', { description: 'Try again in a moment.' });
    } finally {
      setDownloading(false);
    }
  };
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
          <>
            <Button asChild size="sm" variant="outline">
              <Link href={`/invoices/${data.invoice.id}`}>
                <ReceiptTextIcon />
                Open the invoice
              </Link>
            </Button>
            <Button disabled={downloading} onClick={() => void receipt()} size="sm" variant="outline">
              <DownloadIcon />
              {downloading ? 'Making the receipt…' : 'Download receipt'}
            </Button>
            {changeable ? (
              <>
                <Button onClick={() => setChanging(true)} size="sm" variant="outline">
                  <PencilIcon />
                  Change
                </Button>
                <Button
                  className="text-destructive hover:text-destructive"
                  onClick={() => setRemoving(true)}
                  size="sm"
                  variant="outline"
                >
                  <Trash2Icon />
                  Remove
                </Button>
              </>
            ) : null}
          </>
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
        panelLabel="Applied to"
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

        {/* Why somebody who records payments cannot change this one. */}
        {mayRecord && !changeable ? (
          <p className="text-muted-foreground mt-6 text-sm" role="note">
            {!data.writesEnabled
              ? 'Payments are changed in Jobber until the console takes over invoicing.'
              : locked}
          </p>
        ) : null}
      </RecordLayout>

      {changeable ? (
        <>
          <ChangePaymentDialog onClose={() => setChanging(false)} open={changing} payment={data} />
          <RemovePaymentDialog
            onClose={() => setRemoving(false)}
            onRemoved={() => {
              setRemoving(false);
              router.push(`/invoices/${data.invoice.id}`);
            }}
            open={removing}
            payment={data}
          />
        </>
      ) : null}
    </>
  );
}

/** Jobber's payment type as words: "ACH_BANK_PAYMENT" is "ACH bank payment". */
function jobberTypeLabel(type: string) {
  const words = type.toLowerCase().split('_').join(' ');
  return (words.charAt(0).toUpperCase() + words.slice(1)).replace(/\bach\b/i, 'ACH');
}
