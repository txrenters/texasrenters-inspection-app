'use client';

import {
  INVOICE_STATUS_LABEL,
  PAYMENT_METHOD_LABEL,
  formatMoney,
  formatMoneyShort,
  type InvoiceBucket,
  type InvoiceFileView,
  type InvoiceLineItem,
  type InvoiceNoteView,
  type InvoicePayment,
  type InvoiceStatus,
  type InvoiceSummary,
} from '@texasrenters/shared';
import { ArrowDownIcon, ArrowUpIcon, BanknoteIcon, ChevronRightIcon, FileIcon, PinIcon, PlusIcon, ReceiptTextIcon, Trash2Icon } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import { AsideCard } from '@/components/record/record-kit';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { usePermissions } from '@/lib/auth';
import { BUSINESS_TIME_ZONE } from '@/lib/clock';
import { openInvoiceFile } from '@/lib/invoice-files';
import { useInvoices } from '@/lib/invoice-queries';
import { cn } from '@/lib/utils';

/** "Oct 30, 2026": an invoice's day, which is a date and never a moment. */
const DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
export const formatInvoiceDay = (day: string | null | undefined) =>
  day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? DAY.format(new Date(`${day}T12:00:00.000Z`)) : '—';

/** "Oct 30, 2026, 3:05 PM": a moment, in Texas time as the whole console shows it. */
const MOMENT = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: BUSINESS_TIME_ZONE,
});
export const formatInvoiceMoment = (value: string | null | undefined) => {
  const at = value ? new Date(value) : null;
  return at && !Number.isNaN(at.getTime()) ? MOMENT.format(at) : '—';
};

