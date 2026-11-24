'use client';

import {
  STOCK_ITEM_DELETE_REASONS,
  STOCK_ITEM_DELETE_REASON_LABEL,
  STOCK_REMOVAL_REASONS,
  STOCK_REMOVAL_REASON_LABEL,
  normalizeStockCode,
  type StockItemDeleteReason,
  type StockItemDocument,
  type StockItemRow,
  type StockRemovalReason,
} from '@texasrenters/shared';
import Link from 'next/link';
import { Fragment, useId, useState, type FormEvent } from 'react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { formatCount } from '@/lib/format';
import { useInventoryEdits, useStockItem, useStockItemDeletion } from '@/lib/inventory-queries';

/**
 * Removing stock and deleting an item code (2026-11-24, from the approved
 * RemoveStock and DeleteItem boards of the Inventory Screens canvas).
 *
 * Remove stock takes it off the books with a reason -- tested with, damaged,
 * lost -- as one more line in the item's history, which Reverse puts back.
 * Delete item code reads first what it would do: an item nothing names is
 * taken out completely; one that has been used has its stock removed, leaves
 * every list and gives its code up, and the papers that named it keep it,
 * marked deleted. While it is still on something open it is not deleted, and
 * the page says where.
 *
 * Each dialog is mounted only while it is open, so it starts from what is saved.
 */

const EVERY = 'every';
/** A whole number of units, or null while the field does not hold one. */
const whole = (value: string) => (/^\d+$/.test(value.trim()) ? Number(value.trim()) : null);

function Reasons<Reason extends string>({ reasons, labels, value, onChange }: { reasons: readonly Reason[]; labels: Record<Reason, string>; value: Reason; onChange: (reason: Reason) => void }) {
  const name = useId();
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-sm font-medium">Reason</legend>
      {reasons.map((reason) => (
        <label className="flex items-center gap-2 text-sm" key={reason}>
          <input checked={value === reason} className="accent-primary size-4" name={name} onChange={() => onChange(reason)} type="radio" value={reason} />
          {reason === 'OTHER' ? 'Other, say why' : labels[reason]}
        </label>
      ))}
    </fieldset>
  );
}

function NoteField({ id, value, onChange, required }: { id: string; value: string; onChange: (value: string) => void; required: boolean }) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{required ? 'Why' : 'Note'}</FieldLabel>
      <Input autoComplete="off" id={id} maxLength={500} onChange={(event) => onChange(event.target.value)} required={required} value={value} />
      <FieldDescription>{required ? 'Say why, for Other.' : 'Optional. Kept with the reason and your name.'}</FieldDescription>
    </Field>
  );
}

// ── Remove stock ─────────────────────────────────────────────────────────────

