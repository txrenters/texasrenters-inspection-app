'use client';

import { acceptsPayment, formatMoney, type InvoiceDetail } from '@texasrenters/shared';
import { BanknoteIcon, DownloadIcon, ExternalLinkIcon, MailIcon } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';

import {
  INVOICE_RECORD,
  InvoicePayments,
  InvoiceStatusBadge,
  LineItemsTable,
  formatInvoiceDay,
  formatInvoiceMoment,
} from '@/components/invoices/invoice-parts';
import { InvoiceEditControls, InvoiceHistorySection } from '@/components/invoices/invoice-edit-controls';
import { InvoiceFilesCard, InvoiceNotesCard } from '@/components/invoices/invoice-records';
import { RecordPaymentDialog } from '@/components/invoices/record-payment-dialog';
import { InvoiceDeliveries, SendInvoiceDialog } from '@/components/invoices/send-invoice-dialog';
import { PageHeader } from '@/components/page-header';
import { AsideCard, FactTable, PlaceCard, RecordLayout, type Fact } from '@/components/record/record-kit';
import { ErrorState, PageSkeleton } from '@/components/states';
import { Button } from '@/components/ui/button';
import { usePermissions } from '@/lib/auth';
import { useInvoice } from '@/lib/invoice-queries';
import { downloadInvoice } from '@/lib/invoice-pdf/download-invoice';

/**
 * One invoice, as Jobber's invoice page lays it out: its status and the one
 * thing to do next -- record a payment -- at the top; the property, the
 * client's contacts and the billing address beside the invoice's details; its
 * products and services with the discount, tax and total; the payments
 * recorded against it, each opening its own page, and what it still owes; then
 * the client message, the contract text, the internal notes and the files
 * (2026-11-05: "make sure we get everything, every details").
 */
export default function InvoicePage() {
  const { invoiceId } = useParams<{ invoiceId: string }>();
  const invoice = useInvoice(invoiceId);
  const { has } = usePermissions();
  const [paying, setPaying] = useState(false);
  const [sending, setSending] = useState(false);
  const [downloading, setDownloading] = useState(false);

  if (invoice.isLoading) return <PageSkeleton />;
  if (invoice.isError || !invoice.data)
    return <ErrorState error={invoice.error} retry={() => void invoice.refetch()} />;

  const data = invoice.data;
  const details = data.details;
  const payable = acceptsPayment(data) && has('payments:record');
  const visitHref = data.inspectionId ? `/inspections/${data.inspectionId}` : null;
  // Edited here once the console owns invoicing (2026-11-06); in Jobber until then.
  const editable = has('invoices:manage') && data.writesEnabled === true;
  // Emailed from here once the console owns invoicing; a voided invoice is not sent.
  const sendable = editable && data.status !== 'VOIDED';
  const download = async () => {
    setDownloading(true);
    try {
      await downloadInvoice(data);
    } catch {
      toast.error('The PDF could not be made', { description: 'Try again in a moment.' });
    } finally {
      setDownloading(false);
    }
  };

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
            <Button disabled={downloading} onClick={() => void download()} size="sm" variant="outline">
              <DownloadIcon />
              {downloading ? 'Making the PDF…' : 'Download PDF'}
            </Button>
            {editable ? <InvoiceEditControls invoice={data} /> : null}
            {sendable ? (
              <Button onClick={() => setSending(true)} size="sm" variant="outline">
                <MailIcon />
                Send
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
            {data.deliveries?.length ? (
              <AsideCard title="Emailed to the client">
                <InvoiceDeliveries deliveries={data.deliveries} />
              </AsideCard>
            ) : null}
            {/* Jobber's notes and files, and the office's own (2026-11-10). */}
            <InvoiceNotesCard invoice={data} mayWrite={has('invoices:manage')} />
            <InvoiceFilesCard invoice={data} mayWrite={has('invoices:manage')} />
          </>
        }
        asideLabel="About this invoice"
      >
        <div className="grid gap-4 lg:grid-cols-2">
          <PlaceCard
            address={placeAddress(data)}
            href={data.property ? `/properties/${data.property.id}` : undefined}
            lines={contactLines(data)}
            name={data.clientName}
          />
          <FactTable facts={invoiceFacts(data, visitHref)} label="Invoice details" />
        </div>

        <section aria-label="Products and services" className="bg-card mt-6 overflow-hidden rounded-lg border">
          <h2 className="text-heading px-4 pt-4 text-lg font-bold">Product / Service</h2>
          <LineItemsTable
            adjustments={{
              discountCents: details?.discountCents,
              discountPercent: details?.discountPercent,
              taxCents: data.taxCents,
              taxRateName: details?.taxRateName,
              taxRatePercent: details?.taxRatePercent,
              taxInclusive: details?.taxInclusive,
              depositCents: details?.depositCents,
              tipsCents: details?.tipsCents,
            }}
            lineItems={data.lineItems}
            subtotalCents={data.subtotalCents}
            totalCents={data.totalCents}
          />
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

        {data.clientMessage || details?.contractDisclaimer ? (
          <section aria-label="What the client reads" className="bg-card mt-6 grid gap-4 rounded-lg border p-4 md:grid-cols-2">
            {data.clientMessage ? (
              <div>
                <h2 className="text-heading text-base font-bold">Client message</h2>
                <p className="text-muted-foreground mt-2 text-sm whitespace-pre-line">{data.clientMessage}</p>
              </div>
            ) : null}
            {details?.contractDisclaimer ? (
              <div>
                <h2 className="text-heading text-base font-bold">Contract / disclaimer</h2>
                <p className="text-muted-foreground mt-2 text-sm whitespace-pre-line">{details.contractDisclaimer}</p>
              </div>
            ) : null}
          </section>
        ) : null}

        <InvoiceHistorySection invoiceId={data.id} />
      </RecordLayout>

      {payable ? <RecordPaymentDialog invoice={data} onClose={() => setPaying(false)} open={paying} /> : null}
      {sendable ? <SendInvoiceDialog invoice={data} onClose={() => setSending(false)} open={sending} /> : null}
    </>
  );
}

