'use client';

import {
  PAYMENT_TERMS,
  formatMoney,
  invoiceProductProblem,
  invoiceSettingsProblem,
  parseMoney,
  type InvoiceFileCopyStatus,
  type InvoiceProductView,
  type InvoiceSettingsValues,
  type InvoiceSettingsView,
} from '@texasrenters/shared';
import { useId, useState } from 'react';
import { toast } from 'sonner';

import { InvoiceEmailsSection } from '@/components/invoices/invoice-emails-section';
import { InvoiceTakeoverSection } from '@/components/invoices/invoice-takeover-section';
import { PageHeader } from '@/components/page-header';
import { ErrorState, PageSkeleton } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/api';
import { usePermissions } from '@/lib/auth';
import { useRetryFileCopies } from '@/lib/invoice-files';
import { useInvoiceSettings, useInvoiceSettingsEdits } from '@/lib/invoice-settings-queries';

/**
 * Invoice settings (2026-11-06, phase 6 of taking invoicing over from Jobber),
 * as Jobber keeps them in its settings: the company the invoices, receipts and
 * emails are from; what a new invoice starts with; and the products and
 * services at the office's prices, which price a new invoice's lines.
 *
 * Every field left blank keeps what the console used before -- shown greyed in
 * it -- so nothing changes until somebody fills one in. Changed by whoever
 * makes invoices; read by whoever reads them. Nothing here reaches Jobber.
 */
export default function InvoiceSettingsPage() {
  const settings = useInvoiceSettings();
  const { has } = usePermissions();

  if (settings.isLoading) return <PageSkeleton />;
  if (settings.isError || !settings.data) return <ErrorState error={settings.error} retry={() => void settings.refetch()} />;

  const mayChange = has('invoices:manage');
  return (
    <>
      <PageHeader
        description="The company your invoices, receipts and emails are from, what a new invoice starts with, and your products and services."
        title="Invoice settings"
      />
      {mayChange ? null : (
        <p className="text-muted-foreground mb-4 text-sm">Only whoever makes invoices changes these.</p>
      )}
      {/* Started again from what was saved, each time it is saved. */}
      <SettingsForm key={settings.data.updatedAt ?? 'never'} mayChange={mayChange} view={settings.data} />
      <ProductsSection mayChange={mayChange} view={settings.data} />
      <InvoiceEmailsSection mayChange={mayChange} />
      {settings.data.files ? <FileCopiesSection files={settings.data.files} mayChange={mayChange} /> : null}
      <InvoiceTakeoverSection />
    </>
  );
}

type Text = Record<Exclude<keyof InvoiceSettingsValues, 'defaultTermsDays'>, string>;

const TEXT_KEYS = [
  'companyName',
  'addressLine1',
  'addressLine2',
  'phone',
  'email',
  'defaultSubject',
  'defaultClientMessage',
  'defaultContractDisclaimer',
] as const;

const asText = (values: InvoiceSettingsValues): Text =>
  Object.fromEntries(TEXT_KEYS.map((key) => [key, values[key] ?? ''])) as Text;

const termsLabel = (days: number) => PAYMENT_TERMS.find((option) => option.days === days)?.label ?? `${days} days`;

/** A 409 is somebody else's save: read the settings again before trying. */
const conflict = (error: Error) => error instanceof ApiError && error.status === 409;

