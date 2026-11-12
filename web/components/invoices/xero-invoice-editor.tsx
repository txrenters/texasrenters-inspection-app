'use client';

import {
  XERO_TAX_MODES,
  XERO_TAX_MODE_LABEL,
  formatMoney,
  invoiceCompany,
  invoiceLinesProblem,
  invoiceTaxCents,
  invoiceTotals,
  lineTaxCents,
  lineTotalCents,
  parseMoney,
  taxRateOf,
  trackingPicked,
  xeroLineDefaults,
  xeroLinesProblem,
  type InvoiceDraft,
  type InvoiceDraftProduct,
  type InvoiceLineInput,
  type XeroInvoiceFormCompany,
  type XeroTaxMode,
  type XeroVisitCompanyProjects,
} from '@texasrenters/shared';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { toast } from 'sonner';

import { ExistingInvoices, formatInvoiceDay } from '@/components/invoices/invoice-parts';
import { NewXeroProjectDialog, contactInitials } from '@/components/invoices/xero-project-field';
import { PageHeader } from '@/components/page-header';
import { ErrorState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { businessToday } from '@/lib/clock';
import { newClientRequestId, useInvoiceActions } from '@/lib/invoice-queries';
import { useXeroInvoiceForm, useXeroProjects } from '@/lib/xero-queries';

/**
 * The New invoice laid out as Xero's (2026-11-13, PR B of the office's ask to
 * make invoices as they do in Xero), once the console makes the invoices:
 * the property as the contact, the issue and due days, the reference; and for
 * each company's invoice how it carries tax, then its lines -- item,
 * description, quantity, price, discount, account, tax rate and tax, tracking,
 * project and amount. Picking an item fills the rest of its line as Xero does;
 * every field stays the office's to change, and Xero is sent what is shown. The
 * project stays the office's to pick on the draft in Xero too: its API cannot
 * put a line on one.
 */

/** A line as it is typed. Each Xero field left undefined is as its item fills it. */
interface XeroLine {
  key: string;
  name: string;
  description: string;
  quantity: string;
  price: string;
  /** A percent, as text; empty for none. */
  discount: string;
  accountId?: string;
  /** Null: no item, said on purpose. */
  itemCode?: string | null;
  taxType?: string;
  /** By category: its option, or empty for none. */
  tracking?: Record<string, string>;
  /** Null: no project, said on purpose. */
  projectId?: string | null;
}

interface XeroPart {
  key: string;
  /** The company chosen for it, used when no line's product says. */
  chosen: string | null;
  /** How it carries tax; undefined is its company's way. */
  taxMode?: XeroTaxMode;
  lines: XeroLine[];
}

/** Nothing chosen, in a select; and a new project, on the Project column. */
const NONE = 'none';
const NEW_PROJECT = 'new-project';

/** The last day of a day's month: when the office's invoices fall due. */
export function monthEndOf(day: string): string {
  const [year, month] = day.split('-').map(Number);
  return new Date(Date.UTC(year!, month!, 0)).toISOString().slice(0, 10);
}
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
const lineFrom = (line: InvoiceLineInput, key: string): XeroLine => ({
  key,
  name: line.name,
  description: line.description ?? '',
  quantity: String(line.quantity),
  price: (line.unitPriceCents / 100).toFixed(2),
  discount: '',
});
const emptyLine = (key: string): XeroLine => ({ key, name: '', description: '', quantity: '1', price: '', discount: '' });

/** The products a company's invoice is offered: its own and those of no company. */
const productsFor = (products: readonly InvoiceDraftProduct[], company: string | null) =>
  company ? products.filter((product) => !product.xeroTenantId || product.xeroTenantId === company) : products;

/** A line's amounts as typed: null while one is not a number yet. */
function amountsOf(line: XeroLine) {
  const quantity = Number(line.quantity);
  const unitPriceCents = parseMoney(line.price);
  const discountRate = line.discount.trim() ? Number(line.discount) : 0;
  if (!line.quantity.trim() || !Number.isFinite(quantity) || unitPriceCents === null || !Number.isFinite(discountRate)) return null;
  return { quantity, unitPriceCents, discountRate };
}

/** The line as Xero is sent it: what the form shows, its item's choices where the office chose nothing. */
function lineInput(line: XeroLine, company: XeroInvoiceFormCompany | null, technician: string | null, project: string | null): InvoiceLineInput | null {
  const amounts = amountsOf(line);
  if (!amounts) return null;
  const base: InvoiceLineInput = {
    name: line.name.trim(),
    description: line.description.trim() || null,
    quantity: amounts.quantity,
    unitPriceCents: amounts.unitPriceCents,
    ...(amounts.discountRate ? { discountRate: amounts.discountRate } : {}),
  };
  if (!company) return base;
  const filled = xeroLineDefaults(company, line.name, technician);
  return {
    ...base,
    xeroAccountId: line.accountId ?? filled.xeroAccountId,
    xeroItemCode: line.itemCode !== undefined ? line.itemCode : filled.xeroItemCode,
    xeroTaxType: line.taxType ?? filled.xeroTaxType,
    xeroTracking: line.tracking
      ? trackingPicked(Object.entries(line.tracking).map(([trackingCategoryId, option]) => ({ trackingCategoryId, option })))
      : filled.xeroTracking,
    xeroProjectId: project,
  };
}

export function XeroInvoiceEditor({ draft }: { draft: InvoiceDraft }) {
  const id = useId();
  const router = useRouter();
  const actions = useInvoiceActions();
  const catalog = useXeroInvoiceForm();
  const visit = draft.inspection;
  const technician = visit?.technicianName ?? null;
  const target = visit ? { inspectionId: visit.id } : draft.property ? { propertyId: draft.property.id } : null;
  const projects = useXeroProjects(target);
  const today = businessToday();
  // Dated on the visit's day, as the office dates them in Xero, and due at the end of that month.
  const [issuedOn, setIssuedOn] = useState(visit && visit.scheduledOn <= today ? visit.scheduledOn : today);
  const [dueOn, setDueOn] = useState(() => monthEndOf(visit && visit.scheduledOn <= today ? visit.scheduledOn : today));
  const [dueTouched, setDueTouched] = useState(false);
  const [reference, setReference] = useState(draft.clientName);
  const [parts, setParts] = useState<XeroPart[]>(() =>
    draft.invoices.map((part, index) => ({
      key: `part-${index}`,
      chosen: part.xeroTenantId,
      lines: part.lineItems.map((line, position) => lineFrom(line, `line-${index}-${position}`)),
    })),
  );
  const [nextKey, setNextKey] = useState(0);
  const [requestId] = useState(newClientRequestId);
  const [another, setAnother] = useState(false);
  // The line a new project is being made for.
  const [making, setMaking] = useState<{ part: string; line: string; tenantId: string } | null>(null);

  const invoicedAlready = Boolean(visit && draft.alreadyInvoiced);
  const organisations = draft.organisations ?? [];
  const nameOf = (tenantId: string) => organisations.find((organisation) => organisation.tenantId === tenantId)?.name ?? 'an organisation no longer known';
  const companyWords = (tenantId: string | null) => (tenantId ? nameOf(tenantId) : 'no company');
  const companyOf = (tenantId: string | null) => (tenantId ? (catalog.data?.find((company) => company.tenantId === tenantId) ?? null) : null);
  const projectsOf = (tenantId: string | null): XeroVisitCompanyProjects | null =>
    tenantId ? (projects.data?.companies.find((company) => company.tenantId === tenantId) ?? null) : null;

  const read = parts.map((part) => {
    const plain = part.lines.flatMap((line) => {
      const amounts = amountsOf(line);
      return amounts ? [{ name: line.name.trim(), quantity: amounts.quantity, unitPriceCents: amounts.unitPriceCents }] : [];
    });
    const said = invoiceCompany(plain, draft.products, undefined, nameOf);
    const tenantId = said.xeroTenantId ?? part.chosen;
    const company = companyOf(tenantId);
    const companyProjects = projectsOf(tenantId);
    const mode: XeroTaxMode = part.taxMode ?? company?.taxMode ?? 'EXCLUSIVE';
    const projectOf = (line: XeroLine) => (companyProjects ? (line.projectId !== undefined ? line.projectId : (companyProjects.chosen?.xeroProjectId ?? null)) : null);
    const inputs = part.lines.map((line) => lineInput(line, company, technician, projectOf(line)));
    const typo = inputs.findIndex((input) => input === null);
    const ready = inputs.filter((input): input is InvoiceLineInput => input !== null);
    const problem =
      typo >= 0
        ? `${part.lines[typo]!.name || 'A line'}: give the quantity as a number, the price in dollars and cents, and the discount as a percent.`
        : (said.problem ?? invoiceLinesProblem(ready) ?? (company ? xeroLinesProblem(ready, company, mode) : null));
    const { subtotalCents } = invoiceTotals(ready);
    const taxCents = company ? invoiceTaxCents(company, ready, mode) : 0;
    return { part, said: said.xeroTenantId, tenantId, company, companyProjects, mode, inputs, ready, problem, subtotalCents, taxCents, totalCents: mode === 'EXCLUSIVE' ? subtotalCents + taxCents : subtotalCents };
  });
  const several = read.length > 1;
  const twice = read.find((invoice, index) => read.findIndex((other) => other.tenantId === invoice.tenantId) !== index);
  const partProblem = read.find((invoice) => invoice.problem);
  const problem = !issuedOn
    ? 'Give the day the invoice is issued.'
    : issuedOn > today
      ? 'An invoice cannot be issued on a day still to come.'
      : !dueOn || dueOn < issuedOn
        ? 'Make it due on or after the day it is issued.'
        : daysBetween(issuedOn, dueOn) > 365
          ? 'Make it due within a year of the day it is issued.'
          : partProblem
            ? several
              ? `The invoice for ${companyWords(partProblem.tenantId)}: ${partProblem.problem}`
              : partProblem.problem
            : twice
              ? `Two invoices go to ${companyWords(twice.tenantId)}: put their lines on one.`
              : invoicedAlready && !another
                ? 'This visit has an invoice already: tick “Add another invoice for this visit” to make one more.'
                : null;
  const totalCents = read.reduce((sum, invoice) => sum + invoice.totalCents, 0);
  const elsewhere = draft.existing.filter((row) => !read.some((invoice) => invoice.tenantId === row.xeroTenantId));
  const others = organisations.filter((organisation) => organisation.connected && !read.some((invoice) => invoice.tenantId === organisation.tenantId));
  const cancelHref = visit ? `/inspections/${visit.id}` : '/invoices';
  const pending = actions.create.isPending || actions.createPerCompany.isPending;

  const changePart = (key: string, patch: Partial<XeroPart>) => setParts((current) => current.map((part) => (part.key === key ? { ...part, ...patch } : part)));
  const changeLine = (partKey: string, lineKey: string, patch: Partial<XeroLine>) =>
    setParts((current) =>
      current.map((part) => (part.key === partKey ? { ...part, lines: part.lines.map((line) => (line.key === lineKey ? { ...line, ...patch } : line)) } : part)),
    );
  const addLine = (partKey: string) => {
    setNextKey((count) => count + 1);
    setParts((current) => current.map((part) => (part.key === partKey ? { ...part, lines: [...part.lines, emptyLine(`added-${nextKey}`)] } : part)));
  };
  const removeLine = (partKey: string, lineKey: string) =>
    setParts((current) => current.map((part) => (part.key === partKey ? { ...part, lines: part.lines.filter((line) => line.key !== lineKey) } : part)));
  const addPart = (tenantId: string) => {
    setNextKey((count) => count + 1);
    setParts((current) => [...current, { key: `added-part-${nextKey}`, chosen: tenantId, lines: [emptyLine(`added-${nextKey}`)] }]);
  };
  const changeIssued = (day: string) => {
    setIssuedOn(day);
    if (!dueTouched && day) setDueOn(monthEndOf(day));
  };

  const create = () => {
    if (problem) return;
    const form = {
      ...(visit ? { inspectionId: visit.id } : { propertyId: draft.property?.id }),
      ...(invoicedAlready && another ? { additional: true } : {}),
      subject: draft.subject,
      issuedOn,
      paymentTermsDays: daysBetween(issuedOn, dueOn),
      dueOn,
      reference: reference.trim() || null,
      clientRequestId: requestId,
    };
    const failed = (error: Error) => toast.error(several ? 'No invoice was created' : 'The invoice was not created', { description: error.message });
    const made = (count: number, total: number) =>
      toast.success(count > 1 ? `${count} drafts made in Xero` : 'Draft made in Xero', {
        description: `${formatMoney(total)} to ${draft.clientName}. Xero numbers ${count > 1 ? 'them' : 'it'}; approve there.`,
      });
    if (!several) {
      const only = read[0]!;
      actions.create.mutate(
        { ...form, lineItems: only.ready, ...(only.tenantId ? { xeroTenantId: only.tenantId } : {}), ...(only.company ? { taxMode: only.mode } : {}) },
        {
          onSuccess: (invoice) => {
            made(1, invoice.totalCents);
            router.push(`/invoices/${invoice.id}`);
          },
          onError: failed,
        },
      );
      return;
    }
    actions.createPerCompany.mutate(
      { ...form, invoices: read.map((invoice) => ({ xeroTenantId: invoice.tenantId, lineItems: invoice.ready, ...(invoice.company ? { taxMode: invoice.mode } : {}) })) },
      {
        onSuccess: ({ invoices }) => {
          made(invoices.length, invoices.reduce((sum, invoice) => sum + invoice.totalCents, 0));
          router.push(visit ? `/inspections/${visit.id}` : `/invoices/${invoices[0]!.id}`);
        },
        onError: failed,
      },
    );
  };

  const currency = catalog.data?.find((company) => read.some((invoice) => invoice.tenantId === company.tenantId))?.currency ?? 'USD';
  const madeFor = making ? read.find((invoice) => invoice.part.key === making.part) : null;

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
              . Each invoice goes to its company’s books in Xero as a draft, as it is shown here.
            </span>
          ) : (
            <span>For {draft.property?.address ?? draft.clientName}, for work no visit covers. Each invoice goes to its company’s books in Xero as a draft.</span>
          )
        }
        title="New invoice"
      />

      {elsewhere.length || invoicedAlready ? (
        <div className="border-warning/30 bg-warning/10 mb-4 flex flex-wrap items-center gap-2 rounded-lg border p-3 text-sm" role="status">
          {elsewhere.length ? (
            <>
              This visit already has an invoice:
              <ExistingInvoices invoices={elsewhere} />
            </>
          ) : draft.existing.length ? (
            'This visit already has an invoice, listed below.'
          ) : (
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

      <section aria-label="Invoice details" className="bg-card rounded-lg border p-4">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <Field>
            <FieldLabel htmlFor={`${id}-contact`}>Contact</FieldLabel>
            <div className="relative">
              <span aria-hidden="true" className="bg-warning/20 text-heading absolute top-1/2 left-1.5 -translate-y-1/2 rounded px-1.5 py-0.5 text-xs font-bold">
                {contactInitials(draft.clientName)}
              </span>
              <Input className="bg-muted pl-14" id={`${id}-contact`} readOnly value={draft.clientName} />
            </div>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-issued`}>Issue date</FieldLabel>
            <Input id={`${id}-issued`} max={today} onChange={(event) => changeIssued(event.target.value)} type="date" value={issuedOn} />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-due`}>Due date</FieldLabel>
            <Input
              id={`${id}-due`}
              min={issuedOn}
              onChange={(event) => {
                setDueTouched(true);
                setDueOn(event.target.value);
              }}
              type="date"
              value={dueOn}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-number`}>Invoice number</FieldLabel>
            <Input className="bg-muted" id={`${id}-number`} readOnly value="Given by Xero" />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-reference`}>Reference</FieldLabel>
            <Input id={`${id}-reference`} maxLength={255} onChange={(event) => setReference(event.target.value)} value={reference} />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-payments`}>Online payments</FieldLabel>
            <Input className="bg-muted" id={`${id}-payments`} readOnly value="As set in Xero" />
            <FieldDescription>Card and ACH come with the invoice’s template in Xero.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-currency`}>Currency</FieldLabel>
            <Input className="bg-muted" id={`${id}-currency`} readOnly value={currency} />
          </Field>
        </div>
      </section>

      {catalog.isError ? (
        <div className="mt-6">
          <ErrorState error={catalog.error} retry={() => void catalog.refetch()} />
        </div>
      ) : catalog.isLoading ? (
        <p className="text-muted-foreground mt-6 text-sm" role="status">
          Reading each company’s accounts, tax rates and tracking…
        </p>
      ) : (
        read.map((invoice) => (
          <XeroPartSection
            changeLine={changeLine}
            companyName={companyWords(invoice.tenantId)}
            invoice={invoice}
            key={invoice.part.key}
            onAddLine={() => addLine(invoice.part.key)}
            onChoose={(tenantId) => changePart(invoice.part.key, { chosen: tenantId })}
            onLeaveOut={several ? () => setParts((current) => current.filter((part) => part.key !== invoice.part.key)) : null}
            onNewProject={(lineKey) => invoice.tenantId && setMaking({ part: invoice.part.key, line: lineKey, tenantId: invoice.tenantId })}
            onRemoveLine={(lineKey) => removeLine(invoice.part.key, lineKey)}
            onTaxMode={(taxMode) => changePart(invoice.part.key, { taxMode })}
            organisations={organisations}
            products={productsFor(draft.products, invoice.tenantId)}
          />
        ))
      )}

      {others.length ? (
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

      <div className="mt-6 flex flex-wrap items-center justify-end gap-3">
        <p aria-live="polite" className={problem ? 'text-destructive mr-auto text-sm' : 'text-muted-foreground mr-auto text-sm'}>
          {problem ??
            `Made out to ${draft.clientName}. ${several ? 'Each goes' : 'It goes'} to Xero as a draft, numbered there; pick each line’s project there before approving.`}
        </p>
        <Button asChild variant="secondary">
          <Link href={cancelHref}>Cancel</Link>
        </Button>
        <Button disabled={Boolean(problem) || pending || !catalog.data} onClick={create}>
          {pending ? 'Saving…' : several ? `Save ${read.length} drafts in Xero · ${formatMoney(totalCents)}` : `Save draft in Xero · ${formatMoney(totalCents)}`}
        </Button>
      </div>

      {making && madeFor?.companyProjects && projects.data ? (
        <NewXeroProjectDialog
          company={madeFor.companyProjects}
          onClose={() => setMaking(null)}
          onMade={(project) =>
            // The line it was made from, and every line of the invoice that names none yet.
            setParts((current) =>
              current.map((part) =>
                part.key === making.part
                  ? {
                      ...part,
                      lines: part.lines.map((line) => (line.key === making.line || line.projectId === undefined ? { ...line, projectId: project.xeroProjectId } : line)),
                    }
                  : part,
              ),
            )
          }
          open
          visit={projects.data}
        />
      ) : null}
    </>
  );
}

type ReadPart = {
  part: XeroPart;
  said: string | null;
  tenantId: string | null;
  company: XeroInvoiceFormCompany | null;
  companyProjects: XeroVisitCompanyProjects | null;
  mode: XeroTaxMode;
  inputs: (InvoiceLineInput | null)[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
};

/** One company's invoice: how it carries tax, its lines as Xero's table has them, and its totals. */
function XeroPartSection({
  invoice,
  companyName,
  organisations,
  products,
  changeLine,
  onAddLine,
  onRemoveLine,
  onTaxMode,
  onChoose,
  onLeaveOut,
  onNewProject,
}: {
  invoice: ReadPart;
  companyName: string;
  organisations: readonly { tenantId: string; name: string; connected: boolean }[];
  products: readonly InvoiceDraftProduct[];
  changeLine: (partKey: string, lineKey: string, patch: Partial<XeroLine>) => void;
  onAddLine: () => void;
  onRemoveLine: (lineKey: string) => void;
  onTaxMode: (mode: XeroTaxMode) => void;
  onChoose: (tenantId: string | null) => void;
  onLeaveOut: (() => void) | null;
  onNewProject: (lineKey: string) => void;
}) {
  const { part, company, companyProjects, mode } = invoice;
  const tracking = company?.tracking ?? [];
  const change = (lineKey: string, patch: Partial<XeroLine>) => changeLine(part.key, lineKey, patch);

  return (
    <section aria-label={`Invoice for ${companyName}`} className="bg-card mt-6 rounded-lg border">
      <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
        <div className="mr-auto">
          <h2 className="text-heading text-base font-bold">Invoice for {companyName}</h2>
          {invoice.said ? null : (
            <Select onValueChange={(value) => onChoose(value === NONE ? null : value)} value={part.chosen ?? NONE}>
              <SelectTrigger aria-label={`Company for the invoice for ${companyName}`} className="mt-1 h-8 w-auto gap-2">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>No company</SelectItem>
                {organisations
                  .filter((organisation) => organisation.connected || organisation.tenantId === part.chosen)
                  .map((organisation) => (
                    <SelectItem key={organisation.tenantId} value={organisation.tenantId}>
                      {organisation.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          )}
        </div>
        {company ? (
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">Tax</span>
            <Select onValueChange={(value) => onTaxMode(value as XeroTaxMode)} value={mode}>
              <SelectTrigger aria-label={`Tax on the invoice for ${companyName}`} className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {XERO_TAX_MODES.map((each) => (
                  <SelectItem key={each} value={each}>
                    {XERO_TAX_MODE_LABEL[each]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
        {onLeaveOut ? (
          <Button aria-label={`Leave out the invoice for ${companyName}`} onClick={onLeaveOut} size="sm" variant="ghost">
            <Trash2Icon />
            Leave out
          </Button>
        ) : null}
        {!invoice.tenantId ? <p className="text-muted-foreground w-full text-xs">An invoice that goes to no company reaches no books: choose its company.</p> : null}
      </div>

      <div className="overflow-x-auto">
        <Table className="min-w-[1500px] table-fixed">
          {/* Not sticky: inside its own scroll box, a sticky header covers the first line. */}
          <TableHeader className="lg:static">
            <TableRow>
              <TableHead className="w-[200px]">Item</TableHead>
              <TableHead className="w-[200px]">Description</TableHead>
              <TableHead className="w-[72px] text-right">Qty.</TableHead>
              <TableHead className="w-[100px] text-right">Price</TableHead>
              <TableHead className="w-[72px] text-right">Disc.</TableHead>
              {company ? <TableHead className="w-[200px]">Account</TableHead> : null}
              {company ? <TableHead className="w-[150px]">Tax rate</TableHead> : null}
              {company ? <TableHead className="w-[100px] text-right">Tax amount</TableHead> : null}
              {tracking.map((category) => (
                <TableHead className="w-[180px]" key={category.trackingCategoryId}>
                  {category.name}
                </TableHead>
              ))}
              {companyProjects ? <TableHead className="w-[220px]">Project</TableHead> : null}
              <TableHead className="w-[110px] text-right">Amount {company?.currency ?? 'USD'}</TableHead>
              <TableHead className="w-[48px]">
                <span className="sr-only">Remove</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {part.lines.map((line, index) => {
              const n = index + 1;
              const input = invoice.inputs[index] ?? null;
              const amountCents = input ? lineTotalCents(input) : null;
              const rate = company ? taxRateOf(company, input?.xeroTaxType) : 0;
              const listed = products.some((product) => product.name === line.name);
              return (
                <TableRow key={line.key}>
                  <TableCell className="align-top">
                    <Select
                      onValueChange={(name) => {
                        const product = products.find((each) => each.name === name);
                        // A new item fills its line again, as Xero does.
                        change(line.key, {
                          name,
                          ...(product ? { price: (product.unitPriceCents / 100).toFixed(2), description: product.description ?? '' } : {}),
                          accountId: undefined,
                          itemCode: undefined,
                          taxType: undefined,
                          tracking: undefined,
                        });
                      }}
                      value={line.name}
                    >
                      <SelectTrigger aria-label={`Line ${n}: item`} className="w-full">
                        <SelectValue placeholder="Choose an item" />
                      </SelectTrigger>
                      <SelectContent>
                        {line.name && !listed ? <SelectItem value={line.name}>{line.name}</SelectItem> : null}
                        {products.map((product) => (
                          <SelectItem key={product.name} value={product.name}>
                            {product.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {company && company.items.length ? (
                      <Select onValueChange={(value) => change(line.key, { itemCode: value === NONE ? null : value })} value={input?.xeroItemCode ?? NONE}>
                        <SelectTrigger aria-label={`Line ${n}: Xero item`} className="mt-1 h-7 w-full text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NONE}>No Xero item</SelectItem>
                          {company.items.map((item) => (
                            <SelectItem key={item.code} value={item.code}>
                              {item.code}
                              {item.name && item.name !== item.code ? ` · ${item.name}` : ''}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : null}
                  </TableCell>
                  <TableCell className="align-top">
                    <Input
                      aria-label={`Line ${n}: description`}
                      maxLength={2000}
                      onChange={(event) => change(line.key, { description: event.target.value })}
                      placeholder={line.name || 'Description'}
                      value={line.description}
                    />
                  </TableCell>
                  <TableCell className="align-top">
                    <Input
                      aria-label={`Line ${n}: quantity`}
                      className="text-right tabular-nums"
                      inputMode="decimal"
                      onChange={(event) => change(line.key, { quantity: event.target.value })}
                      value={line.quantity}
                    />
                  </TableCell>
                  <TableCell className="align-top">
                    <Input
                      aria-label={`Line ${n}: price`}
                      className="text-right tabular-nums"
                      inputMode="decimal"
                      onChange={(event) => change(line.key, { price: event.target.value })}
                      value={line.price}
                    />
                  </TableCell>
                  <TableCell className="align-top">
                    <Input
                      aria-label={`Line ${n}: discount`}
                      className="text-right tabular-nums"
                      inputMode="decimal"
                      onChange={(event) => change(line.key, { discount: event.target.value })}
                      placeholder="%"
                      value={line.discount}
                    />
                  </TableCell>
                  {company ? (
                    <TableCell className="align-top">
                      <Select onValueChange={(accountId) => change(line.key, { accountId })} value={input?.xeroAccountId ?? ''}>
                        <SelectTrigger aria-label={`Line ${n}: account`} className="w-full">
                          <SelectValue placeholder="Choose an account" />
                        </SelectTrigger>
                        <SelectContent>
                          {company.accounts.map((account) => (
                            <SelectItem key={account.accountId} value={account.accountId}>
                              {account.code} · {account.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                  ) : null}
                  {company ? (
                    <TableCell className="align-top">
                      <Select onValueChange={(taxType) => change(line.key, { taxType })} value={input?.xeroTaxType ?? ''}>
                        <SelectTrigger aria-label={`Line ${n}: tax rate`} className="w-full">
                          <SelectValue placeholder="Choose a rate" />
                        </SelectTrigger>
                        <SelectContent>
                          {company.taxRates.map((each) => (
                            <SelectItem key={each.taxType} value={each.taxType}>
                              {each.name} ({each.rate}%)
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                  ) : null}
                  {company ? (
                    <TableCell className="text-muted-foreground pt-4 text-right align-top tabular-nums">
                      {amountCents === null ? '—' : formatMoney(lineTaxCents(amountCents, rate, mode))}
                    </TableCell>
                  ) : null}
                  {tracking.map((category) => {
                    const picked = input?.xeroTracking?.find((each) => each.trackingCategoryId === category.trackingCategoryId)?.option ?? NONE;
                    return (
                      <TableCell className="align-top" key={category.trackingCategoryId}>
                        <Select
                          onValueChange={(option) => {
                            const current = Object.fromEntries((input?.xeroTracking ?? []).map((each) => [each.trackingCategoryId, each.option]));
                            change(line.key, { tracking: { ...current, [category.trackingCategoryId]: option === NONE ? '' : option } });
                          }}
                          value={picked}
                        >
                          <SelectTrigger aria-label={`Line ${n}: ${category.name}`} className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={NONE}>None</SelectItem>
                            {category.options.map((option) => (
                              <SelectItem key={option} value={option}>
                                {option}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                    );
                  })}
                  {companyProjects ? (
                    <TableCell className="align-top">
                      <ProjectSelect
                        company={companyProjects}
                        label={`Line ${n}: project`}
                        onChange={(value) => (value === NEW_PROJECT ? onNewProject(line.key) : change(line.key, { projectId: value === NONE ? null : value }))}
                        value={input?.xeroProjectId ?? NONE}
                      />
                    </TableCell>
                  ) : null}
                  <TableCell className="text-heading pt-4 text-right align-top font-semibold tabular-nums">{amountCents === null ? '—' : formatMoney(amountCents)}</TableCell>
                  <TableCell className="align-top">
                    <Button aria-label={`Remove line ${n}`} onClick={() => onRemoveLine(line.key)} size="icon" variant="ghost">
                      <Trash2Icon />
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-4 border-t px-4 py-3">
        <Button onClick={onAddLine} size="sm" variant="outline">
          <PlusIcon />
          Add row
        </Button>
        <dl className="grid grid-cols-[1fr_auto] gap-x-8 gap-y-1 text-sm sm:w-80">
          <dt className="text-muted-foreground">Subtotal</dt>
          <dd className="text-right tabular-nums">{formatMoney(invoice.subtotalCents)}</dd>
          <dt className="text-muted-foreground">{mode === 'INCLUSIVE' ? 'Includes sales tax' : 'Total sales tax'}</dt>
          <dd className="text-right tabular-nums">{formatMoney(invoice.taxCents)}</dd>
          <dt className="text-heading border-t pt-2 text-base font-bold">Total</dt>
          <dd className="text-heading border-t pt-2 text-right text-base font-bold tabular-nums">{formatMoney(invoice.totalCents)}</dd>
        </dl>
      </div>
    </section>
  );
}

/** A line's project: one in progress in the company's books under the property, none, or a new one. */
function ProjectSelect({
  company,
  value,
  label,
  onChange,
}: {
  company: XeroVisitCompanyProjects;
  value: string;
  label: string;
  onChange: (value: string) => void;
}) {
  const chosen = company.chosen;
  const options = chosen && !company.projects.some((project) => project.xeroProjectId === chosen.xeroProjectId) ? [chosen, ...company.projects] : company.projects;
  return (
    <Select onValueChange={onChange} value={value}>
      <SelectTrigger aria-label={label} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>No project</SelectItem>
        {options.map((project) => (
          <SelectItem key={project.xeroProjectId} value={project.xeroProjectId}>
            {project.name}
          </SelectItem>
        ))}
        {company.problem ? null : <SelectItem value={NEW_PROJECT}>+ New project…</SelectItem>}
      </SelectContent>
    </Select>
  );
}
