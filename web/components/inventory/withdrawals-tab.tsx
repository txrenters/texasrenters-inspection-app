'use client';

import {
  MOST_SLIP_LINES,
  STOCK_SLIP_KINDS,
  STOCK_SLIP_KIND_LABEL,
  formatMoney,
  stockSlipProblem,
  type StockSlipChoices,
  type StockSlipKind,
  type StockSlipRow,
} from '@texasrenters/shared';
import { ArrowRightIcon, ClipboardListIcon, PlusIcon, XIcon } from 'lucide-react';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';

import { ScanField } from '@/components/inventory/scan-field';

import { DataTable, DataTableSkeleton, type Column } from '@/components/data-table';
import { EmptyState, ErrorState } from '@/components/states';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { EMPTY, formatCount, formatDay } from '@/lib/format';
import { useStockSlipChoices, useStockSlipEdits, useStockSlips } from '@/lib/inventory-queries';

/**
 * Withdrawals, returns and moves (2026-11-19, phase 5). The office records
 * what a technician took for a visit or a van, what came back, and stock moved
 * between places. A slip is posted whole and never edited: a wrong one is
 * reversed, with a reason.
 *
 * The form says why a slip cannot be posted with the server's own sentence
 * (`stockSlipProblem`), from what is on hand in the place it leaves. It reads
 * when the tab opens and when the technician changes, and nothing here calls
 * anything billed.
 */

/** Radix's Select has no empty value: this stands for "none chosen". */
const NONE = 'none';
const chosen = (value: string) => (value === NONE ? null : value);
const whole = (value: string) => (/^\d+$/.test(value.trim()) ? Number(value.trim()) : null);

const KIND_ACTION: Record<StockSlipKind, string> = { WITHDRAWAL: 'Take out', RETURN: 'Bring back', TRANSFER: 'Move between places' };
const POST_LABEL: Record<StockSlipKind, string> = { WITHDRAWAL: 'Post withdrawal', RETURN: 'Post return', TRANSFER: 'Post move' };

export function WithdrawalsTab({ canWithdraw, technicianId }: { canWithdraw: boolean; /** Only this technician's slips: opened from "Materials used, by technician". */ technicianId?: string }) {
  const slips = useStockSlips(true, technicianId || undefined);
  const only = technicianId ? (slips.data?.slips.find((slip) => slip.technician?.id === technicianId)?.technician?.name ?? 'this technician') : null;
  const [reversing, setReversing] = useState<StockSlipRow | null>(null);

  return (
    <div className="grid gap-6">
      {canWithdraw ? <SlipForm /> : null}
      <section aria-labelledby="slips-heading" className="grid gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-semibold" id="slips-heading">
            {only ? `Latest slips of ${only}` : 'Latest slips'}
          </h2>
          {only ? (
            <Link className="text-sm underline underline-offset-4" href="/inventory?tab=withdrawals">
              Show everybody&apos;s
            </Link>
          ) : null}
        </div>
        {slips.isError ? (
          <ErrorState error={slips.error} retry={() => void slips.refetch()} />
        ) : !slips.data ? (
          <DataTableSkeleton columns={SLIP_COLUMNS} label="Loading slips" rows={4} />
        ) : !slips.data.slips.length ? (
          <EmptyState
            description={canWithdraw ? 'Record the first one above: what a technician took, from where, and for which visit.' : 'Nothing has been taken out, brought back or moved yet.'}
            icon={ClipboardListIcon}
            title="No slips yet"
          />
        ) : (
          <DataTable
            actions={
              canWithdraw
                ? (row) =>
                    row.reversed ? null : (
                      <Button aria-label={`Reverse ${row.number}`} onClick={() => setReversing(row)} size="sm" variant="outline">
                        Reverse
                      </Button>
                    )
                : undefined
            }
            columns={SLIP_COLUMNS}
            label="Withdrawals, returns and moves"
            rowKey={(row) => row.id}
            rows={slips.data.slips}
          />
        )}
      </section>
      {reversing ? <ReverseSlipDialog onClose={() => setReversing(null)} slip={reversing} /> : null}
    </div>
  );
}

// ── The list ──────────────────────────────────────────────────────────────

