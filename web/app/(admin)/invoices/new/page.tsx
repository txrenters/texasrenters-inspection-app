'use client';

import {
  PAYMENT_TERMS,
  dueOnFor,
  formatMoney,
  invoiceCompany,
  invoiceLinesProblem,
  invoiceTotals,
  type InvoiceDraft,
  type InvoiceDraftProduct,
  type InvoiceLineInput,
  type InvoiceDetail,
} from '@texasrenters/shared';
import { Trash2Icon } from 'lucide-react';
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
import { Checkbox } from '@/components/ui/checkbox';
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
 *
 * One invoice per company (2026-11-10, phase 3 of the multi-company plan):
 * each product or service goes to the company's books the office chose for
 * it, so a visit whose services go to two companies makes two invoices, each
 * with its own lines, made together. An invoice no product decides goes to
 * the company chosen for it.
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

/** A draft that starts as another invoice did: its subject, its lines at their prices, its company and its message. */
function likeInvoice(draft: InvoiceDraft, invoice: InvoiceDetail): InvoiceDraft {
  return {
    ...draft,
    subject: invoice.subject,
    invoices: [
      {
        xeroTenantId: invoice.company?.tenantId ?? null,
        lineItems: invoice.lineItems.map((line) => ({
          name: line.name,
          description: line.description,
          quantity: line.quantity,
          unitPriceCents: line.unitPriceCents,
        })),
      },
    ],
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

/** One company's invoice as it is being made: the company chosen for it, used when no line's product says. */
interface Part {
  key: string;
  chosen: string | null;
  lines: EditLine[];
}

/** No company: the value the company select gives it. */
const NO_COMPANY = 'none';

function InvoiceEditor({ draft }: { draft: InvoiceDraft }) {
  const id = useId();
  const router = useRouter();
  const actions = useInvoiceActions();
  const [subject, setSubject] = useState(draft.subject);
  const [issuedOn, setIssuedOn] = useState(draft.issuedOn);
  const [terms, setTerms] = useState(String(draft.paymentTermsDays));
  const [message, setMessage] = useState(draft.clientMessage);
  const [parts, setParts] = useState<Part[]>(() =>
    draft.invoices.map((part, index) => ({ key: `part-${index}`, chosen: part.xeroTenantId, lines: part.lineItems.map(toEditLine) })),
  );
  // One key for this form: a double click or a resend makes no invoice twice.
  const [requestId] = useState(newClientRequestId);
  // A visit invoiced already (2026-11-13), of any origin: another is made only when ticked, and the server asks the same.
  const [another, setAnother] = useState(false);
  const visit = draft.inspection;
  const invoicedAlready = Boolean(visit && draft.alreadyInvoiced);
  const organisations = draft.organisations ?? [];
  const connected = organisations.filter((organisation) => organisation.connected);
  // The companies are asked about only once Xero has an organisation.
  const companies = organisations.length > 0;
  const nameOf = (tenantId: string) => organisations.find((organisation) => organisation.tenantId === tenantId)?.name ?? 'an organisation no longer known';
  const companyWords = (tenantId: string | null) => (tenantId ? nameOf(tenantId) : 'no company');

  // Each invoice as it would be sent: its lines, its company, and what stops it.
  const read = parts.map((part) => {
    const lines = readLines(part.lines);
    // A new invoice's lines are its name, description, quantity and price; the
    // service day and tax are an edit's.
    const ready: InvoiceLineInput[] = lines.ready.map(({ name, description, quantity, unitPriceCents }) => ({ name, description, quantity, unitPriceCents }));
    const said = invoiceCompany(ready, draft.products, undefined, nameOf);
    const company = said.xeroTenantId ?? part.chosen;
    return { part, ready, said: said.xeroTenantId, company, problem: lines.problem ?? said.problem ?? invoiceLinesProblem(ready), ...invoiceTotals(ready) };
  });
  const twice = read.find((invoice, index) => read.findIndex((other) => other.company === invoice.company) !== index);
  const partProblem = read.find((invoice) => invoice.problem);
  const problem = !subject.trim()
    ? 'Give the invoice a subject.'
    : partProblem
      ? read.length > 1
        ? `The invoice for ${companyWords(partProblem.company)}: ${partProblem.problem}`
        : partProblem.problem
      : twice
        ? `Two invoices go to ${companyWords(twice.company)}: put their lines on one.`
        : invoicedAlready && !another
          ? 'This visit has an invoice already: tick “Add another invoice for this visit” to make one more.'
          : null;
  const totalCents = read.reduce((sum, invoice) => sum + invoice.totalCents, 0);
  const several = read.length > 1;
  const cancelHref = visit ? `/inspections/${visit.id}` : '/invoices';
  // Another company's invoice: one connected that has none on this form yet.
  const others = connected.filter((organisation) => !read.some((invoice) => invoice.company === organisation.tenantId));
  // An invoice the visit has already that no invoice here goes with: said above them all.
  const elsewhere = companies ? draft.existing.filter((row) => !read.some((invoice) => invoice.company === row.xeroTenantId)) : draft.existing;

  const change = (key: string, patch: Partial<Part>) => setParts((current) => current.map((part) => (part.key === key ? { ...part, ...patch } : part)));
  const addPart = (tenantId: string) =>
    setParts((current) => {
      const used = new Set(current.map((part) => part.key));
      let next = current.length;
      while (used.has(`part-${next}`)) next += 1;
      return [...current, { key: `part-${next}`, chosen: tenantId, lines: [] }];
    });

  const madeToast = (asDraft: boolean, made: { number: string | null; totalCents: number; clientName: string; company?: { name: string } | null }[]) => {
    if (made.length === 1) {
      const invoice = made[0]!;
      toast.success(asDraft ? 'Draft saved' : invoice.number ? `Invoice #${invoice.number} created` : 'Invoice created', {
        description: `${formatMoney(invoice.totalCents)} to ${invoice.clientName}.`,
      });
      return;
    }
    toast.success(asDraft ? `${made.length} drafts saved` : `${made.length} invoices created`, {
      description: made
        .map((invoice) => `${invoice.number ? `#${invoice.number}` : 'Draft'} ${invoice.company?.name ?? 'no company'} ${formatMoney(invoice.totalCents)}`)
        .join(' · '),
    });
  };

  const create = (asDraft: boolean) => {
    if (problem) return;
    const form = {
      ...(visit ? { inspectionId: visit.id } : { propertyId: draft.property?.id }),
      ...(asDraft ? { asDraft: true } : {}),
      ...(invoicedAlready && another ? { additional: true } : {}),
      subject: subject.trim(),
      issuedOn,
      paymentTermsDays: Number(terms),
      ...(message.trim() ? { clientMessage: message.trim() } : {}),
      clientRequestId: requestId,
    };
    const failed = (error: Error) => toast.error(several ? 'No invoice was created' : 'The invoice was not created', { description: error.message });
    if (!several) {
      const only = read[0]!;
      actions.create.mutate(
        { ...form, lineItems: only.ready, ...(only.company ? { xeroTenantId: only.company } : {}) },
        {
          onSuccess: (invoice) => {
            madeToast(asDraft, [invoice]);
            router.push(`/invoices/${invoice.id}`);
          },
          onError: failed,
        },
      );
      return;
    }
    actions.createPerCompany.mutate(
      { ...form, invoices: read.map((invoice) => ({ xeroTenantId: invoice.company, lineItems: invoice.ready })) },
      {
        onSuccess: ({ invoices }) => {
          madeToast(asDraft, invoices);
          // The visit lists its invoices; a property's open the first.
          router.push(visit ? `/inspections/${visit.id}` : `/invoices/${invoices[0]!.id}`);
        },
        onError: failed,
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

      {elsewhere.length || invoicedAlready ? (
        <div className="border-warning/30 bg-warning/10 mb-4 flex flex-wrap items-center gap-2 rounded-lg border p-3 text-sm" role="status">
          {elsewhere.length ? (
            <>
              This visit already has an invoice:
              <Existing invoices={elsewhere} />
            </>
          ) : draft.existing.length ? (
            'This visit already has an invoice, listed below.'
          ) : (
            // Kept out of sight behind the invoice Xero has (2026-11-13): Jobber's copy, or one on no visit there.
            'This visit already has an invoice, from Jobber or in Xero.'
          )}{' '}
          Make a second one only if it bills something the first does not.
          {invoicedAlready ? (
            <label className="flex w-full items-center gap-2 font-medium">
              <Checkbox checked={another} onCheckedChange={(checked) => setAnother(checked === true)} />
              Add another invoice for this visit
            </label>
          ) : null}
        </div>
      ) : null}

      {several ? (
        <p className="text-muted-foreground mb-4 text-sm" role="status">
          One invoice for each company’s books: {read.length} invoices, created together.
        </p>
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

      {read.map((invoice) => {
        const { part } = invoice;
        const name = companyWords(invoice.company);
        const existing = draft.existing.filter((row) => row.xeroTenantId === invoice.company);
        return (
          <section aria-label={companies ? `Invoice for ${name}` : 'Products and services'} className="bg-card mt-6 rounded-lg border" key={part.key}>
            {companies ? (
              <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
                <h2 className="text-heading text-base font-bold">Invoice for {name}</h2>
                {invoice.said ? (
                  <span className="text-muted-foreground text-xs">Its products go to {nameOf(invoice.said)}’s books.</span>
                ) : (
                  <Select onValueChange={(value) => change(part.key, { chosen: value === NO_COMPANY ? null : value })} value={part.chosen ?? NO_COMPANY}>
                    <SelectTrigger aria-label={`Company for the invoice for ${name}`} className="h-8 w-auto gap-2">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_COMPANY}>No company</SelectItem>
                      {organisations
                        .filter((organisation) => organisation.connected || organisation.tenantId === part.chosen)
                        .map((organisation) => (
                          <SelectItem key={organisation.tenantId} value={organisation.tenantId}>
                            {organisation.connected ? organisation.name : `${organisation.name} (not connected)`}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                )}
                {several ? (
                  <Button
                    aria-label={`Leave out the invoice for ${name}`}
                    className="ml-auto"
                    onClick={() => setParts((current) => current.filter((entry) => entry.key !== part.key))}
                    size="sm"
                    variant="ghost"
                  >
                    <Trash2Icon />
                    Leave out
                  </Button>
                ) : null}
                {!invoice.company ? (
                  <p className="text-muted-foreground w-full text-xs">An invoice that belongs to no company is never sent to Xero.</p>
                ) : null}
                {existing.length ? (
                  <p className="border-warning/30 bg-warning/10 flex w-full flex-wrap items-center gap-2 rounded-md border p-2 text-xs" role="status">
                    This visit already has an invoice for {name}:
                    <Existing invoices={existing} />
                    Make a second one only if it bills something the first does not.
                  </p>
                ) : null}
              </div>
            ) : null}
            <LineItemsEditor
              lines={part.lines}
              onChange={(lines) => change(part.key, { lines })}
              products={productsFor(draft.products, invoice.company, companies)}
            />
            <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-1 border-t px-4 py-3 text-sm sm:ml-auto sm:w-72">
              <dt className="text-muted-foreground">Subtotal</dt>
              <dd className="text-right tabular-nums">{formatMoney(invoice.subtotalCents)}</dd>
              <dt className="text-heading text-base font-bold">Total</dt>
              <dd className="text-heading text-right text-base font-bold tabular-nums">{formatMoney(invoice.totalCents)}</dd>
            </dl>
          </section>
        );
      })}

      {companies && others.length ? (
        <div className="mt-3 flex justify-end">
          <Select onValueChange={addPart} value="">
            <SelectTrigger aria-label="Add an invoice for another company" className="h-8 w-auto gap-2">
              <SelectValue placeholder="Add an invoice for another company" />
            </SelectTrigger>
            <SelectContent>
              {others.map((organisation) => (
                <SelectItem key={organisation.tenantId} value={organisation.tenantId}>
                  {organisation.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

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
        <Button
          disabled={Boolean(problem) || actions.create.isPending || actions.createPerCompany.isPending}
          onClick={() => create(true)}
          variant="outline"
        >
          {several ? 'Save as drafts' : 'Save as draft'}
        </Button>
        <Button disabled={Boolean(problem) || actions.create.isPending || actions.createPerCompany.isPending} onClick={() => create(false)}>
          {actions.create.isPending || actions.createPerCompany.isPending
            ? 'Creating…'
            : several
              ? `Create ${read.length} invoices · ${formatMoney(totalCents)}`
              : `Create invoice · ${formatMoney(totalCents)}`}
        </Button>
      </div>
    </>
  );
}

/** The products a company's invoice is offered: its own and those of no company; every one while it has no company. */
function productsFor(products: readonly InvoiceDraftProduct[], company: string | null, companies: boolean) {
  if (!companies || !company) return products;
  return products.filter((product) => !product.xeroTenantId || product.xeroTenantId === company);
}

/** The invoices a visit has already, each opening it. */
function Existing({ invoices }: { invoices: InvoiceDraft['existing'] }) {
  return (
    <>
      {invoices.map((invoice) => (
        <span className="inline-flex items-center gap-1.5" key={invoice.id}>
          <Link className="font-semibold underline underline-offset-2" href={`/invoices/${invoice.id}`}>
            {invoice.number ? `#${invoice.number}` : 'a draft'}
          </Link>
          <InvoiceStatusBadge status={invoice.status} />
        </span>
      ))}
    </>
  );
}