function SettingsForm({ view, mayChange }: { view: InvoiceSettingsView; mayChange: boolean }) {
  const id = useId();
  const edits = useInvoiceSettingsEdits();
  const [text, setText] = useState<Text>(() => asText(view.values));
  const [terms, setTerms] = useState<string>(view.values.defaultTermsDays === null ? 'latest' : String(view.values.defaultTermsDays));

  const values: InvoiceSettingsValues = {
    ...Object.fromEntries(TEXT_KEYS.map((key) => [key, text[key].trim() || null])),
    defaultTermsDays: terms === 'latest' ? null : Number(terms),
  } as InvoiceSettingsValues;
  const saved = { ...view.values, ...Object.fromEntries(TEXT_KEYS.map((key) => [key, view.values[key]?.trim() || null])) };
  const dirty = (Object.keys(values) as (keyof InvoiceSettingsValues)[]).some((key) => values[key] !== saved[key]);
  const problem = invoiceSettingsProblem(values);
  const fallback = view.fallback;

  const save = () =>
    edits.save.mutate(
      { ...values, expectedUpdatedAt: view.updatedAt },
      {
        onSuccess: () => toast.success('Invoice settings saved'),
        onError: (error) =>
          toast.error('The settings were not saved', {
            description: conflict(error) ? `${error.message} The page now shows them as they are.` : error.message,
          }),
      },
    );

  const field = (key: (typeof TEXT_KEYS)[number], label: string, placeholder: string | null, long = false) => (
    <Field className={long ? 'md:col-span-2' : undefined}>
      <FieldLabel htmlFor={`${id}-${key}`}>{label}</FieldLabel>
      {long ? (
        <Textarea
          className="min-h-20"
          disabled={!mayChange}
          id={`${id}-${key}`}
          maxLength={4000}
          onChange={(event) => setText((current) => ({ ...current, [key]: event.target.value }))}
          placeholder={placeholder ?? undefined}
          value={text[key]}
        />
      ) : (
        <Input
          disabled={!mayChange}
          id={`${id}-${key}`}
          inputMode={key === 'email' ? 'email' : key === 'phone' ? 'tel' : undefined}
          maxLength={key === 'phone' ? 40 : key === 'email' ? 254 : 200}
          onChange={(event) => setText((current) => ({ ...current, [key]: event.target.value }))}
          placeholder={placeholder ?? undefined}
          value={text[key]}
        />
      )}
    </Field>
  );

  return (
    <>
      <section aria-label="Company details" className="bg-card rounded-lg border p-4">
        <h2 className="text-heading text-lg font-bold">Company details</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Printed on every invoice, receipt and invoice email. A blank field keeps what is greyed in it.
        </p>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {field('companyName', 'Company name', fallback.brand.name)}
          {field('email', 'Email', fallback.brand.email)}
          {field('addressLine1', 'Address', fallback.brand.addressLine1)}
          {field('phone', 'Phone', fallback.brand.phone)}
          {field('addressLine2', 'Address, second line', fallback.brand.addressLine2)}
        </div>
      </section>

      <section aria-label="New invoices" className="bg-card mt-6 rounded-lg border p-4">
        <h2 className="text-heading text-lg font-bold">New invoices</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          What a new invoice starts with, one at a time or in a batch; each can still be changed on the invoice. A blank
          field takes the latest invoice&apos;s.
        </p>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {field('defaultSubject', 'Subject', fallback.subject)}
          <Field>
            <FieldLabel htmlFor={`${id}-terms`}>Payment terms</FieldLabel>
            <Select disabled={!mayChange} onValueChange={setTerms} value={terms}>
              <SelectTrigger className="w-full" id={`${id}-terms`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="latest">As the latest invoice ({termsLabel(fallback.termsDays)})</SelectItem>
                {PAYMENT_TERMS.map((option) => (
                  <SelectItem key={option.days} value={String(option.days)}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {field('defaultClientMessage', 'Client message', fallback.clientMessage, true)}
          {field('defaultContractDisclaimer', 'Contract / disclaimer', fallback.contractDisclaimer, true)}
        </div>
      </section>

      {mayChange ? (
        <div className="mt-4 flex flex-wrap items-center justify-end gap-3">
          <p aria-live="polite" className={problem ? 'text-destructive text-sm' : 'text-muted-foreground text-sm'}>
            {problem ?? (dirty ? 'Not saved yet.' : '')}
          </p>
          <Button disabled={!dirty || Boolean(problem) || edits.save.isPending} onClick={save}>
            {edits.save.isPending ? 'Saving…' : 'Save settings'}
          </Button>
        </div>
      ) : null}
    </>
  );
}

/** A price as typed, in cents; null when it is not one. */
const cents = (text: string) => parseMoney(text);

function ProductsSection({ view, mayChange }: { view: InvoiceSettingsView; mayChange: boolean }) {
  const id = useId();
  const edits = useInvoiceSettingsEdits();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [price, setPrice] = useState('');
  const [editing, setEditing] = useState<string | null>(null);

  const offered = view.products.filter((product) => product.active);
  const setAside = view.products.filter((product) => !product.active);
  const priceCents = cents(price);
  const problem = !name.trim() && !price.trim() ? null : priceCents === null ? 'Give the price in dollars and cents.' : invoiceProductProblem({ name, unitPriceCents: priceCents });
  const busy = edits.addProducts.isPending || edits.changeProduct.isPending;

  const add = (products: { name: string; description?: string | null; unitPriceCents: number }[], done: string, after?: () => void) =>
    edits.addProducts.mutate(
      { products },
      {
        onSuccess: () => {
          toast.success(done);
          after?.();
        },
        onError: (error) => toast.error('Nothing was added', { description: error.message }),
      },
    );

  const change = (product: InvoiceProductView, input: { name?: string; description?: string | null; unitPriceCents?: number; active?: boolean }, done: string) =>
    edits.changeProduct.mutate(
      { id: product.id, input: { ...input, expectedUpdatedAt: product.updatedAt } },
      {
        onSuccess: () => {
          toast.success(done);
          setEditing(null);
        },
        onError: (error) => toast.error('Nothing was changed', { description: error.message }),
      },
    );

  return (
    <section aria-label="Products and services" className="bg-card mt-6 rounded-lg border p-4">
      <h2 className="text-heading text-lg font-bold">Products &amp; services</h2>
      <p className="text-muted-foreground mt-1 text-sm">
        A new invoice&apos;s lines are priced from this list first, then from what was billed in the past six months.
      </p>

      {offered.length ? (
        <Table className="mt-3">
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Description</TableHead>
              <TableHead className="text-right">Price</TableHead>
              {mayChange ? <TableHead className="w-0" /> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {offered.map((product) =>
              editing === product.id ? (
                <EditRow busy={busy} key={product.id} onCancel={() => setEditing(null)} onSave={(input) => change(product, input, 'Saved')} product={product} />
              ) : (
                <TableRow key={product.id}>
                  <TableCell className="font-medium">{product.name}</TableCell>
                  <TableCell className="text-muted-foreground">{product.description ?? '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(product.unitPriceCents)}</TableCell>
                  {mayChange ? (
                    <TableCell className="whitespace-nowrap text-right">
                      <Button aria-label={`Change ${product.name}`} disabled={busy} onClick={() => setEditing(product.id)} size="sm" variant="ghost">
                        Change
                      </Button>
                      <Button
                        aria-label={`Set aside ${product.name}`}
                        disabled={busy}
                        onClick={() => change(product, { active: false }, `${product.name} set aside`)}
                        size="sm"
                        variant="ghost"
                      >
                        Set aside
                      </Button>
                    </TableCell>
                  ) : null}
                </TableRow>
              ),
            )}
          </TableBody>
        </Table>
      ) : (
        <p className="text-muted-foreground mt-3 text-sm">
          Nothing on the list yet, so new invoices are priced from what was billed.
        </p>
      )}

      {mayChange ? (
        <div className="mt-4 grid gap-3 md:grid-cols-[2fr_3fr_1fr_auto] md:items-end">
          <Field>
            <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
            <Input id={`${id}-name`} maxLength={200} onChange={(event) => setName(event.target.value)} placeholder="A product or service" value={name} />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-description`}>Description (optional)</FieldLabel>
            <Input id={`${id}-description`} maxLength={2000} onChange={(event) => setDescription(event.target.value)} value={description} />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-price`}>Price</FieldLabel>
            <Input className="tabular-nums" id={`${id}-price`} inputMode="decimal" onChange={(event) => setPrice(event.target.value)} placeholder="0.00" value={price} />
          </Field>
          <Button
            disabled={!name.trim() || priceCents === null || Boolean(problem) || busy}
            onClick={() =>
              add([{ name: name.trim(), description: description.trim() || null, unitPriceCents: priceCents! }], `${name.trim()} added`, () => {
                setName('');
                setDescription('');
                setPrice('');
              })
            }
          >
            Add
          </Button>
          {problem ? (
            <FieldDescription aria-live="polite" className="text-destructive md:col-span-4">
              {problem}
            </FieldDescription>
          ) : null}
        </div>
      ) : null}

      {view.billed.length ? (
        <div className="mt-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-heading text-base font-bold">Billed in the past six months, not on the list</h3>
            {mayChange ? (
              <Button
                disabled={busy}
                onClick={() => add(view.billed.slice(0, 50), view.billed.length > 1 ? `${Math.min(50, view.billed.length)} added` : 'Added')}
                size="sm"
                variant="outline"
              >
                Add all {Math.min(50, view.billed.length)}
              </Button>
            ) : null}
          </div>
          <p className="text-muted-foreground mt-1 text-sm">At the price each was billed at most often. Add one to keep its price here.</p>
          <ul className="mt-2 divide-y text-sm">
            {view.billed.map((price) => (
              <li className="flex items-center justify-between gap-3 py-2" key={price.name}>
                <span>{price.name}</span>
                <span className="flex items-center gap-3">
                  <span className="tabular-nums">{formatMoney(price.unitPriceCents)}</span>
                  {mayChange ? (
                    <Button aria-label={`Add ${price.name}`} disabled={busy} onClick={() => add([price], `${price.name} added`)} size="sm" variant="ghost">
                      Add
                    </Button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {setAside.length ? (
        <details className="mt-6">
          <summary className="text-heading cursor-pointer text-base font-bold">Set aside ({setAside.length})</summary>
          <p className="text-muted-foreground mt-1 text-sm">No longer offered on a new invoice. The invoices they priced keep their lines.</p>
          <ul className="mt-2 divide-y text-sm">
            {setAside.map((product) => (
              <li className="flex items-center justify-between gap-3 py-2" key={product.id}>
                <span className="text-muted-foreground">{product.name}</span>
                <span className="flex items-center gap-3">
                  <span className="text-muted-foreground tabular-nums">{formatMoney(product.unitPriceCents)}</span>
                  {mayChange ? (
                    <Button
                      aria-label={`Offer ${product.name} again`}
                      disabled={busy}
                      onClick={() => change(product, { active: true }, `${product.name} offered again`)}
                      size="sm"
                      variant="ghost"
                    >
                      Offer again
                    </Button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

function EditRow({
  product,
  busy,
  onSave,
  onCancel,
}: {
  product: InvoiceProductView;
  busy: boolean;
  onSave: (input: { name: string; description: string | null; unitPriceCents: number }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(product.name);
  const [description, setDescription] = useState(product.description ?? '');
  const [price, setPrice] = useState((product.unitPriceCents / 100).toFixed(2));
  const priceCents = cents(price);
  const problem = priceCents === null ? 'Give the price in dollars and cents.' : invoiceProductProblem({ name, unitPriceCents: priceCents });
  return (
    <TableRow>
      <TableCell>
        <Input aria-label="Name" maxLength={200} onChange={(event) => setName(event.target.value)} value={name} />
      </TableCell>
      <TableCell>
        <Input aria-label="Description" maxLength={2000} onChange={(event) => setDescription(event.target.value)} value={description} />
        {problem ? <p className="text-destructive mt-1 text-xs">{problem}</p> : null}
      </TableCell>
      <TableCell>
        <Input aria-label="Price" className="text-right tabular-nums" inputMode="decimal" onChange={(event) => setPrice(event.target.value)} value={price} />
      </TableCell>
      <TableCell className="whitespace-nowrap text-right">
        <Button
          disabled={Boolean(problem) || busy}
          onClick={() => onSave({ name: name.trim(), description: description.trim() || null, unitPriceCents: priceCents! })}
          size="sm"
        >
          Save
        </Button>
        <Button onClick={onCancel} size="sm" variant="ghost">
          Cancel
        </Button>
      </TableCell>
    </TableRow>
  );
}

/**
 * The files on Jobber's invoices, and how many the console keeps its own copy
 * of (2026-11-06, phase 7). Jobber's links stop working when the office
 * leaves it, so every one must be kept before the cutover. Copied a couple of
 * dozen at a time after each read of Jobber; the ones tried too often wait for
 * somebody to ask again.
 */
function FileCopiesSection({ files, mayChange }: { files: InvoiceFileCopyStatus; mayChange: boolean }) {
  const retry = useRetryFileCopies();
  const count = (value: number) => value.toLocaleString('en-US');
  return (
    <section aria-label="Files from Jobber" className="bg-card mt-6 rounded-lg border p-4">
      <h2 className="text-heading text-lg font-bold">Files from Jobber</h2>
      <p className="text-muted-foreground mt-1 text-sm">
        Jobber&apos;s links to the images and attachments on its invoices stop working when the office leaves it, so the
        console keeps its own copy of each. Every one should be kept before the cutover.
      </p>
      {files.total ? (
        <>
          <p className="mt-3 text-sm">
            <span className="text-heading font-bold tabular-nums">{count(files.kept)}</span> of{' '}
            <span className="tabular-nums">{count(files.total)}</span> kept
            {files.waiting ? <> · {count(files.waiting)} still to copy, a couple of dozen after each read of Jobber</> : null}
            {files.failed ? <> · <span className="text-destructive">{count(files.failed)} could not be copied</span></> : null}
          </p>
          {files.problems.length ? (
            <ul className="text-muted-foreground mt-2 grid gap-0.5 text-xs">
              {files.problems.map((row) => (
                <li key={row.problem}>
                  {row.problem} ({count(row.files)})
                </li>
              ))}
            </ul>
          ) : null}
          {files.failed && mayChange ? (
            <Button
              className="mt-3"
              disabled={retry.isPending}
              onClick={() =>
                retry.mutate(undefined, {
                  onSuccess: () => toast.success('They will be tried again on the next reads of Jobber'),
                  onError: (error) => toast.error('Nothing was changed', { description: error.message }),
                })
              }
              size="sm"
              variant="outline"
            >
              Try the {count(files.failed)} again
            </Button>
          ) : null}
        </>
      ) : (
        <p className="text-muted-foreground mt-3 text-sm">No invoice from Jobber has a file.</p>
      )}
    </section>
  );
}