const SLIP_COLUMNS: Array<Column<StockSlipRow>> = [
  {
    key: 'number',
    header: 'Slip',
    className: 'whitespace-nowrap',
    cell: (row) => (
      <span className="grid gap-0.5">
        <span className="font-medium">{row.number}</span>
        <span className="text-muted-foreground text-xs">{formatDay(row.day)}</span>
      </span>
    ),
  },
  {
    key: 'what',
    header: 'What',
    primary: true,
    cell: (row) => (
      <span className="grid gap-0.5">
        <span className="flex flex-wrap items-center gap-2 font-medium">
          {STOCK_SLIP_KIND_LABEL[row.kind]}
          {row.reversed ? <Badge variant="outline">Reversed</Badge> : null}
        </span>
        {row.lines.map((line) => (
          <span className="text-muted-foreground text-xs" key={line.itemCode}>
            {formatCount(line.quantity)} × {line.itemCode} {line.itemName}
          </span>
        ))}
        {row.note ? <span className="text-muted-foreground text-xs">{row.note}</span> : null}
        {row.reversed ? (
          <span className="text-muted-foreground text-xs">
            Reversed by {row.reversed.by}: {row.reversed.reason}
          </span>
        ) : null}
      </span>
    ),
  },
  { key: 'who', header: 'Technician', hideBelow: 'sm', cell: (row) => row.technician?.name ?? EMPTY },
  {
    key: 'where',
    header: 'Place',
    hideBelow: 'md',
    cell: (row) =>
      row.from && row.to ? (
        <span className="inline-flex flex-wrap items-center gap-1">
          {row.from.name} <ArrowRightIcon aria-label="to" className="size-3.5" /> {row.to.name}
        </span>
      ) : (
        (row.from?.name ?? row.to?.name ?? EMPTY)
      ),
  },
  {
    key: 'visit',
    header: 'Visit',
    hideBelow: 'lg',
    cell: (row) =>
      row.visit ? (
        <span className="grid gap-0.5">
          <span>{row.visit.title}</span>
          {row.visit.address ? <span className="text-muted-foreground text-xs">{row.visit.address}</span> : null}
        </span>
      ) : (
        EMPTY
      ),
  },
  { key: 'cost', header: 'At cost', numeric: true, hideBelow: 'md', cell: (row) => formatMoney(row.costCents) },
  { key: 'by', header: 'Recorded by', hideBelow: 'xl', cell: (row) => row.by },
];

// ── The form ──────────────────────────────────────────────────────────────

interface Line {
  key: number;
  itemId: string;
  quantity: string;
}

