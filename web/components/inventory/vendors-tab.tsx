'use client';

import type { SaveVendorInput, VendorRow } from '@texasrenters/shared';
import { TruckIcon } from 'lucide-react';
import { useState, type FormEvent } from 'react';

import { DataTable, DataTableSkeleton, type Column } from '@/components/data-table';
import { VendorDialog } from '@/components/inventory/inventory-dialogs';
import { InUseBadge } from '@/components/inventory/stock-status';
import { EmptyState, ErrorState } from '@/components/states';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { EMPTY } from '@/lib/format';
import { useInventoryEdits, useVendors } from '@/lib/inventory-queries';

/**
 * Vendors (2026-11-19, rebuilt to the approved drawing): who the office buys
 * from. An item can name its usual vendor, a purchase request's quotes are
 * from vendors, and a purchase order goes to one, by email when it has one.
 * A vendor is never deleted, only switched off, so past orders still say who
 * they went to.
 *
 * One read when the tab opens; the search works on the rows in hand. Nothing
 * here sends anything: an order is emailed only from its own page.
 */

const COLUMNS: Array<Column<VendorRow>> = [
  { key: 'name', header: 'Vendor', primary: true, cell: (row) => <span className="font-medium">{row.name}</span> },
  { key: 'contact', header: 'Contact', hideBelow: 'md', cell: (row) => row.contactName ?? EMPTY },
  { key: 'email', header: 'Email', hideBelow: 'lg', cell: (row) => row.email ?? <span className="text-muted-foreground text-xs">No email</span> },
  { key: 'phone', header: 'Phone', hideBelow: 'md', cell: (row) => row.phone ?? EMPTY },
  { key: 'terms', header: 'Terms', hideBelow: 'sm', cell: (row) => row.terms ?? EMPTY },
  { key: 'status', header: 'Status', cell: (row) => <InUseBadge active={row.active} /> },
];

export function VendorsTab({ enabled, canManage }: { enabled: boolean; canManage: boolean }) {
  const vendors = useVendors(enabled);
  const { updateVendor } = useInventoryEdits();
  const [words, setWords] = useState('');
  const [editing, setEditing] = useState<VendorRow | null>(null);

  if (vendors.isError) return <ErrorState error={vendors.error} retry={() => void vendors.refetch()} />;
  if (!vendors.data) return <DataTableSkeleton columns={COLUMNS} label="Loading vendors" rows={3} />;
  const all = vendors.data.vendors;
  const sought = words.trim().toLowerCase();
  const rows = all.filter((row) => !sought || `${row.name} ${row.contactName ?? ''} ${row.email ?? ''}`.toLowerCase().includes(sought));

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <section aria-labelledby="vendors-heading" className="grid gap-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 className="text-base font-semibold" id="vendors-heading">
            Vendors
          </h2>
          <div className="grid w-full gap-1.5 sm:w-64">
            <Label htmlFor="vendors-search">Search vendors</Label>
            <Input id="vendors-search" onChange={(event) => setWords(event.target.value)} placeholder="Name or contact" type="search" value={words} />
          </div>
        </div>
        {rows.length ? (
          <DataTable
            actions={
              canManage
                ? (row) => (
                    <Button aria-label={`Edit ${row.name}`} onClick={() => setEditing(row)} size="sm" variant="outline">
                      Edit
                    </Button>
                  )
                : undefined
            }
            columns={COLUMNS}
            label="Vendors"
            rowKey={(row) => row.id}
            rows={rows}
          />
        ) : (
          <EmptyState
            description={all.length ? 'No vendor matches the search.' : canManage ? 'Add who the office buys stock from, with the form beside this list.' : 'No vendor has been added yet.'}
            icon={TruckIcon}
            title={all.length ? 'Nothing to show' : 'No vendors yet'}
          />
        )}
        <p className="text-muted-foreground text-xs">A vendor is never deleted, only switched off, so past orders still show who they went to. Two vendors cannot share a name.</p>
        <div className="bg-muted/40 grid gap-1.5 rounded-xl border p-4 text-sm">
          <h3 className="font-semibold">Where a vendor is used</h3>
          <ul className="text-muted-foreground grid gap-1">
            <li>
              <span className="text-foreground font-medium">Item codes:</span> an item can name its usual vendor.
            </li>
            <li>
              <span className="text-foreground font-medium">Purchase requests:</span> each quote is from a vendor.
            </li>
            <li>
              <span className="text-foreground font-medium">Purchase orders:</span> the order is emailed to the vendor&apos;s email. With no email, it can be downloaded and sent by hand.
            </li>
            <li>
              <span className="text-foreground font-medium">Xero:</span> a vendor becomes a contact in Xero the first time one of its bills is sent.
            </li>
          </ul>
        </div>
      </section>

      {canManage ? <NewVendor /> : null}
      {editing ? (
        <VendorDialog
          error={updateVendor.error}
          onClose={() => {
            setEditing(null);
            updateVendor.reset();
          }}
          onSave={(input) => updateVendor.mutateAsync({ vendorId: editing.id, input })}
          pending={updateVendor.isPending}
          vendor={editing}
        />
      ) : null}
    </div>
  );
}

