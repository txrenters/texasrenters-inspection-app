'use client';

import {
  INVOICE_STATUS_LABEL,
  PAYMENT_TERMS,
  dueOnFor,
  formatMoney,
  invoiceAmounts,
  invoiceEditProblem,
  isEditableInvoiceStatus,
  parseMoney,
  type InvoiceDetail,
  type InvoiceDiscountInput,
  type InvoiceTaxInput,
} from '@texasrenters/shared';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { toast } from 'sonner';

import { INVOICE_RECORD } from '@/components/invoices/invoice-parts';
import { LineItemsEditor, readLines, toEditLine, type EditLine } from '@/components/invoices/line-items-editor';
import { PageHeader } from '@/components/page-header';
import { EmptyState, ErrorState, PageSkeleton } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { usePermissions } from '@/lib/auth';
import { useInvoiceEdits } from '@/lib/invoice-edit-queries';
import { useInvoice } from '@/lib/invoice-queries';

/**
 * Editing an invoice (2026-11-06, phase 3 of taking invoicing over from
 * Jobber), as Jobber's invoice opens for editing: the subject, number, issue
 * day and terms; every line, with the day the work was done and whether it is
 * taxed; a discount and a tax; the client message and the contract text. The
 * totals are worked out as it is typed, and again on the server, never below
 * what has been paid. Saved against the invoice as it was opened, so an
 * invoice somebody else changed meanwhile is refused rather than overwritten.
 */
export default function EditInvoicePage() {
  const { invoiceId } = useParams<{ invoiceId: string }>();
  const invoice = useInvoice(invoiceId);
  const { has } = usePermissions();

  if (!has('invoices:manage'))
    return <EmptyState description="Editing invoices is a permission of its own. Ask an administrator." title="You may not edit invoices" />;
  if (invoice.isLoading) return <PageSkeleton />;
  if (invoice.isError || !invoice.data) return <ErrorState error={invoice.error} retry={() => void invoice.refetch()} />;

  const data = invoice.data;
  const back = (
    <Button asChild variant="outline">
      <Link href={`/invoices/${data.id}`}>Back to the invoice</Link>
    </Button>
  );
  if (!data.writesEnabled)
    return (
      <EmptyState description="Invoices are edited in Jobber until the console takes over invoicing." title="Edited in Jobber for now">
        {back}
      </EmptyState>
    );
  if (!isEditableInvoiceStatus(data.status))
    return (
      <EmptyState
        description={`A ${INVOICE_STATUS_LABEL[data.status].toLowerCase()} invoice is reopened before it is edited.`}
        title="Reopen it first"
      >
        {back}
      </EmptyState>
    );
  // Keyed by the version, so an invoice changed elsewhere opens fresh.
  return <InvoiceEditForm invoice={data} key={data.updatedAt} />;
}

const CUSTOM = 'custom';
const DAY_MS = 86_400_000;
const termsFor = (issuedOn: string | null, dueOn: string | null) => {
  if (!issuedOn || !dueOn) return '30';
  const days = Math.round((Date.parse(dueOn) - Date.parse(issuedOn)) / DAY_MS);
  return PAYMENT_TERMS.some((terms) => terms.days === days) ? String(days) : CUSTOM;
};