function SlipForm() {
  const [kind, setKind] = useState<StockSlipKind>('WITHDRAWAL');
  const [technicianId, setTechnicianId] = useState(NONE);
  const [fromPlaceId, setFromPlaceId] = useState(NONE);
  const [toPlaceId, setToPlaceId] = useState(NONE);
  const [inspectionId, setInspectionId] = useState(NONE);
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<Line[]>([{ key: 0, itemId: NONE, quantity: '' }]);
  const [nextKey, setNextKey] = useState(1);
  // One key a slip: a second click or a retry posts nothing twice. A new one once it has posted.
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  const [posted, setPosted] = useState<string | null>(null);

  const move = kind === 'TRANSFER';
  const choices = useStockSlipChoices(true, move ? null : chosen(technicianId));
  const { post } = useStockSlipEdits();

  if (choices.isError) return <ErrorState error={choices.error} retry={() => void choices.refetch()} />;
  if (!choices.data)
    return (
      <div aria-label="Loading the form" className="text-muted-foreground flex items-center gap-2 text-sm" role="status">
        <Spinner /> Loading
      </div>
    );
  const data: StockSlipChoices = choices.data;

  const leaves = kind === 'RETURN' ? null : chosen(fromPlaceId);
  const there = new Map(data.levels.filter((level) => level.placeId === leaves).map((level) => [level.itemId, level.quantity]));
  const itemOf = new Map(data.items.map((item) => [item.id, item]));
  const filled = lines.filter((line) => line.itemId !== NONE);
  const unreadable = filled.some((line) => !whole(line.quantity));
  const slip = {
    kind,
    technicianId: move ? null : chosen(technicianId),
    fromPlaceId: leaves,
    toPlaceId: kind === 'WITHDRAWAL' ? null : chosen(toPlaceId),
    lines: filled.map((line) => ({ itemId: line.itemId, quantity: whole(line.quantity) ?? 0 })),
  };
  const problem = stockSlipProblem(slip, there, (itemId) => itemOf.get(itemId)?.code ?? 'that item') ?? (unreadable ? 'Give each item a whole number of units.' : null);
  const taken = new Set(filled.map((line) => line.itemId));

  const change = (key: number, next: Partial<Line>) => setLines((all) => all.map((line) => (line.key === key ? { ...line, ...next } : line)));
  /** A scanned label: one more of an item already on the slip, else the item on the first empty row or a new one. */
  const scan = (item: { id: string; code: string }): string | void => {
    if (leaves && !there.get(item.id)) return `${item.code} is not in that place.`;
    const on = lines.find((line) => line.itemId === item.id);
    if (on) return change(on.key, { quantity: String((whole(on.quantity) ?? 0) + 1) });
    const empty = lines.find((line) => line.itemId === NONE);
    if (empty) return change(empty.key, { itemId: item.id, quantity: '1' });
    if (lines.length >= MOST_SLIP_LINES) return `A slip holds ${MOST_SLIP_LINES} items. Record this one, then start another.`;
    setLines((all) => [...all, { key: nextKey, itemId: item.id, quantity: '1' }]);
    setNextKey((key) => key + 1);
  };
  const choose = (next: StockSlipKind) => {
    setKind(next);
    setPosted(null);
    post.reset();
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (problem || post.isPending) return;
    try {
      const list = await post.mutateAsync({ ...slip, inspectionId: move ? null : chosen(inspectionId), note: note.trim() || null, requestKey });
      setPosted(list.slips[0]?.number ?? 'It');
      setLines([{ key: nextKey, itemId: NONE, quantity: '' }]);
      setNextKey((key) => key + 1);
      setInspectionId(NONE);
      setNote('');
      setRequestKey(crypto.randomUUID());
    } catch {
      // The mutation holds the API's message; it is shown below.
    }
  }

  const placeSelect = (id: string, label: string, value: string, onChange: (value: string) => void) => (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select onValueChange={onChange} value={value}>
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>Choose a place</SelectItem>
          {data.places.map((place) => (
            <SelectItem key={place.id} value={place.id}>
              {place.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );

  return (
    <form aria-label="Record a slip" className="bg-card grid gap-4 rounded-xl border p-4" onSubmit={(event) => void submit(event)}>
      <div aria-label="What happened" className="flex flex-wrap gap-2" role="group">
        {STOCK_SLIP_KINDS.map((option) => (
          <Button aria-pressed={kind === option} key={option} onClick={() => choose(option)} size="sm" type="button" variant={kind === option ? 'default' : 'outline'}>
            {KIND_ACTION[option]}
          </Button>
        ))}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {move ? null : (
          <Field>
            <FieldLabel htmlFor="slip-technician">{kind === 'RETURN' ? 'Who is bringing it back' : 'Who is taking it'}</FieldLabel>
            <Select
              onValueChange={(value) => {
                setTechnicianId(value);
                // The visits are that technician's: another's is not kept.
                setInspectionId(NONE);
              }}
              value={technicianId}
            >
              <SelectTrigger id="slip-technician">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Choose a technician</SelectItem>
                {data.technicians.map((technician) => (
                  <SelectItem key={technician.id} value={technician.id}>
                    {technician.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}
        {kind === 'RETURN' ? null : placeSelect('slip-from', 'Taken from', fromPlaceId, setFromPlaceId)}
        {kind === 'WITHDRAWAL' ? null : placeSelect('slip-to', kind === 'RETURN' ? 'Put back in' : 'Moved to', toPlaceId, setToPlaceId)}
        {move ? null : (
          <Field>
            <FieldLabel htmlFor="slip-visit">For the visit</FieldLabel>
            <Select disabled={technicianId === NONE} onValueChange={setInspectionId} value={inspectionId}>
              <SelectTrigger id="slip-visit">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>No visit (truck restock or office use)</SelectItem>
                {data.visits.map((visit) => (
                  <SelectItem key={visit.id} value={visit.id}>
                    {visit.address ? `${visit.title}, ${visit.address}` : visit.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>
              {technicianId === NONE ? 'Choose the technician first.' : data.visits.length ? `Their visits for ${formatDay(data.day)}.` : `They have no visit on ${formatDay(data.day)}.`}
            </FieldDescription>
          </Field>
        )}
      </div>

      <ScanField className="max-w-md" hint="Scan a label to put the item on the slip. Scan it again for one more." id="slip-scan" items={data.items} onItem={scan} />
      <div className="overflow-clip rounded-xl border">
        <Table aria-label="Items on the slip">
          <TableHeader>
            <TableRow>
              <TableHead>Item</TableHead>
              {leaves ? <TableHead className="text-right">On hand there</TableHead> : null}
              <TableHead className="text-right">Quantity</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((line, index) => {
              const item = itemOf.get(line.itemId);
              const label = item ? item.name : `Item ${index + 1}`;
              return (
                <TableRow key={line.key}>
                  <TableCell>
                    <Select onValueChange={(itemId) => change(line.key, { itemId })} value={line.itemId}>
                      <SelectTrigger aria-label={`Item ${index + 1}`} className="w-full min-w-48">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>Choose an item</SelectItem>
                        {data.items
                          .filter((option) => option.id === line.itemId || !taken.has(option.id))
                          .map((option) => (
                            <SelectItem key={option.id} value={option.id}>
                              {option.code} {option.name}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  {leaves ? <TableCell className="text-right font-mono tabular-nums">{item ? `${formatCount(there.get(item.id) ?? 0)} ${item.unit}` : ''}</TableCell> : null}
                  <TableCell className="text-right">
                    <Input
                      aria-label={`Quantity of ${label}`}
                      className="ml-auto w-20 text-right"
                      inputMode="numeric"
                      onChange={(event) => change(line.key, { quantity: event.target.value })}
                      value={line.quantity}
                    />
                  </TableCell>
                  <TableCell>
                    {lines.length > 1 ? (
                      <Button aria-label={`Remove ${label}`} onClick={() => setLines((all) => all.filter((one) => one.key !== line.key))} size="icon-sm" type="button" variant="ghost">
                        <XIcon />
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <div className="grid gap-4 sm:grid-cols-[auto_1fr] sm:items-start">
        <Button
          disabled={lines.length >= Math.min(MOST_SLIP_LINES, data.items.length)}
          onClick={() => {
            setLines((all) => [...all, { key: nextKey, itemId: NONE, quantity: '' }]);
            setNextKey((key) => key + 1);
          }}
          size="sm"
          type="button"
          variant="outline"
        >
          <PlusIcon /> Add item
        </Button>
        <Field>
          <FieldLabel className="sr-only" htmlFor="slip-note">
            Note
          </FieldLabel>
          <Input autoComplete="off" id="slip-note" maxLength={500} onChange={(event) => setNote(event.target.value)} placeholder="Note (optional)" value={note} />
        </Field>
      </div>

      {post.error ? (
        <Alert variant="destructive">
          <AlertDescription>{post.error.message}</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={Boolean(problem) || post.isPending} type="submit">
          {post.isPending ? <Spinner /> : null}
          {POST_LABEL[kind]}
        </Button>
        <p aria-live="polite" className="text-muted-foreground text-sm">
          {posted && !filled.length ? `${posted} is posted.` : (problem ?? 'A slip cannot be edited after it is posted, only reversed.')}
        </p>
      </div>
    </form>
  );
}

// ── Reversal ──────────────────────────────────────────────────────────────

function ReverseSlipDialog({ slip, onClose }: { slip: StockSlipRow; onClose: () => void }) {
  const { reverse } = useStockSlipEdits();
  const [reason, setReason] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!reason.trim() || reverse.isPending) return;
    try {
      await reverse.mutateAsync({ slipId: slip.id, input: { reason: reason.trim() } });
      onClose();
    } catch {
      // The mutation holds the API's message; it is shown below.
    }
  }

  return (
    <Dialog onOpenChange={(open) => (open ? undefined : onClose())} open>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Reverse {slip.number}?</DialogTitle>
          <DialogDescription>
            {slip.kind === 'WITHDRAWAL'
              ? `This puts the stock back in ${slip.from?.name ?? 'its place'}.`
              : slip.kind === 'RETURN'
                ? `This takes the stock back out of ${slip.to?.name ?? 'its place'}, if it is still there.`
                : `This moves the stock back to ${slip.from?.name ?? 'where it was'}, if it is still in ${slip.to?.name ?? 'the other place'}.`}{' '}
            The slip stays on the list, marked reversed, and this cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
          <Field>
            <FieldLabel htmlFor="reverse-slip-reason">Why</FieldLabel>
            <Textarea id="reverse-slip-reason" maxLength={500} onChange={(event) => setReason(event.target.value)} required rows={3} value={reason} />
            <FieldDescription>Kept on the slip, with your name.</FieldDescription>
          </Field>
          {reverse.error ? (
            <Alert variant="destructive">
              <AlertDescription>{reverse.error.message}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button onClick={onClose} type="button" variant="outline">
              Cancel
            </Button>
            <Button disabled={!reason.trim() || reverse.isPending} type="submit" variant="destructive">
              {reverse.isPending ? <Spinner /> : null}
              Reverse slip
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