export function RemoveStockDialog({ itemId, onClose }: { itemId: string; onClose: () => void }) {
  // The item's own page has this read already; from the Stock tab it is one read, of this item only.
  const detail = useStockItem(itemId);
  const { removeStock } = useInventoryEdits();
  const [from, setFrom] = useState<string | null>(null);
  /** What was typed in How many; null while it shows all of the place. */
  const [typed, setTyped] = useState<string | null>(null);
  const [reason, setReason] = useState<StockRemovalReason>('TESTING');
  const [note, setNote] = useState('');
  // One key for this opening of the form: a second click or a retry takes nothing twice.
  const [requestKey] = useState(() => crypto.randomUUID());

  const data = detail.data;
  const levels = (data?.levels ?? []).filter((level) => level.quantity > 0);
  const total = levels.reduce((sum, level) => sum + level.quantity, 0);
  const place = from ?? levels[0]?.placeId ?? EVERY;
  const every = place === EVERY;
  const level = levels.find((one) => one.placeId === place);
  const held = every ? total : (level?.quantity ?? 0);
  const quantity = every ? total : typed === null ? held : whole(typed);
  const tooMany = quantity !== null && quantity > held;
  const needsNote = reason === 'OTHER' && !note.trim();
  const invalid = !data || !held || !quantity || tooMany || needsNote;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (invalid || removeStock.isPending) return;
    try {
      await removeStock.mutateAsync({ itemId, input: { placeId: every ? null : place, quantity: quantity!, reason, note: note.trim() || null, requestKey } });
      onClose();
    } catch {
      // The mutation holds the API's message; it is shown below.
    }
  }

  return (
    <Dialog onOpenChange={(open) => (open ? undefined : onClose())} open>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{data ? `Remove stock of ${data.item.code}` : 'Remove stock'}</DialogTitle>
          <DialogDescription>It comes off the books with the reason given, as a line in the item&apos;s history. Reverse puts it back if it was a mistake.</DialogDescription>
        </DialogHeader>
        {detail.isLoading ? (
          <p className="text-muted-foreground flex items-center gap-2 text-sm">
            <Spinner /> Reading where it is kept…
          </p>
        ) : detail.isError || !data ? (
          <Alert variant="destructive">
            <AlertDescription>{detail.error?.message ?? 'The item could not be read.'}</AlertDescription>
          </Alert>
        ) : !total ? (
          <>
            <Alert>
              <AlertDescription>There is none of {data.item.code} anywhere to remove.</AlertDescription>
            </Alert>
            <DialogFooter>
              <Button onClick={onClose} type="button" variant="outline">
                Close
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
            <Field>
              <FieldLabel htmlFor="remove-from">From</FieldLabel>
              <Select
                onValueChange={(next) => {
                  setFrom(next);
                  setTyped(null);
                }}
                value={place}
              >
                <SelectTrigger className="w-full" id="remove-from">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {levels.map((one) => (
                    <SelectItem key={one.placeId} value={one.placeId}>
                      {one.placeName} · {formatCount(one.quantity)} on hand
                    </SelectItem>
                  ))}
                  {levels.length > 1 ? <SelectItem value={EVERY}>Every place · {formatCount(total)} on hand</SelectItem> : null}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="remove-quantity">How many, in {data.item.unit}</FieldLabel>
              <div className="flex gap-2">
                <Input
                  className="w-32 text-right"
                  disabled={every}
                  id="remove-quantity"
                  inputMode="numeric"
                  onChange={(event) => setTyped(event.target.value)}
                  required
                  value={every ? String(total) : (typed ?? String(held))}
                />
                {every ? null : (
                  <Button disabled={typed === null} onClick={() => setTyped(null)} type="button" variant="outline">
                    All {formatCount(held)}
                  </Button>
                )}
              </div>
              <FieldDescription>{every ? 'From every place, all of it.' : 'No more than the place holds.'}</FieldDescription>
              <FieldError>
                {typed !== null && typed.trim() && !quantity ? 'A whole number, 1 or more.' : tooMany ? `${level?.placeName ?? 'That place'} has ${formatCount(held)} of ${data.item.code}.` : null}
              </FieldError>
            </Field>
            <Reasons labels={STOCK_REMOVAL_REASON_LABEL} onChange={setReason} reasons={STOCK_REMOVAL_REASONS} value={reason} />
            <NoteField id="remove-note" onChange={setNote} required={reason === 'OTHER'} value={note} />
            {quantity && !tooMany ? (
              <p className="text-muted-foreground text-sm">
                {every
                  ? `${levels.map((one) => `${one.placeName} goes from ${formatCount(one.quantity)} to 0`).join(', ')}.`
                  : `${level?.placeName ?? 'It'} goes from ${formatCount(held)} to ${formatCount(held - quantity)}.`}{' '}
                Stock value goes down by what {quantity === 1 ? 'it' : 'they'} cost.
              </p>
            ) : null}
            {removeStock.error ? (
              <Alert variant="destructive">
                <AlertDescription>{removeStock.error.message}</AlertDescription>
              </Alert>
            ) : null}
            <DialogFooter>
              <Button onClick={onClose} type="button" variant="outline">
                Cancel
              </Button>
              <Button disabled={invalid || removeStock.isPending} type="submit" variant="destructive">
                {removeStock.isPending ? <Spinner /> : null}
                Remove {quantity && !tooMany ? formatCount(quantity) : ''}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Delete an item code ──────────────────────────────────────────────────────

/** Where a document is opened: its own page, or the tab that holds it. A receipt is on its order's page. */
function documentHref(document: StockItemDocument): string | null {
  if (document.kind === 'REQUISITION') return `/purchasing/requisitions/${document.id}`;
  if (document.kind === 'ORDER') return `/purchasing/orders/${document.id}`;
  if (document.kind === 'COUNT') return `/inventory/counts/${document.id}`;
  if (document.kind === 'TRUCK_ASK') return '/inventory?tab=withdrawals';
  return null;
}

function Documents({ documents }: { documents: readonly StockItemDocument[] }) {
  return (
    <>
      {documents.map((document, index) => {
        const href = documentHref(document);
        return (
          <Fragment key={`${document.kind}:${document.id}`}>
            {index ? ', ' : ''}
            {href ? (
              <Link className="font-medium underline underline-offset-4" href={href}>
                {document.number}
              </Link>
            ) : (
              <span className="font-medium">{document.number}</span>
            )}
          </Fragment>
        );
      })}
    </>
  );
}

export function DeleteItemDialog({ item, onClose }: { item: StockItemRow; onClose: () => void }) {
  // Read as the dialog opens, never kept: what names the item can change any minute.
  const deletion = useStockItemDeletion(item.id);
  const { deleteItem } = useInventoryEdits();
  const [reason, setReason] = useState<StockItemDeleteReason>('TESTING');
  const [note, setNote] = useState('');
  const [typed, setTyped] = useState('');

  const data = deletion.data;
  const blocked = Boolean(data?.open.length);
  const confirmed = normalizeStockCode(typed) === item.code;
  const needsNote = reason === 'OTHER' && !note.trim();
  const invalid = !data || blocked || !confirmed || needsNote;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (invalid || deleteItem.isPending) return;
    try {
      await deleteItem.mutateAsync({ itemId: item.id, input: { reason, note: note.trim() || null, confirmCode: typed } });
      onClose();
    } catch {
      // The mutation holds the API's message; it is shown below.
    }
  }

  return (
    <Dialog onOpenChange={(open) => (open ? undefined : onClose())} open>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Delete {item.code} · {item.name}?
          </DialogTitle>
          <DialogDescription>This cannot be undone. It goes in the audit log with the reason and your name.</DialogDescription>
        </DialogHeader>
        {deletion.isLoading ? (
          <p className="text-muted-foreground flex items-center gap-2 text-sm">
            <Spinner /> Looking at where {item.code} is used…
          </p>
        ) : deletion.isError || !data ? (
          <Alert variant="destructive">
            <AlertDescription>{deletion.error?.message ?? 'It could not be read.'}</AlertDescription>
          </Alert>
        ) : blocked ? (
          <>
            <Alert variant="destructive">
              <AlertDescription>
                <span>
                  {item.code} is still on <Documents documents={data.open} />. Finish or cancel {data.open.length === 1 ? 'that' : 'those'} first.
                </span>
              </AlertDescription>
            </Alert>
            <DialogFooter>
              <Button onClick={onClose} type="button" variant="outline">
                Close
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
            {data.neverUsed ? (
              <p className="text-sm">Nothing names it: no stock, no requisition, order, slip or count. It is taken out completely, and {item.code} is free again.</p>
            ) : (
              <ul className="grid list-disc gap-1.5 pl-5 text-sm">
                {data.onHand.length ? (
                  <li>
                    <strong>{data.onHand.map((one) => `${formatCount(one.quantity)} in ${one.placeName}`).join(', ')}</strong> {data.onHand.length === 1 && data.onHand[0]!.quantity === 1 ? 'is' : 'are'} removed
                    first, with the reason below.
                  </li>
                ) : null}
                <li>It leaves Item codes, Stock, the requisition and order pickers, Print labels and the phone.</li>
                <li>{item.code} can be given to a new item.</li>
                {data.usedOn.length ? (
                  <li>
                    Still shown, marked deleted, where it was used: <Documents documents={data.usedOn} />
                    {data.usedOnMore ? ` and ${formatCount(data.usedOnMore)} more` : ''}. Their totals do not change.
                  </li>
                ) : null}
              </ul>
            )}
            <Reasons labels={STOCK_ITEM_DELETE_REASON_LABEL} onChange={setReason} reasons={STOCK_ITEM_DELETE_REASONS} value={reason} />
            <NoteField id="delete-note" onChange={setNote} required={reason === 'OTHER'} value={note} />
            <Field>
              <FieldLabel htmlFor="delete-confirm">Type {item.code} to confirm</FieldLabel>
              <Input autoCapitalize="characters" autoComplete="off" id="delete-confirm" onChange={(event) => setTyped(event.target.value)} spellCheck={false} value={typed} />
            </Field>
            {deleteItem.error ? (
              <Alert variant="destructive">
                <AlertDescription>{deleteItem.error.message}</AlertDescription>
              </Alert>
            ) : null}
            <DialogFooter>
              <Button onClick={onClose} type="button" variant="outline">
                Cancel
              </Button>
              <Button disabled={invalid || deleteItem.isPending} type="submit" variant="destructive">
                {deleteItem.isPending ? <Spinner /> : null}
                Delete {item.code}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