function InvoiceEditForm({ invoice }: { invoice: InvoiceDetail }) {
  const id = useId();
  const router = useRouter();
  const edits = useInvoiceEdits();
  const details = invoice.details;
  const [subject, setSubject] = useState(invoice.subject);
  const [number, setNumber] = useState(invoice.number ?? '');
  const [issuedOn, setIssuedOn] = useState(invoice.issuedOn ?? '');
  const [terms, setTerms] = useState(termsFor(invoice.issuedOn, invoice.dueOn));
  const [customDue, setCustomDue] = useState(invoice.dueOn ?? '');
  const [lines, setLines] = useState<EditLine[]>(() => invoice.lineItems.map(toEditLine));
  const [discountKind, setDiscountKind] = useState<'none' | 'PERCENT' | 'AMOUNT'>(
    !details?.discountCents ? 'none' : details.discountPercent !== null ? 'PERCENT' : 'AMOUNT',
  );
  const [discountValue, setDiscountValue] = useState(
    !details?.discountCents
      ? ''
      : details.discountPercent !== null
        ? String(details.discountPercent)
        : (details.discountCents / 100).toFixed(2),
  );
  const [taxed, setTaxed] = useState(Boolean(details?.taxRateName && details.taxRatePercent));
  const [taxName, setTaxName] = useState(details?.taxRateName ?? '');
  const [taxPercent, setTaxPercent] = useState(details?.taxRatePercent ? String(details.taxRatePercent) : '');
  const [message, setMessage] = useState(invoice.clientMessage ?? '');
  const [disclaimer, setDisclaimer] = useState(details?.contractDisclaimer ?? '');

  const dueOn = terms === CUSTOM ? customDue : issuedOn ? dueOnFor(issuedOn, Number(terms)) : '';
  const read = readLines(lines);
  const discount: InvoiceDiscountInput | null =
    discountKind === 'PERCENT'
      ? { kind: 'PERCENT', percent: Number(discountValue) }
      : discountKind === 'AMOUNT'
        ? { kind: 'AMOUNT', amountCents: parseMoney(discountValue) ?? Number.NaN }
        : null;
  const tax: InvoiceTaxInput | null = taxed ? { name: taxName.trim(), percent: Number(taxPercent) } : null;
  const input = {
    subject: subject.trim(),
    number: invoice.number === null && !number.trim() ? null : number.trim(),
    issuedOn,
    dueOn,
    lineItems: read.ready,
    discount,
    tax,
  };
  const paidCents = invoice.paidCents ?? 0;
  const problem = read.problem ?? invoiceEditProblem(input, paidCents);
  const amounts = invoiceAmounts(read.ready, discount, tax);
  const owed = amounts.totalCents - paidCents;

  const save = () => {
    if (problem || !invoice.updatedAt) return;
    edits.edit.mutate(
      {
        id: invoice.id,
        input: {
          ...input,
          clientMessage: message.trim() || null,
          contractDisclaimer: disclaimer.trim() || null,
          expectedUpdatedAt: invoice.updatedAt,
        },
      },
      {
        onSuccess: (saved) => {
          toast.success('Invoice saved', {
            description: `${formatMoney(saved.totalCents)}; ${saved.balanceCents > 0 ? `${formatMoney(saved.balanceCents)} owed` : 'paid'}.`,
          });
          router.push(`/invoices/${saved.id}`);
        },
        onError: (error) => toast.error('The invoice was not saved', { description: error.message }),
      },
    );
  };

  return (
    <>
      <PageHeader record={INVOICE_RECORD} title={invoice.number ? `Edit invoice #${invoice.number}` : 'Edit invoice'} />

      <section aria-label="Invoice details" className="grid gap-4 lg:grid-cols-2">
        <Field>
          <FieldLabel htmlFor={`${id}-subject`}>Subject</FieldLabel>
          <Input id={`${id}-subject`} maxLength={120} onChange={(event) => setSubject(event.target.value)} value={subject} />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-number`}>Invoice #</FieldLabel>
          <Input id={`${id}-number`} maxLength={30} onChange={(event) => setNumber(event.target.value)} value={number} />
        </Field>
        <div className="grid grid-cols-2 gap-3 lg:col-span-2 lg:grid-cols-3">
          <Field>
            <FieldLabel htmlFor={`${id}-issued`}>Issued</FieldLabel>
            <Input id={`${id}-issued`} onChange={(event) => setIssuedOn(event.target.value)} type="date" value={issuedOn} />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-terms`}>Payment terms</FieldLabel>
            <Select
              onValueChange={(next) => {
                if (next === CUSTOM) setCustomDue(dueOn);
                setTerms(next);
              }}
              value={terms}
            >
              <SelectTrigger className="w-full" id={`${id}-terms`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAYMENT_TERMS.map((option) => (
                  <SelectItem key={option.days} value={String(option.days)}>
                    {option.label}
                  </SelectItem>
                ))}
                <SelectItem value={CUSTOM}>Custom due day</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-due`}>Due</FieldLabel>
            <Input
              disabled={terms !== CUSTOM}
              id={`${id}-due`}
              onChange={(event) => setCustomDue(event.target.value)}
              type="date"
              value={dueOn}
            />
          </Field>
        </div>
      </section>

      <section aria-label="Products and services" className="bg-card mt-6 rounded-lg border">
        <LineItemsEditor lines={lines} onChange={setLines} showServiceDay showTaxable={taxed} />

        <div className="grid gap-4 border-t px-4 py-4 md:grid-cols-2">
          <div className="grid gap-3">
            <Field>
              <FieldLabel htmlFor={`${id}-discount`}>Discount</FieldLabel>
              <div className="flex gap-2">
                <Select onValueChange={(next) => setDiscountKind(next as typeof discountKind)} value={discountKind}>
                  <SelectTrigger aria-label="Discount kind" className="w-36">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    <SelectItem value="PERCENT">Percent</SelectItem>
                    <SelectItem value="AMOUNT">Amount</SelectItem>
                  </SelectContent>
                </Select>
                {discountKind !== 'none' ? (
                  <Input
                    className="tabular-nums"
                    id={`${id}-discount`}
                    inputMode="decimal"
                    onChange={(event) => setDiscountValue(event.target.value)}
                    placeholder={discountKind === 'PERCENT' ? '10' : '0.00'}
                    value={discountValue}
                  />
                ) : null}
              </div>
            </Field>
            <div className="grid gap-2">
              <label className="flex items-center gap-2 text-sm font-medium">
                <Checkbox checked={taxed} onCheckedChange={(checked) => setTaxed(checked === true)} />
                Add a tax
              </label>
              {taxed ? (
                <div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-2">
                  <Input aria-label="Tax name" maxLength={60} onChange={(event) => setTaxName(event.target.value)} placeholder="Texas" value={taxName} />
                  <Input
                    aria-label="Tax percent"
                    className="tabular-nums"
                    inputMode="decimal"
                    onChange={(event) => setTaxPercent(event.target.value)}
                    placeholder="8.25"
                    value={taxPercent}
                  />
                </div>
              ) : null}
            </div>
          </div>
          <dl aria-label="Totals" className="grid grid-cols-[1fr_auto] content-start gap-x-6 gap-y-1 text-sm md:ml-auto md:w-72">
            <dt className="text-muted-foreground">Subtotal</dt>
            <dd className="text-right tabular-nums">{formatMoney(amounts.subtotalCents)}</dd>
            {amounts.discountCents ? (
              <>
                <dt className="text-muted-foreground">Discount</dt>
                <dd className="text-right tabular-nums">-{formatMoney(amounts.discountCents)}</dd>
              </>
            ) : null}
            {tax ? (
              <>
                <dt className="text-muted-foreground">{tax.name || 'Tax'}</dt>
                <dd className="text-right tabular-nums">{formatMoney(amounts.taxCents)}</dd>
              </>
            ) : null}
            <dt className="text-heading text-base font-bold">Total</dt>
            <dd className="text-heading text-right text-base font-bold tabular-nums">{formatMoney(amounts.totalCents)}</dd>
            {paidCents ? (
              <>
                <dt className="text-muted-foreground">Paid</dt>
                <dd className="text-right tabular-nums">-{formatMoney(paidCents)}</dd>
                <dt className="text-muted-foreground">Still owed</dt>
                <dd className="text-right tabular-nums">{formatMoney(Math.max(0, owed))}</dd>
              </>
            ) : null}
          </dl>
        </div>
      </section>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <Field>
          <FieldLabel htmlFor={`${id}-message`}>Client message</FieldLabel>
          <Textarea className="min-h-20" id={`${id}-message`} maxLength={2000} onChange={(event) => setMessage(event.target.value)} value={message} />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-disclaimer`}>Contract / disclaimer</FieldLabel>
          <Textarea
            className="min-h-20"
            id={`${id}-disclaimer`}
            maxLength={4000}
            onChange={(event) => setDisclaimer(event.target.value)}
            value={disclaimer}
          />
          <FieldDescription>Printed at the foot of the invoice.</FieldDescription>
        </Field>
      </div>

      <div className="mt-6 flex flex-wrap items-center justify-end gap-3">
        <p aria-live="polite" className={problem ? 'text-destructive mr-auto text-sm' : 'text-muted-foreground mr-auto text-sm'}>
          {problem ?? 'The total is worked out again when it is saved, and the change kept on the invoice’s history.'}
        </p>
        <Button asChild variant="secondary">
          <Link href={`/invoices/${invoice.id}`}>Cancel</Link>
        </Button>
        <Button disabled={Boolean(problem) || edits.edit.isPending} onClick={save}>
          {edits.edit.isPending ? 'Saving…' : `Save · ${formatMoney(amounts.totalCents)}`}
        </Button>
      </div>
    </>
  );
}
