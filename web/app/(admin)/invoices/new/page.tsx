'use client';

import {
  PAYMENT_TERMS,
  dueOnFor,
  formatMoney,
  invoiceLinesProblem,
  invoiceTotals,
  lineTotalCents,
  parseMoney,
  type InvoiceDraft,
  type InvoiceLineInput,
} from '@texasrenters/shared';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useId, useState } from 'react';
import { toast } from 'sonner';

import { InvoiceStatusBadge, formatInvoiceDay } from '@/components/invoices/invoice-parts';
import { PageHeader } from '@/components/page-header';
import { EmptyState, ErrorState, PageSkeleton } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { usePermissions } from '@/lib/auth';
import { newClientRequestId, useInvoiceActions, useInvoiceDraft } from '@/lib/invoice-queries';

/**
 * The invoice for a finished visit (the office, 2026-11-05): a line for each
 * service done, at the price in Jobber's products list, made out to the
 * property -- and every bit of it the office's to change before it goes to
 * Jobber. Nothing is invoiced on its own.
 */
export default function NewInvoicePage() {
  const inspectionId = useSearchParams().get('inspection') ?? '';
  const { has } = usePermissions();
  const draft = useInvoiceDraft(has('invoices:manage') ? inspectionId : '');

  if (!has('invoices:manage'))
    return <EmptyState description="Creating invoices is a permission of its own. Ask an administrator." title="You may not create invoices" />;
  if (!inspectionId)
    return <EmptyState description="Open a finished visit and choose New invoice there." title="Which visit?" />;
  if (draft.isLoading) return <PageSkeleton />;
  if (draft.isError || !draft.data) return <ErrorState error={draft.error} retry={() => void draft.refetch()} />;
  return <InvoiceEditor draft={draft.data} />;
}

/** A line as it is being typed: the price is text until it is saved. */
interface EditLine {
  key: string;
  name: string;
  description: string;
  quantity: string;
  price: string;
}

const toEdit = (line: InvoiceLineInput, index: number): EditLine => ({
  key: `line-${index}`,
  name: line.name,
  description: line.description ?? '',
  quantity: String(line.quantity),
  price: (line.unitPriceCents / 100).toFixed(2),
});

function toInput(line: EditLine): InvoiceLineInput | null {
  const quantity = Number(line.quantity);
  const unitPriceCents = parseMoney(line.price);
  if (!Number.isFinite(quantity) || unitPriceCents === null) return null;
  return { name: line.name.trim(), description: line.description.trim() || null, quantity, unitPriceCents };
}