/** "2.4 MB", "640 KB". */
export function formatFileSize(bytes: number) {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${bytes} B`;
}

/** "10%", "8.25%". */
const percent = (value: number) => `${Number(value.toFixed(3))}%`;

const STATUS_TONE: Record<InvoiceStatus, 'default' | 'destructive' | 'success' | 'warning' | 'info'> = {
  DRAFT: 'default',
  AWAITING_PAYMENT: 'info',
  PAST_DUE: 'destructive',
  PAID: 'success',
  BAD_DEBT: 'warning',
  VOIDED: 'default',
};

export function InvoiceStatusBadge({ status }: { status: InvoiceStatus }) {
  return <Badge variant={STATUS_TONE[status]}>{INVOICE_STATUS_LABEL[status]}</Badge>;
}

/** The invoice's record icon and its tone, for the record header. */
export const INVOICE_RECORD = { icon: ReceiptTextIcon, tone: 'text-primary', label: 'Invoice' };
export const PAYMENT_RECORD = { icon: BanknoteIcon, tone: 'text-success', label: 'Payment' };

/**
 * Jobber's strip above its invoice list: an Overview of what is owed and what
 * is not sent yet, each with how many and how much, then what was issued in
 * the past 30 days against the 30 before.
 */
export function InvoicesOverview({
  overview,
  issued,
}: {
  overview: { pastDue: InvoiceBucket; notYetDue: InvoiceBucket; draft: InvoiceBucket };
  issued: { last30: InvoiceBucket; previous30: InvoiceBucket };
}) {
  const average = issued.last30.count ? Math.round(issued.last30.amountCents / issued.last30.count) : null;
  const previousAverage = issued.previous30.count
    ? Math.round(issued.previous30.amountCents / issued.previous30.count)
    : null;
  return (
    <section aria-label="Invoices at a glance" className="-mx-1 mb-6 overflow-x-auto px-1 pb-1">
      <div className="flex gap-3">
        <div className="bg-card flex min-w-64 flex-1 flex-col gap-2 rounded-lg border p-4">
          <h2 className="text-heading text-base font-bold">Overview</h2>
          <ul className="flex flex-col gap-1.5 text-sm">
            <OverviewLine bucket={overview.pastDue} dot="bg-destructive" href="/invoices?filter=past_due" label="Past due" />
            <OverviewLine bucket={overview.notYetDue} dot="bg-info" href="/invoices?filter=not_yet_due" label="Sent but not due" />
            <OverviewLine bucket={overview.draft} dot="bg-muted-foreground" href="/invoices?filter=draft" label="Draft" />
          </ul>
        </div>
        <Metric
          caption="Past 30 days"
          change={trend(issued.last30.count, issued.previous30.count)}
          detail={formatMoneyShort(issued.last30.amountCents)}
          title="Issued"
          value={issued.last30.count.toLocaleString('en-US')}
        />
        <Metric
          caption="Past 30 days"
          change={average !== null && previousAverage !== null ? trend(average, previousAverage) : null}
          title="Average invoice"
          value={average === null ? '—' : formatMoneyShort(average)}
        />
      </div>
    </section>
  );
}

function OverviewLine({ label, bucket, dot, href }: { label: string; bucket: InvoiceBucket; dot: string; href: string }) {
  return (
    <li>
      <Link className="flex items-center gap-2 hover:underline" href={href}>
        <span aria-hidden className={cn('size-2 shrink-0 rounded-full', dot)} />
        <span className="min-w-0 truncate">
          {label} <span className="text-muted-foreground">({bucket.count.toLocaleString('en-US')})</span>
        </span>
        <span className="text-heading ml-auto font-semibold tabular-nums">{formatMoneyShort(bucket.amountCents)}</span>
      </Link>
    </li>
  );
}

/** A change on the 30 days before, in whole percent; null when there is nothing to compare with. */
function trend(now: number, before: number): number | null {
  if (!before) return null;
  return Math.round(((now - before) / before) * 100);
}

function Metric({
  title,
  caption,
  value,
  detail,
  change,
}: {
  title: string;
  caption: string;
  value: string;
  detail?: string;
  change: number | null;
}) {
  return (
    <div className="bg-card flex min-w-48 flex-1 flex-col rounded-lg border p-4">
      <h3 className="text-heading text-base font-bold">{title}</h3>
      <p className="text-muted-foreground text-xs">{caption}</p>
      <div className="mt-auto flex items-end gap-2 pt-4">
        <span className="font-display text-heading text-3xl leading-none font-extrabold tabular-nums">{value}</span>
        {change !== null && change !== 0 ? (
          <span
            className={cn(
              'inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-xs font-semibold',
              change > 0 ? 'bg-success/10 text-success' : 'bg-destructive/10 text-destructive',
            )}
          >
            {change > 0 ? <ArrowUpIcon aria-hidden className="size-3" /> : <ArrowDownIcon aria-hidden className="size-3" />}
            {Math.abs(change)}%<span className="sr-only"> on the 30 days before</span>
          </span>
        ) : null}
      </div>
      {detail ? <p className="text-muted-foreground mt-1 text-sm tabular-nums">{detail}</p> : null}
    </div>
  );
}

/** What the invoice adds to or takes off its subtotal, as Jobber's totals show it. */
export interface InvoiceAdjustments {
  discountCents?: number;
  /** The percent, when the discount was set as one. */
  discountPercent?: number | null;
  taxCents?: number;
  taxRateName?: string | null;
  taxRatePercent?: number | null;
  taxInclusive?: boolean | null;
  depositCents?: number;
  tipsCents?: number;
}

/**
 * Jobber's Product / Service table: each line, with the day it was done when
 * it names one, then the subtotal, any discount and tax, the total, and a
 * deposit or tips when there are any.
 */
export function LineItemsTable({
  lineItems,
  subtotalCents,
  totalCents,
  adjustments = {},
}: {
  lineItems: readonly InvoiceLineItem[];
  subtotalCents: number;
  totalCents: number;
  adjustments?: InvoiceAdjustments;
}) {
  const { discountCents = 0, discountPercent, taxCents = 0, taxRateName, taxRatePercent, taxInclusive, depositCents = 0, tipsCents = 0 } =
    adjustments;
  const taxLabel = [
    taxRateName || 'Tax',
    taxRatePercent !== null && taxRatePercent !== undefined ? `(${percent(taxRatePercent)})` : null,
    taxInclusive ? 'included' : null,
  ]
    .filter(Boolean)
    .join(' ');
  const footerRow = (label: string, value: string, strong = false) => (
    <TableRow className="hover:bg-transparent" key={label}>
      <TableCell className={cn('px-4 text-right', strong && 'text-heading text-base font-bold')} colSpan={3}>
        {label}
      </TableCell>
      <TableCell className={cn('px-4 text-right tabular-nums', strong && 'text-heading text-base font-bold')}>{value}</TableCell>
    </TableRow>
  );
  return (
    <Table aria-label="Products and services">
      <TableHeader className="lg:static">
        <TableRow className="hover:bg-transparent">
          <TableHead className="px-4">Line item</TableHead>
          <TableHead className="px-4 text-right">Quantity</TableHead>
          <TableHead className="px-4 text-right">Unit price</TableHead>
          <TableHead className="px-4 text-right">Total</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {lineItems.map((line, index) => (
          <TableRow className="hover:bg-transparent" key={`${index}:${line.name}`}>
            <TableCell className="px-4">
              <span className="text-heading font-semibold">{line.name}</span>
              {line.description ? <span className="text-muted-foreground block text-xs whitespace-pre-line">{line.description}</span> : null}
              {line.serviceOn || line.taxable === false ? (
                <span className="text-muted-foreground block text-xs">
                  {[line.serviceOn ? `Done ${formatInvoiceDay(line.serviceOn)}` : null, line.taxable === false ? 'Not taxed' : null]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              ) : null}
            </TableCell>
            <TableCell className="px-4 text-right tabular-nums">{line.quantity}</TableCell>
            <TableCell className="px-4 text-right tabular-nums">{formatMoney(line.unitPriceCents)}</TableCell>
            <TableCell className="px-4 text-right font-semibold tabular-nums">{formatMoney(line.totalCents)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
      <TableFooter className="bg-transparent">
        {footerRow('Subtotal', formatMoney(subtotalCents))}
        {discountCents
          ? footerRow(
              discountPercent !== null && discountPercent !== undefined ? `Discount (${percent(discountPercent)})` : 'Discount',
              `-${formatMoney(discountCents)}`,
            )
          : null}
        {taxCents || taxRateName ? footerRow(taxLabel, formatMoney(taxCents)) : null}
        {footerRow('Total', formatMoney(totalCents), true)}
        {depositCents ? footerRow('Deposit', formatMoney(depositCents)) : null}
        {tipsCents ? footerRow('Tips', formatMoney(tipsCents)) : null}
      </TableFooter>
    </Table>
  );
}

/** The payments recorded against an invoice, each taking its amount off the balance, each opening its own page. */
export function InvoicePayments({ payments }: { payments: readonly InvoicePayment[] }) {
  if (!payments.length) return <p className="text-muted-foreground text-sm">No payment recorded yet.</p>;
  return (
    <ul aria-label="Payments" className="divide-y">
      {payments.map((payment) => (
        <li key={payment.id}>
          <Link
            aria-label={`Payment of ${formatMoney(payment.amountCents)} on ${formatInvoiceDay(payment.paidOn)}`}
            className="hover:bg-muted/50 -mx-2 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 rounded-md px-2 py-2.5 text-sm"
            href={`/payments/${payment.id}`}
          >
            <span className="text-heading font-semibold">{formatInvoiceDay(payment.paidOn)}</span>
            <span className="text-muted-foreground">
              {PAYMENT_METHOD_LABEL[payment.method]}
              {payment.reference ? ` · ${payment.reference}` : ''}
              {payment.recordedBy ? ` · recorded by ${payment.recordedBy.displayName}` : ' · recorded in Jobber'}
            </span>
            <span className="text-heading ml-auto inline-flex items-center gap-1 font-semibold tabular-nums">
              -{formatMoney(payment.amountCents)}
              <ChevronRightIcon aria-hidden className="text-muted-foreground size-4" />
            </span>
            {payment.note ? <span className="text-muted-foreground basis-full text-xs">{payment.note}</span> : null}
          </Link>
        </li>
      ))}
    </ul>
  );
}

const NOTE_PLACE: Record<InvoiceNoteView['kind'], string | null> = {
  INVOICE: null,
  JOB: 'On the job',
  CLIENT: 'On the client',
  QUOTE: 'On the quote',
  REQUEST: 'On the request',
};

/** The invoice's internal notes, and the job's Jobber shows beside them: pinned first. */
export function InvoiceNotes({
  notes,
  onRemove,
  removing,
}: {
  notes: readonly InvoiceNoteView[];
  /** Takes off a note written in the console (2026-11-10); Jobber's stay. */
  onRemove?: (noteId: string) => void;
  removing?: boolean;
}) {
  if (!notes.length) return <p className="text-muted-foreground text-sm">No notes.</p>;
  return (
    <ul aria-label="Notes" className="divide-y">
      {notes.map((note) => (
        <li className="py-2.5 text-sm" key={note.id}>
          <p className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-xs">
            {note.pinned ? (
              <span className="text-heading inline-flex items-center gap-1 font-semibold">
                <PinIcon aria-hidden className="size-3" />
                Pinned
              </span>
            ) : null}
            <span>{formatInvoiceMoment(note.writtenAt)}</span>
            {note.origin === 'CONSOLE' ? <span>· {note.author ?? 'The console'}</span> : NOTE_PLACE[note.kind] ? <span>· {NOTE_PLACE[note.kind]}</span> : null}
            {onRemove && note.origin === 'CONSOLE' ? (
              <Button
                aria-label="Take the note off"
                className="text-muted-foreground ml-auto size-7"
                disabled={removing}
                onClick={() => onRemove(note.id)}
                size="icon"
                variant="ghost"
              >
                <Trash2Icon />
              </Button>
            ) : null}
          </p>
          <p className="text-foreground mt-1 whitespace-pre-line">{note.message}</p>
        </li>
      ))}
    </ul>
  );
}

/** The invoice's images and attachments: each by name, type and size, opened where it is kept. */
/**
 * The files on an invoice, each opened through a short-lived link: the
 * console's own copy once kept (2026-11-06, phase 7), Jobber's until then --
 * which stops working when the office leaves Jobber, so each says which.
 */
export function InvoiceFiles({
  invoiceId,
  files,
  onRemove,
  removing,
}: {
  invoiceId: string;
  files: readonly InvoiceFileView[];
  /** Takes off a file added in the console (2026-11-10); Jobber's stay. */
  onRemove?: (fileId: string) => void;
  removing?: boolean;
}) {
  const [opening, setOpening] = useState<string | null>(null);
  if (!files.length) return <p className="text-muted-foreground text-sm">No files.</p>;
  const open = async (file: InvoiceFileView) => {
    setOpening(file.id);
    try {
      if ((await openInvoiceFile(invoiceId, file.id)) === 'blocked')
        toast.error('The browser blocked the new tab', { description: 'Allow pop-ups for the console, then open the file again.' });
    } catch (error) {
      toast.error('The file could not be opened', { description: error instanceof Error ? error.message : undefined });
    } finally {
      setOpening(null);
    }
  };
  return (
    <ul aria-label="Files" className="divide-y">
      {files.map((file) => (
        <li className="py-2 text-sm" key={file.id}>
          <button
            className="flex w-full items-center gap-2 text-left hover:underline disabled:opacity-60"
            disabled={opening === file.id}
            onClick={() => void open(file)}
            type="button"
          >
            <FileIcon aria-hidden className="text-muted-foreground size-4 shrink-0" />
            <span className="min-w-0 truncate">{file.fileName}</span>
            <span className="text-muted-foreground ml-auto shrink-0 text-xs tabular-nums">{formatFileSize(file.sizeBytes)}</span>
          </button>
          <p className="text-muted-foreground mt-0.5 flex items-center gap-2 pl-6 text-xs">
            <span>
              {file.origin === 'CONSOLE'
                ? 'Added in the console'
                : file.kept
                  ? 'Kept in the console'
                  : file.copyProblem
                    ? `Not copied from Jobber: ${file.copyProblem}`
                    : 'Not copied from Jobber yet'}
            </span>
            {onRemove && file.origin === 'CONSOLE' ? (
              <Button
                aria-label={`Take ${file.fileName} off`}
                className="text-muted-foreground ml-auto size-7"
                disabled={removing}
                onClick={() => onRemove(file.id)}
                size="icon"
                variant="ghost"
              >
                <Trash2Icon />
              </Button>
            ) : null}
          </p>
        </li>
      ))}
    </ul>
  );
}

/**
 * The invoices of one property or one visit, for its record page: each with
 * its status and what it still owes, and the way to make one for a finished
 * visit. Read only for an account that may see invoices.
 */
export function InvoicesCard({
  propertyId,
  inspectionId,
  createHref,
}: {
  propertyId?: string;
  inspectionId?: string;
  /** Where "New invoice" goes, for a finished visit and an account that may make one. */
  createHref?: string;
}) {
  const { has } = usePermissions();
  const canRead = has('invoices:read');
  const list = useInvoices({ propertyId, inspectionId, pageSize: 5 }, canRead);
  if (!canRead) return null;
  const items: InvoiceSummary[] = list.data?.items ?? [];
  const action =
    createHref && has('invoices:manage') ? (
      <Button asChild size="sm" variant="outline">
        <Link href={createHref}>
          <PlusIcon />
          New invoice
        </Link>
      </Button>
    ) : undefined;

  return (
    <AsideCard action={action} title="Invoices">
      {list.isLoading ? (
        <Skeleton className="h-16" />
      ) : list.isError ? (
        <p className="text-muted-foreground">The invoices could not be read.</p>
      ) : items.length ? (
        <ul className="divide-y">
          {items.map((invoice) => (
            <li className="py-2" key={invoice.id}>
              <Link className="flex flex-wrap items-center gap-x-2 gap-y-1 hover:underline" href={`/invoices/${invoice.id}`}>
                <span className="text-heading font-semibold">{invoice.number ? `#${invoice.number}` : 'Draft'}</span>
                <InvoiceStatusBadge status={invoice.status} />
                <span className="text-muted-foreground ml-auto tabular-nums">
                  {invoice.balanceCents > 0 ? `${formatMoney(invoice.balanceCents)} owed` : formatMoney(invoice.totalCents)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground">{inspectionId ? 'This visit has not been invoiced.' : 'No invoices yet.'}</p>
      )}
    </AsideCard>
  );
}
