'use client';

import { STOCK_CODE, formatMoney, normalizeStockCode, parseMoney, type SaveStockItemInput, type StockCategoryRow, type StockCompany, type StockItemRow, type StockList } from '@texasrenters/shared';
import { PrinterIcon, TagIcon } from 'lucide-react';
import { useState, type FormEvent } from 'react';

import { DataTable, type Column } from '@/components/data-table';
import { PrintLabels } from '@/components/inventory/print-labels';
import { InUseBadge } from '@/components/inventory/stock-status';
import { EmptyState } from '@/components/states';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { EMPTY } from '@/lib/format';
import { useInventoryEdits } from '@/lib/inventory-queries';

/**
 * Item codes (2026-11-19): the stock keeper makes the codes a purchase request
 * picks from. Each has a code, a description, a unit of measure and, if the
 * stock keeper says, a usual price.
 *
 * The code is suggested by the console -- the category's next number -- and
 * can be typed over, like FLT-16251. Left as suggested, the console gives the
 * number itself, so two people adding at once never get the same one. A code
 * is never used twice, and it stays once the item has been requested, ordered
 * or stocked; the server says so, and its sentence is shown here.
 *
 * The rows are the Stock tab's own read: nothing more is asked for, and
 * nothing here calls anything billed.
 */

/** Radix's Select has no empty value: this stands for "none chosen". */
const NONE = 'none';
const dollars = (cents: number) => (cents / 100).toFixed(2);

type LineType = StockList['lineTypes'][number];
/** The type a new item starts as: Item, or the first in use that keeps stock. */
const firstType = (types: readonly LineType[]) => (types.find((type) => type.active && type.code === 'ITEM') ?? types.find((type) => type.active && type.keepsStock) ?? types.find((type) => type.active))?.id ?? NONE;

const COLUMNS: Array<Column<StockItemRow>> = [
  { key: 'code', header: 'Item code', className: 'whitespace-nowrap', cell: (row) => <span className="font-mono font-semibold tabular-nums">{row.code}</span> },
  { key: 'name', header: 'Description', primary: true, cell: (row) => row.name },
  { key: 'unit', header: 'Unit of measure', hideBelow: 'sm', cell: (row) => row.unit },
  { key: 'type', header: 'Type', hideBelow: 'md', cell: (row) => row.lineType?.name ?? EMPTY },
  { key: 'price', header: 'Price', numeric: true, cell: (row) => (row.priceCents === null ? <span className="text-muted-foreground text-xs">No price</span> : formatMoney(row.priceCents)) },
  { key: 'category', header: 'Category', hideBelow: 'md', cell: (row) => row.category?.name ?? EMPTY },
  { key: 'company', header: 'Company', hideBelow: 'lg', cell: (row) => row.company?.name ?? EMPTY },
  { key: 'status', header: 'Status', hideBelow: 'sm', cell: (row) => <InUseBadge active={row.active} /> },
];

interface Draft {
  categoryId: string;
  /** One of the office's line types; NONE until there is one. */
  lineTypeId: string;
  company: string;
  code: string;
  name: string;
  unit: string;
  price: string;
}

/** What the fields hold, as the request; or why it cannot be sent yet. */
function read(draft: Draft, needsCompany: boolean): { problem: string } | { fields: { code: string; name: string; unit: string; priceCents: number | null } } {
  const code = normalizeStockCode(draft.code);
  if (draft.categoryId === NONE) return { problem: 'Choose a category.' };
  if (needsCompany && draft.company === NONE) return { problem: 'Choose the company it is bought for.' };
  if (!STOCK_CODE.test(code)) return { problem: 'An item code is 2 to 24 capitals, digits and dashes, like FLT-16251.' };
  if (!draft.name.trim()) return { problem: 'Give it a description.' };
  if (!draft.unit.trim()) return { problem: 'Say what it is counted in: pcs, pack, box.' };
  const priceCents = draft.price.trim() ? parseMoney(draft.price) : null;
  if (draft.price.trim() && priceCents === null) return { problem: 'A price is an amount, like 3.42.' };
  return { fields: { code, name: draft.name.trim(), unit: draft.unit.trim(), priceCents } };
}