function InvoiceEditor({ draft }: { draft: InvoiceDraft }) {
  const id = useId();
  const router = useRouter();
  const actions = useInvoiceActions();
  const [subject, setSubject] = useState(draft.subject);
  const [issuedOn, setIssuedOn] = useState(draft.issuedOn);
  const [terms, setTerms] = useState(String(draft.paymentTermsDays));
  const [message, setMessage] = useState(draft.clientMessage);
  const [lines, setLines] = useState<EditLine[]>(() => draft.lineItems.map(toEdit));
  const [nextKey, setNextKey] = useState(draft.lineItems.length);
  // One key for this form: a double click or a resend makes one invoice.
  const [requestId] = useState(newClientRequestId);

  const inputs = lines.map(toInput);
  const typo = inputs.findIndex((line) => line === null);
  const ready = inputs.filter((line): line is InvoiceLineInput => line !== null);
  const problem =
    typo >= 0
      ? `${lines[typo]!.name || 'A line'}: give the quantity as a number and the price in dollars and cents.`
      : !subject.trim()
        ? 'Give the invoice a subject.'
        : invoiceLinesProblem(ready);
  const { subtotalCents, totalCents } = invoiceTotals(ready);

  const update = (key: string, patch: Partial<EditLine>) =>
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  const add = (product?: { name: string; unitPriceCents: number }) => {
    setLines((current) => [
      ...current,
      {
        key: `line-${nextKey}`,
        name: product?.name ?? '',
        description: '',
        quantity: '1',
        price: product ? (product.unitPriceCents / 100).toFixed(2) : '',
      },
    ]);
    setNextKey((key) => key + 1);
  };

  const create = () => {
    if (problem) return;
    actions.create.mutate(
      {
        inspectionId: draft.inspection.id,
        subject: subject.trim(),
        issuedOn,
        paymentTermsDays: Number(terms),
        lineItems: ready,
        ...(message.trim() ? { clientMessage: message.trim() } : {}),
        clientRequestId: requestId,
      },
      {
        onSuccess: (invoice) => {
          toast.success(`Invoice ${invoice.number ? `#${invoice.number}` : ''} created`, {
            description: `${formatMoney(invoice.totalCents)} to ${invoice.clientName}, in Jobber too.`,
          });
          router.push(`/invoices/${invoice.id}`);
        },
        onError: (error) => toast.error('The invoice was not created', { description: error.message }),
      },
    );
  };

  return (
    <>
      <PageHeader
        description={
          <span>
            For the visit on {formatInvoiceDay(draft.inspection.scheduledOn)} at{' '}
            <Link className="underline underline-offset-2" href={`/inspections/${draft.inspection.id}`}>
              {draft.property?.address ?? draft.clientName}
            </Link>
            . Check every line before it goes to Jobber.
          </span>
        }
        title="New invoice"
      />

      {draft.existing ? (
        <div className="border-warning/30 bg-warning/10 mb-4 flex flex-wrap items-center gap-2 rounded-lg border p-3 text-sm" role="status">
          This visit already has an invoice:
          <Link className="font-semibold underline underline-offset-2" href={`/invoices/${draft.existing.id}`}>
            {draft.existing.number ? `#${draft.existing.number}` : 'a draft'}
          </Link>
          <InvoiceStatusBadge status={draft.existing.status} />
          Make a second one only if it bills something the first does not.
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Field>
          <FieldLabel htmlFor={`${id}-subject`}>Subject</FieldLabel>
          <Input id={`${id}-subject`} maxLength={120} onChange={(event) => setSubject(event.target.value)} value={subject} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field>
            <FieldLabel htmlFor={`${id}-issued`}>Issued</FieldLabel>
            <Input id={`${id}-issued`} onChange={(event) => setIssuedOn(event.target.value)} type="date" value={issuedOn} />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-terms`}>Payment terms</FieldLabel>
            <Select onValueChange={setTerms} value={terms}>
              <SelectTrigger className="w-full" id={`${id}-terms`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAYMENT_TERMS.map((term) => (
                  <SelectItem key={term.days} value={String(term.days)}>
                    {term.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>Due {issuedOn ? formatInvoiceDay(dueOnFor(issuedOn, Number(terms))) : '—'}</FieldDescription>
          </Field>
        </div>
      </div>

      <section aria-label="Products and services" className="bg-card mt-6 rounded-lg border">
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-4">
          <h2 className="text-heading text-lg font-bold">Product / Service</h2>
          <div className="flex flex-wrap gap-2">
            {draft.products.length ? (
              <Select onValueChange={(name) => add(draft.products.find((product) => product.name === name))} value="">
                <SelectTrigger aria-label="Add a product" className="h-8 w-auto gap-2">
                  <SelectValue placeholder="Add a product" />
                </SelectTrigger>
                <SelectContent>
                  {draft.products.map((product) => (
                    <SelectItem key={product.name} value={product.name}>
                      {product.name} · {formatMoney(product.unitPriceCents)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            <Button onClick={() => add()} size="sm" variant="outline">
              <PlusIcon />
              Add a line
            </Button>
          </div>
        </div>
        <ul className="divide-y">
          {lines.map((line, index) => {
            const input = inputs[index];
            return (
              <li className="grid gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_5rem_7rem_6.5rem_2rem] sm:items-start" key={line.key}>
                <div className="grid gap-1.5">
                  <Input
                    aria-label={`Line ${index + 1}: name`}
                    maxLength={120}
                    onChange={(event) => update(line.key, { name: event.target.value })}
                    placeholder="Product or service"
                    value={line.name}
                  />
                  <Input
                    aria-label={`Line ${index + 1}: description`}
                    className="h-8 text-xs"
                    maxLength={300}
                    onChange={(event) => update(line.key, { description: event.target.value })}
                    placeholder="Description (optional)"
                    value={line.description}
                  />
                </div>
                <Input
                  aria-label={`Line ${index + 1}: quantity`}
                  className="tabular-nums"
                  inputMode="decimal"
                  onChange={(event) => update(line.key, { quantity: event.target.value })}
                  value={line.quantity}
                />
                <Input
                  aria-label={`Line ${index + 1}: unit price`}
                  className="tabular-nums"
                  inputMode="decimal"
                  onChange={(event) => update(line.key, { price: event.target.value })}
                  placeholder="0.00"
                  value={line.price}
                />
                <span className="text-heading self-center text-right font-semibold tabular-nums">
                  {input ? formatMoney(lineTotalCents(input)) : '—'}
                </span>
                <Button
                  aria-label={`Remove line ${index + 1}`}
                  onClick={() => setLines((current) => current.filter((entry) => entry.key !== line.key))}
                  size="icon-sm"
                  variant="ghost"
                >
                  <Trash2Icon />
                </Button>
              </li>
            );
          })}
        </ul>
        <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-1 border-t px-4 py-3 text-sm sm:ml-auto sm:w-72">
          <dt className="text-muted-foreground">Subtotal</dt>
          <dd className="text-right tabular-nums">{formatMoney(subtotalCents)}</dd>
          <dt className="text-heading text-base font-bold">Total</dt>
          <dd className="text-heading text-right text-base font-bold tabular-nums">{formatMoney(totalCents)}</dd>
        </dl>
      </section>

      <Field className="mt-6">
        <FieldLabel htmlFor={`${id}-message`}>Client message</FieldLabel>
        <Textarea
          className="min-h-20"
          id={`${id}-message`}
          maxLength={1000}
          onChange={(event) => setMessage(event.target.value)}
          value={message}
        />
      </Field>

      <div className="mt-6 flex flex-wrap items-center justify-end gap-3">
        <p aria-live="polite" className={problem ? 'text-destructive mr-auto text-sm' : 'text-muted-foreground mr-auto text-sm'}>
          {problem ?? `Made out to ${draft.clientName}. It goes to Jobber as it is here.`}
        </p>
        <Button asChild variant="secondary">
          <Link href={`/inspections/${draft.inspection.id}`}>Cancel</Link>
        </Button>
        <Button disabled={Boolean(problem) || actions.create.isPending} onClick={create}>
          {actions.create.isPending ? 'Creating…' : `Create invoice · ${formatMoney(totalCents)}`}
        </Button>
      </div>
    </>
  );
}