/** The property's address as the console knows it, else Jobber's address for the invoice's property. */
function placeAddress(data: InvoiceDetail) {
  if (data.property) return [data.property.address, data.property.city].filter(Boolean).join(', ');
  return data.details?.propertyAddress ?? null;
}

/** Under the property: the billing name and address unless they are the property's, then how to reach the client. */
function contactLines(data: InvoiceDetail) {
  const details = data.details;
  const lines: { label: string; value: ReactNode }[] = [];
  const billing = [details?.billingName, data.billingAddress].filter(Boolean).join(' · ');
  if (billing && details?.billingSameAsProperty !== true) lines.push({ label: 'Billing address', value: billing });
  if (details?.clientEmails.length)
    lines.push({
      label: details.clientEmails.length > 1 ? 'Emails' : 'Email',
      value: (
        <ul>
          {details.clientEmails.map((email) => (
            <li className="break-all" key={email}>
              <a className="hover:underline" href={`mailto:${email}`}>
                {email}
              </a>
            </li>
          ))}
        </ul>
      ),
    });
  if (details?.clientPhones.length)
    lines.push({
      label: details.clientPhones.length > 1 ? 'Phones' : 'Phone',
      value: (
        <ul>
          {details.clientPhones.map((phone) => (
            <li key={phone}>
              <a className="hover:underline" href={`tel:${phone.replace(/[^\d+]/g, '')}`}>
                {phone}
              </a>
            </li>
          ))}
        </ul>
      ),
    });
  return lines;
}

/** Jobber's details table, with every other detail it keeps where there is one. */
function invoiceFacts(data: InvoiceDetail, visitHref: string | null): Fact[] {
  const details = data.details;
  const job = data.jobNumber ? `Job #${data.jobNumber}` : null;
  const facts: Fact[] = [
    { label: 'Invoice #', value: data.number ?? 'Not numbered yet' },
    {
      label: 'Invoice for',
      value: visitHref ? (
        <Link className="underline underline-offset-2" href={visitHref}>
          {job ?? 'The visit'}
        </Link>
      ) : (
        (job ?? '—')
      ),
      detail: details?.jobTitle ?? undefined,
    },
    { label: 'Issued', value: formatInvoiceDay(data.issuedOn) },
    { label: 'Payment terms', value: data.paymentTerms ?? '—' },
    { label: 'Due date', value: formatInvoiceDay(data.dueOn) },
  ];
  if (details?.paidOn) facts.push({ label: 'Paid in full', value: formatInvoiceDay(details.paidOn) });
  if (details?.viewedAt) facts.push({ label: 'Viewed by the client', value: formatInvoiceMoment(details.viewedAt) });
  if (details?.salespersonName) facts.push({ label: 'Salesperson', value: details.salespersonName });
  for (const field of details?.customFields ?? []) facts.push({ label: field.label, value: field.value });
  return facts;
}