function Fields({ draft, set, categories, companies, lineTypes, suggested, fixedCategory, prefix }: { draft: Draft; set: (next: Partial<Draft>) => void; categories: readonly StockCategoryRow[]; companies: readonly StockCompany[]; lineTypes: readonly LineType[]; suggested: string | null; fixedCategory: boolean; prefix: string }) {
  return (
    <>
      <Field>
        <FieldLabel htmlFor={`${prefix}-category`}>Category</FieldLabel>
        <Select disabled={fixedCategory} onValueChange={(categoryId) => set({ categoryId })} value={draft.categoryId}>
          <SelectTrigger id={`${prefix}-category`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>Choose a category</SelectItem>
            {categories.map((category) => (
              <SelectItem key={category.id} value={category.id}>
                {category.name} ({category.prefix})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldDescription>{fixedCategory ? 'An item keeps its category.' : 'Groups the item and starts its code.'}</FieldDescription>
      </Field>
      {lineTypes.length ? (
        <Field>
          <FieldLabel htmlFor={`${prefix}-type`}>Type</FieldLabel>
          <Select onValueChange={(lineTypeId) => set({ lineTypeId })} value={draft.lineTypeId}>
            <SelectTrigger id={`${prefix}-type`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {lineTypes
                .filter((type) => type.active || type.id === draft.lineTypeId)
                .map((type) => (
                  <SelectItem key={type.id} value={type.id}>
                    {type.name} ({type.code}){type.keepsStock ? '' : ', keeps no stock'}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
          <FieldDescription>What it is on a requisition line. A type that keeps no stock, like a service, is never received into a place or counted.</FieldDescription>
        </Field>
      ) : null}
      {companies.length ? (
        <Field>
          <FieldLabel htmlFor={`${prefix}-company`}>Company</FieldLabel>
          <Select onValueChange={(company) => set({ company })} value={draft.company}>
            <SelectTrigger id={`${prefix}-company`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Choose a company</SelectItem>
              {companies.map((company) => (
                <SelectItem key={company.tenantId} value={company.tenantId}>
                  {company.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldDescription>A purchase request is for one company, and offers that company&apos;s items.</FieldDescription>
        </Field>
      ) : null}
      <Field>
        <FieldLabel htmlFor={`${prefix}-code`}>Item code</FieldLabel>
        <Input autoCapitalize="characters" autoComplete="off" className="font-mono" id={`${prefix}-code`} maxLength={24} onChange={(event) => set({ code: event.target.value.toUpperCase() })} value={draft.code} />
        <FieldDescription>{suggested ? `Suggested: ${suggested}, the next number. Type your own over it, like FLT-16251.` : 'Capitals, digits and dashes, like FLT-16251.'}</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor={`${prefix}-name`}>Description</FieldLabel>
        <Input autoComplete="off" id={`${prefix}-name`} maxLength={160} onChange={(event) => set({ name: event.target.value })} placeholder="Filter 16x25x1" value={draft.name} />
        <FieldDescription>The name people see beside the code.</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor={`${prefix}-unit`}>Unit of measure</FieldLabel>
        <Input autoComplete="off" id={`${prefix}-unit`} maxLength={30} onChange={(event) => set({ unit: event.target.value })} placeholder="pcs" value={draft.unit} />
        <FieldDescription>How it is counted: pcs, pack, box, bottle.</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor={`${prefix}-price`}>
          Price <span className="text-muted-foreground font-normal">(optional)</span>
        </FieldLabel>
        <Input autoComplete="off" id={`${prefix}-price`} inputMode="decimal" onChange={(event) => set({ price: event.target.value })} placeholder="0.00" value={draft.price} />
        <FieldDescription>What one usually costs. It fills the cost on a purchase request line, where it can be changed.</FieldDescription>
      </Field>
    </>
  );
}

export function ItemCodesTab({ items, categories, companies, lineTypes = [], canManage }: { items: readonly StockItemRow[]; categories: readonly StockCategoryRow[]; companies: readonly StockCompany[]; lineTypes?: readonly LineType[]; canManage: boolean }) {
  const [words, setWords] = useState('');
  const [editing, setEditing] = useState<StockItemRow | null>(null);
  const [printing, setPrinting] = useState(false);
  const sought = words.trim().toLowerCase();
  const rows = items.filter((row) => !sought || `${row.code} ${row.name} ${row.category?.name ?? ''}`.toLowerCase().includes(sought));
  const inUse = categories.filter((category) => category.active);

  if (printing) return <PrintLabels items={items} onBack={() => setPrinting(false)} />;

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <section aria-labelledby="item-codes-heading" className="grid gap-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 className="text-base font-semibold" id="item-codes-heading">
            Item codes
          </h2>
          <div className="flex w-full flex-wrap items-end gap-3 sm:w-auto">
            <div className="grid w-full gap-1.5 sm:w-64">
              <Label htmlFor="item-codes-search">Search item codes</Label>
              <Input id="item-codes-search" onChange={(event) => setWords(event.target.value)} placeholder="Code or description, or scan a label" type="search" value={words} />
            </div>
            <Button disabled={!items.some((item) => item.active)} onClick={() => setPrinting(true)} type="button" variant="outline">
              <PrinterIcon aria-hidden="true" />
              Print labels
            </Button>
          </div>
        </div>
        {rows.length ? (
          <DataTable
            actions={
              canManage
                ? (row) => (
                    <Button aria-label={`Edit ${row.code}`} onClick={() => setEditing(row)} size="sm" variant="outline">
                      Edit
                    </Button>
                  )
                : undefined
            }
            columns={COLUMNS}
            label="Item codes"
            rowKey={(row) => row.id}
            rows={rows}
          />
        ) : (
          <EmptyState
            description={items.length ? 'No item code matches the search.' : canManage ? 'Add the first one with the form beside this list. A purchase request picks from these.' : 'The stock keeper has not added any item code yet.'}
            icon={TagIcon}
            title={items.length ? 'Nothing to show' : 'No item codes yet'}
          />
        )}
        <p className="text-muted-foreground text-xs">
          A code is never used twice. Once an item has been requested, ordered or stocked, its code stays; the description, unit and price can still be changed. A purchase request picks an item by its code, and
          the description, unit and price come with it.
        </p>
      </section>

      {canManage ? <NewItemCode categories={inUse} companies={companies} lineTypes={lineTypes} /> : null}
      {editing ? <EditItemCode categories={categories} companies={companies} item={editing} lineTypes={lineTypes} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}

function NewItemCode({ categories, companies, lineTypes }: { categories: readonly StockCategoryRow[]; companies: readonly StockCompany[]; lineTypes: readonly LineType[] }) {
  const { createItem } = useInventoryEdits();
  const blank = (): Draft => ({ categoryId: categories.length === 1 ? categories[0]!.id : NONE, lineTypeId: firstType(lineTypes), company: companies.length === 1 ? companies[0]!.tenantId : NONE, code: '', name: '', unit: 'pcs', price: '' });
  const [draft, setDraft] = useState<Draft>(blank);
  /** True once the stock keeper has typed in the code field: until then it follows the category's suggestion. */
  const [typed, setTyped] = useState(false);
  const [added, setAdded] = useState<string | null>(null);

  const category = categories.find((option) => option.id === draft.categoryId);
  const suggested = category?.nextCode ?? null;
  const shown: Draft = { ...draft, code: typed ? draft.code : (suggested ?? '') };
  const result = read(shown, companies.length > 0);

  const set = (next: Partial<Draft>) => {
    if (next.code !== undefined) setTyped(next.code.trim() !== '');
    setDraft((now) => ({ ...now, ...next }));
    setAdded(null);
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    if ('problem' in result || createItem.isPending) return;
    const { code, name, unit, priceCents } = result.fields;
    const input: SaveStockItemInput = {
      name,
      unit,
      categoryId: draft.categoryId,
      priceCents,
      ...(draft.lineTypeId !== NONE ? { lineTypeId: draft.lineTypeId } : {}),
      ...(companies.length ? { xeroTenantId: draft.company } : {}),
      // Left as suggested, the console gives the number itself, so two people adding at once never get the same one.
      ...(typed && code !== suggested ? { code } : {}),
    };
    try {
      const made = await createItem.mutateAsync(input);
      setAdded(made.item.code);
      setDraft((now) => ({ ...blank(), categoryId: now.categoryId, company: now.company, unit: now.unit, lineTypeId: now.lineTypeId }));
      setTyped(false);
    } catch {
      // The mutation holds the API's message; it is shown below.
    }
  }

  return (
    <form aria-label="New item code" className="bg-card grid gap-4 rounded-xl border p-4" onSubmit={(event) => void submit(event)}>
      <h2 className="text-base font-semibold">New item code</h2>
      {categories.length ? (
        <>
          <Fields categories={categories} companies={companies} draft={shown} fixedCategory={false} lineTypes={lineTypes} prefix="new-code" set={set} suggested={suggested} />
          {createItem.error ? (
            <Alert variant="destructive">
              <AlertDescription>{createItem.error.message}</AlertDescription>
            </Alert>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <Button disabled={'problem' in result || createItem.isPending} type="submit">
              {createItem.isPending ? <Spinner /> : null}
              Add item code
            </Button>
            <Button
              onClick={() => {
                setDraft(blank());
                setTyped(false);
                setAdded(null);
                createItem.reset();
              }}
              type="button"
              variant="outline"
            >
              Clear
            </Button>
          </div>
          <p aria-live="polite" className="text-muted-foreground text-sm">
            {added && !draft.name ? `${added} is added.` : 'problem' in result ? result.problem : ''}
          </p>
        </>
      ) : (
        <p className="text-muted-foreground text-sm">Add a category first, on the Categories tab. It groups the items and starts their codes.</p>
      )}
    </form>
  );
}

function EditItemCode({ item, categories, companies, lineTypes, onClose }: { item: StockItemRow; categories: readonly StockCategoryRow[]; companies: readonly StockCompany[]; lineTypes: readonly LineType[]; onClose: () => void }) {
  const { updateItem } = useInventoryEdits();
  const [draft, setDraft] = useState<Draft>({ categoryId: item.category?.id ?? NONE, lineTypeId: item.lineType?.id ?? firstType(lineTypes), company: item.company?.tenantId ?? NONE, code: item.code, name: item.name, unit: item.unit, price: item.priceCents === null ? '' : dollars(item.priceCents) });
  // An item made before categories, or before companies, is not held to choosing one here.
  const result = read({ ...draft, categoryId: item.category ? draft.categoryId : 'kept' }, false);
  const options = categories.filter((category) => category.active || category.id === item.category?.id);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if ('problem' in result || updateItem.isPending) return;
    const { code, name, unit, priceCents } = result.fields;
    const input: SaveStockItemInput = {
      name,
      unit,
      priceCents,
      // Only what changed of the code, the category and the company: the server refuses a change it must, and says why.
      ...(code !== item.code ? { code } : {}),
      ...(draft.lineTypeId !== NONE && draft.lineTypeId !== (item.lineType?.id ?? NONE) ? { lineTypeId: draft.lineTypeId } : {}),
      ...(!item.category && draft.categoryId !== NONE ? { categoryId: draft.categoryId } : {}),
      ...(companies.length && draft.company !== (item.company?.tenantId ?? NONE) ? { xeroTenantId: draft.company === NONE ? null : draft.company } : {}),
    };
    try {
      await updateItem.mutateAsync({ itemId: item.id, input });
      onClose();
    } catch {
      // The mutation holds the API's message; it is shown below.
    }
  }

  return (
    <Dialog onOpenChange={(open) => (open ? undefined : onClose())} open>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit {item.code}</DialogTitle>
          <DialogDescription>The description, unit and price can be changed any time. The code can be changed only while nothing has requested, ordered or stocked the item.</DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
          <Fields categories={options} companies={companies} draft={draft} fixedCategory={Boolean(item.category)} lineTypes={lineTypes} prefix="edit-code" set={(next) => setDraft((now) => ({ ...now, ...next }))} suggested={null} />
          {'problem' in result ? <FieldError>{result.problem}</FieldError> : null}
          {updateItem.error ? (
            <Alert variant="destructive">
              <AlertDescription>{updateItem.error.message}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button onClick={onClose} type="button" variant="outline">
              Cancel
            </Button>
            <Button disabled={'problem' in result || updateItem.isPending} type="submit">
              {updateItem.isPending ? <Spinner /> : null}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
