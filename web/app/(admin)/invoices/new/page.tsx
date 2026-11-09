'use client';

import {
  PAYMENT_TERMS,
  dueOnFor,
  formatMoney,
  invoiceLinesProblem,
  invoiceTotals,
  type InvoiceDraft,
  type InvoiceLineInput,
  type InvoiceDetail,
} from '@texasrenters/shared';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useId, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { InvoiceStatusBadge, formatInvoiceDay } from '@/components/invoices/invoice-parts';
import { LineItemsEditor, readLines, toEditLine, type EditLine } from '@/components/invoices/line-items-editor';
import { PageHeader } from '@/components/page-header';
import { SearchableSelect } from '@/components/searchable-select';
import { EmptyState, ErrorState, PageSkeleton } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { usePermissions } from '@/lib/auth';
import { newClientRequestId, useInvoice, useInvoiceActions, useInvoiceDraft } from '@/lib/invoice-queries';
import { propertyOptionLabel } from '@/lib/property-label';
import { usePropertyOptions } from '@/lib/queries';

/**
 * A new invoice (the office, 2026-11-05): for a finished visit, a line for each
 * service done at the office's price for it; or (2026-11-06) for a property no
 * visit covers, found by its address, with the lines typed. Made out to the
 * property, every bit of it the office's to change, kept as a draft or made
 * owed at once and numbered next in the office's sequence.
 */
export default function NewInvoicePage() {
  const search = useSearchParams();
  const inspectionId = search.get('inspection') ?? '';
  // Jobber's "Create similar" (2026-11-10): the invoice it is like.
  const similarId = search.get('similar') ?? '';
  const similar = useInvoice(similarId);
  const [chosenProperty, setPropertyId] = useState(search.get('property') ?? '');
  const propertyId = chosenProperty || similar.data?.property?.id || '';
  const { has } = usePermissions();
  const mayCreate = has('invoices:manage');
  const target = inspectionId ? { inspectionId } : propertyId ? { propertyId } : {};
  const draft = useInvoiceDraft(mayCreate ? target : {});

  if (!mayCreate)
    return <EmptyState description="Creating invoices is a permission of its own. Ask an administrator." title="You may not create invoices" />;
  if (similarId && similar.isLoading) return <PageSkeleton />;
  if (!inspectionId && !propertyId) return <PropertyStep onChoose={setPropertyId} />;
  if (draft.isLoading) return <PageSkeleton />;
  if (draft.isError || !draft.data) return <ErrorState error={draft.error} retry={() => void draft.refetch()} />;
  const start = similar.data && !inspectionId ? likeInvoice(draft.data, similar.data) : draft.data;
  return <InvoiceEditor draft={start} key={`${draft.data.inspection?.id ?? draft.data.property?.id}:${similarId}`} />;
}

/** A draft that starts as another invoice did: its subject, its lines at their prices, and its message. */
function likeInvoice(draft: InvoiceDraft, invoice: InvoiceDetail): InvoiceDraft {
  return {
    ...draft,
    subject: invoice.subject,
    lineItems: invoice.lineItems.map((line) => ({
      name: line.name,
      description: line.description,
      quantity: line.quantity,
      unitPriceCents: line.unitPriceCents,
    })),
    clientMessage: invoice.clientMessage ?? draft.clientMessage,
  };
}

/** The property an invoice no visit covers is made out to, found by its address or name. */
function PropertyStep({ onChoose }: { onChoose: (propertyId: string) => void }) {
  const [query, setQuery] = useState('');
  const properties = usePropertyOptions('', query);
  const options = useMemo(
    () =>
      (properties.data?.pages.flatMap((page) => page.items) ?? []).map((item) => ({
        value: item.id,
        label: propertyOptionLabel(item.name, [item.addressLine1, item.city].filter(Boolean).join(', ')),
      })),
    [properties.data?.pages],
  );
  return (
    <>
      <PageHeader
        description="For work no visit covers. To invoice a finished visit, open it and choose New invoice there, or make many at once."
        title="New invoice"
      />
      <div className="grid max-w-xl gap-4">
        <Field>
          <FieldLabel htmlFor="invoice-property">Property</FieldLabel>
          <SearchableSelect
            emptyMessage="No active property matches your search."
            hasMore={properties.hasNextPage}
            id="invoice-property"
            loadingMore={properties.isFetchingNextPage}
            onChange={(next) => (next ? onChoose(next) : undefined)}
            onLoadMore={() => void properties.fetchNextPage()}
            onSearch={setQuery}
            options={options}
            optionsLabel="Property options"
            placeholder={properties.isLoading ? 'Loading properties…' : 'Search by address or name'}
            searchPlaceholder="Search name, address, or city…"
            value=""
          />
          <FieldDescription>The invoice is made out to the property, as Jobber names the client.</FieldDescription>
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <Link href="/invoices/batch">Invoice finished visits in a batch</Link>
          </Button>
          <Button asChild variant="secondary">
            <Link href="/invoices">Cancel</Link>
          </Button>
        </div>
      </div>
    </>
  );
}