const BLANK = { name: '', contactName: '', email: '', phone: '', terms: '', notes: '' };
type Draft = typeof BLANK;
const OPTIONAL: { field: Exclude<keyof Draft, 'name'>; label: string; hint?: string; type?: string; max: number; placeholder?: string }[] = [
  { field: 'contactName', label: 'Contact person', max: 120 },
  { field: 'email', label: 'Email', hint: 'Where purchase orders are sent.', type: 'email', max: 320 },
  { field: 'phone', label: 'Phone', type: 'tel', max: 40 },
  { field: 'terms', label: 'Terms', hint: 'Printed on its purchase orders.', max: 60, placeholder: 'Net 30' },
  { field: 'notes', label: 'Notes', max: 2000 },
];

function NewVendor() {
  const { createVendor } = useInventoryEdits();
  const [draft, setDraft] = useState<Draft>(BLANK);
  const [added, setAdded] = useState<string | null>(null);
  const email = draft.email.trim();
  const problem = !draft.name.trim() ? 'Give the vendor a name.' : email && !/^\S+@\S+\.\S+$/.test(email) ? 'That email does not look right.' : null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (problem || createVendor.isPending) return;
    const input: SaveVendorInput = { name: draft.name.trim() };
    for (const { field } of OPTIONAL) if (draft[field].trim()) input[field] = draft[field].trim();
    try {
      await createVendor.mutateAsync(input);
      setAdded(input.name!);
      setDraft(BLANK);
    } catch {
      // The mutation holds the API's message; it is shown below.
    }
  }

  return (
    <form aria-label="New vendor" className="bg-card grid gap-4 rounded-xl border p-4" onSubmit={(event) => void submit(event)}>
      <h2 className="text-base font-semibold">New vendor</h2>
      <Field>
        <FieldLabel htmlFor="new-vendor-name">Name</FieldLabel>
        <Input
          autoComplete="off"
          id="new-vendor-name"
          maxLength={160}
          onChange={(event) => {
            setDraft((now) => ({ ...now, name: event.target.value }));
            setAdded(null);
          }}
          value={draft.name}
        />
      </Field>
      {OPTIONAL.map(({ field, label, hint, type, max, placeholder }) => (
        <Field key={field}>
          <FieldLabel htmlFor={`new-vendor-${field}`}>
            {label} <span className="text-muted-foreground font-normal">(optional)</span>
          </FieldLabel>
          <Input autoComplete="off" id={`new-vendor-${field}`} maxLength={max} onChange={(event) => setDraft((now) => ({ ...now, [field]: event.target.value }))} placeholder={placeholder} type={type ?? 'text'} value={draft[field]} />
          {hint ? <FieldDescription>{hint}</FieldDescription> : null}
        </Field>
      ))}
      {createVendor.error ? (
        <Alert variant="destructive">
          <AlertDescription>{createVendor.error.message}</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={Boolean(problem) || createVendor.isPending} type="submit">
          {createVendor.isPending ? <Spinner /> : null}
          Add vendor
        </Button>
        <Button
          onClick={() => {
            setDraft(BLANK);
            setAdded(null);
            createVendor.reset();
          }}
          type="button"
          variant="outline"
        >
          Clear
        </Button>
      </div>
      <p aria-live="polite" className="text-muted-foreground text-sm">
        {added && !draft.name ? `${added} is added.` : draft.name || email ? (problem ?? '') : ''}
      </p>
    </form>
  );
}