function InvoiceEditor({ draft }: { draft: InvoiceDraft }) {
  const id = useId();
  const router = useRouter();
  const actions = useInvoiceActions();
  const [subject, setSubject] = useState(draft.subject);
  const [issuedOn, setIssuedOn] = useState(draft.issuedOn);
  const [terms, setTerms] = useState(String(draft.paymentTermsDays));
  const [message, setMessage] = useState(draft.clientMessage);
  const [lines, setLines] = useState<EditLine[]>(() => draft.lineItems.map(toEditLine));
  // One key for this form: a double click or a resend makes one invoice.
  const [requestId] = useState(newClientRequestId);
  const visit = draft.inspection;

  const read = readLines(lines);
  // A new invoice's lines are its name, description, quantity and price; the
  // service day and tax are an edit's.
  const ready: InvoiceLineInput[] = read.ready.map(({ name, description, quantity, unitPriceCents }) => ({
    name,
    description,
    quantity,
    unitPriceCents,
  }));
  const problem = read.problem ?? (!subject.trim() ? 'Give the invoice a subject.' : invoiceLinesProblem(ready));
  const { subtotalCents, totalCents } = invoiceTotals(ready);
  const cancelHref = visit ? `/inspections/${visit.id}` : '/invoices';

  const create = (asDraft: boolean) => {
    if (problem) return;
    actions.create.mutate(
      {
        ...(visit ? { inspectionId: visit.id } : { propertyId: draft.property?.id }),
        ...(asDraft ? { asDraft: true } : {}),
        subject: subject.trim(),
        issuedOn,
        paymentTermsDays: Number(terms),
        lineItems: ready,
        ...(message.trim() ? { clientMessage: message.trim() } : {}),
        clientRequestId: requestId,
      },
      {
        onSuccess: (invoice) => {
          toast.success(asDraft ? 'Draft saved' : invoice.number ? `Invoice #${invoice.number} created` : 'Invoice created', {
            description: `${formatMoney(invoice.totalCents)} to ${invoice.clientName}.`,
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
          visit ? (
            <span>
              For the visit on {formatInvoiceDay(visit.scheduledOn)} at{' '}
              <Link className="underline underline-offset-2" href={`/inspections/${visit.id}`}>
                {draft.property?.address ?? draft.clientName}
              </Link>
              . Check every line before it is created.
            </span>
          ) : (
            <span>
              For{' '}
              {draft.property ? (
                <Link className="underline underline-offset-2" href={`/properties/${draft.property.id}`}>
                  {draft.property.address}
                </Link>
              ) : (
                draft.clientName
              )}
              , for work no visit covers. Add a line for each thing it bills.
            </span>
          )
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
        <LineItemsEditor lines={lines} onChange={setLines} products={draft.products} />
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
          {problem ?? `Made out to ${draft.clientName}. A draft is numbered when it is marked sent.`}
        </p>
        <Button asChild variant="secondary">
          <Link href={cancelHref}>Cancel</Link>
        </Button>
        <Button disabled={Boolean(problem) || actions.create.isPending} onClick={() => create(true)} variant="outline">
          Save as draft
        </Button>
        <Button disabled={Boolean(problem) || actions.create.isPending} onClick={() => create(false)}>
          {actions.create.isPending ? 'Creating…' : `Create invoice · ${formatMoney(totalCents)}`}
        </Button>
      </div>
    </>
  );
}
