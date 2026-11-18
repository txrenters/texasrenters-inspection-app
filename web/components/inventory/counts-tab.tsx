'use client';

import {
  STOCK_COUNT_COVERS,
  STOCK_COUNT_KINDS,
  STOCK_COUNT_KIND_LABEL,
  STOCK_COUNT_STATUS_LABEL,
  formatMoney,
  startStockCountProblem,
  type StockCountKind,
  type StockCountScheduleRow,
  type StockCountStatus,
  type StockCountSummary,
} from '@texasrenters/shared';
import { ClipboardCheckIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { DataTable, DataTableSkeleton, type Column } from '@/components/data-table';
import { EmptyState, ErrorState } from '@/components/states';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { EMPTY, formatCount, formatDay } from '@/lib/format';
import { useStockCountChoices, useStockCountEdits, useStockCounts } from '@/lib/inventory-queries';

/**
 * Inventory counts (2026-11-19, phase 6): when the monthly, quarterly and
 * yearly counts are next due, the counts so far, and "Start a count". A count
 * is counted and reviewed on its own page. Read when the tab opens and after
 * its own saves; nothing here calls anything billed.
 */

/** Radix's Select has no empty value: this stands for "none chosen". */
const NONE = 'none';
/** A monthly count suggests this many of what a place has given out most. */
const FAST_MOVERS_SUGGESTED = 12;

const STATUS_VARIANT: Record<StockCountStatus, 'secondary' | 'info' | 'warning' | 'success' | 'outline'> = { OPEN: 'secondary', COUNTING: 'info', REVIEW: 'warning', POSTED: 'success', CANCELLED: 'outline' };

export function StockCountStatusBadge({ status }: { status: StockCountStatus }) {
  return <Badge variant={STATUS_VARIANT[status]}>{STOCK_COUNT_STATUS_LABEL[status]}</Badge>;
}

const COUNT_COLUMNS: Array<Column<StockCountSummary>> = [
  { key: 'number', header: 'Count', className: 'whitespace-nowrap', cell: (row) => row.number },
  {
    key: 'title',
    header: 'What',
    primary: true,
    cell: (row) => (
      <span className="grid gap-0.5">
        <span className="font-medium">{row.title}</span>
        <span className="text-muted-foreground text-xs">
          {row.place?.name ?? 'Every place'} · started {formatDay(row.day)}
        </span>
      </span>
    ),
  },
  { key: 'counted', header: 'Counted', numeric: true, hideBelow: 'sm', cell: (row) => `${formatCount(row.counted)} of ${formatCount(row.lines)}` },
  { key: 'by', header: 'Counted by', hideBelow: 'md', cell: (row) => row.countedBy ?? EMPTY },
  { key: 'net', header: 'Difference posted', numeric: true, hideBelow: 'lg', cell: (row) => (row.netValueCents === null ? EMPTY : formatMoney(row.netValueCents)) },
  { key: 'status', header: 'Status', cell: (row) => <StockCountStatusBadge status={row.status} /> },
];

export function CountsTab({ canCount }: { canCount: boolean }) {
  const counts = useStockCounts(true);
  const [starting, setStarting] = useState<StockCountKind | null>(null);

  if (counts.isError) return <ErrorState error={counts.error} retry={() => void counts.refetch()} />;
  if (!counts.data) return <DataTableSkeleton columns={COUNT_COLUMNS} label="Loading counts" rows={4} />;
  const { schedule, counts: rows } = counts.data;

  return (
    <div className="grid gap-6">
      <section aria-labelledby="count-schedule" className="grid gap-3">
        <h2 className="text-base font-semibold" id="count-schedule">
          The year&apos;s counts
        </h2>
        <div className="grid gap-4 md:grid-cols-3">
          {schedule.map((row) => (
            <ScheduleCard canCount={canCount} key={row.kind} onStart={() => setStarting(row.kind)} row={row} />
          ))}
        </div>
      </section>

      <section aria-labelledby="counts-heading" className="grid gap-3">
        <h2 className="text-base font-semibold" id="counts-heading">
          Counts
        </h2>
        {rows.length ? (
          <DataTable columns={COUNT_COLUMNS} label="Inventory counts" rowHref={(row) => `/inventory/counts/${row.id}`} rowKey={(row) => row.id} rows={rows} />
        ) : (
          <EmptyState
            description={canCount ? 'Start the first one above. Whoever counts is not shown what the console expects, and somebody else approves the differences.' : 'No count has been started yet.'}
            icon={ClipboardCheckIcon}
            title="No counts yet"
          />
        )}
      </section>
      {starting ? <StartCountDialog kind={starting} onClose={() => setStarting(null)} /> : null}
    </div>
  );
}

function ScheduleCard({ row, canCount, onStart }: { row: StockCountScheduleRow; canCount: boolean; onStart: () => void }) {
  const label = STOCK_COUNT_KIND_LABEL[row.kind];
  return (
    <article aria-label={`${label} count`} className="bg-card grid content-start gap-2 rounded-xl border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">{label}</h3>
        {row.current ? <StockCountStatusBadge status={row.current.status} /> : <Badge variant="outline">Not started</Badge>}
      </div>
      <p className="text-muted-foreground text-sm">{STOCK_COUNT_COVERS[row.kind]}.</p>
      <p className="text-sm">
        Due {formatDay(row.due)}
        <span className="text-muted-foreground">{row.lastPosted ? ` · last posted ${formatDay(row.lastPosted.day)} (${row.lastPosted.number})` : ' · none posted yet'}</span>
      </p>
      {row.current ? (
        <Button asChild className="justify-self-start" size="sm" variant="outline">
          <Link href={`/inventory/counts/${row.current.id}`}>Open {row.current.number}</Link>
        </Button>
      ) : canCount ? (
        <Button aria-label={`Start the ${label.toLowerCase()} count`} className="justify-self-start" onClick={onStart} size="sm">
          Start a count
        </Button>
      ) : null}
    </article>
  );
}

function StartCountDialog({ kind: first, onClose }: { kind: StockCountKind; onClose: () => void }) {
  const router = useRouter();
  const choices = useStockCountChoices(true);
  const { start } = useStockCountEdits();
  const [kind, setKind] = useState<StockCountKind>(first);
  const [placeId, setPlaceId] = useState(NONE);
  // What the person ticked; until they tick anything a monthly count takes the place's fast movers.
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [note, setNote] = useState('');
  // One key for this opening of the form: a second click or a retry starts one count.
  const [requestKey] = useState(() => crypto.randomUUID());

  const data = choices.data;
  const place = placeId === NONE ? null : placeId;
  const suggested = new Set((data?.fastMovers ?? []).filter((mover) => mover.placeId === place).slice(0, FAST_MOVERS_SUGGESTED).map((mover) => mover.itemId));
  const chosen = picked ?? suggested;
  const itemIds = kind === 'MONTHLY' ? (data?.items ?? []).filter((item) => chosen.has(item.id)).map((item) => item.id) : [];
  const problem = startStockCountProblem({ kind, placeId: kind === 'YEARLY' ? null : place, itemIds });

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (problem || start.isPending) return;
    try {
      const count = await start.mutateAsync({ kind, placeId: kind === 'YEARLY' ? null : place, itemIds, note: note.trim() || null, requestKey });
      router.push(`/inventory/counts/${count.id}`);
    } catch {
      // The mutation holds the API's message; it is shown below.
    }
  }

  return (
    <Dialog onOpenChange={(open) => (open ? undefined : onClose())} open>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Start a count</DialogTitle>
          <DialogDescription>It lists what is to be counted. Whoever counts is not shown what the console expects.</DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
          <Field>
            <FieldLabel htmlFor="count-kind">Which count</FieldLabel>
            <Select onValueChange={(value) => setKind(value as StockCountKind)} value={kind}>
              <SelectTrigger id="count-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STOCK_COUNT_KINDS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {STOCK_COUNT_KIND_LABEL[option]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>{STOCK_COUNT_COVERS[kind]}.</FieldDescription>
          </Field>
          {kind === 'YEARLY' ? (
            <Alert>
              <AlertDescription>While a yearly count is open nothing can be received, taken out, returned or moved. Start it when the shelves are still, and post or cancel it to free them.</AlertDescription>
            </Alert>
          ) : (
            <Field>
              <FieldLabel htmlFor="count-place">Place to count</FieldLabel>
              <Select
                onValueChange={(value) => {
                  setPlaceId(value);
                  // Another place has its own fast movers.
                  setPicked(null);
                }}
                value={placeId}
              >
                <SelectTrigger id="count-place">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Choose a place</SelectItem>
                  {(data?.places ?? []).map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      {option.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
          {kind === 'MONTHLY' && place && data ? (
            <fieldset className="grid gap-2">
              <legend className="text-sm font-medium">Items to count</legend>
              <p className="text-muted-foreground text-xs">
                {suggested.size ? 'Ticked: what this place has given out most in the last 90 days.' : 'Nothing has been taken out of this place lately, so none is ticked.'} {formatCount(itemIds.length)} chosen.
              </p>
              <div className="grid max-h-56 gap-1 overflow-y-auto rounded-xl border p-2">
                {data.items.map((item) => (
                  <label className="hover:bg-muted flex min-h-9 items-center gap-2 rounded-md px-2 text-sm" key={item.id}>
                    <Checkbox
                      checked={chosen.has(item.id)}
                      onCheckedChange={(checked) => {
                        const next = new Set(chosen);
                        if (checked === true) next.add(item.id);
                        else next.delete(item.id);
                        setPicked(next);
                      }}
                    />
                    <span>
                      {item.code} {item.name}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}
          <Field>
            <FieldLabel htmlFor="count-note">Note</FieldLabel>
            <Input autoComplete="off" id="count-note" maxLength={500} onChange={(event) => setNote(event.target.value)} placeholder="Optional" value={note} />
          </Field>
          {choices.isError ? (
            <Alert variant="destructive">
              <AlertDescription>{choices.error.message}</AlertDescription>
            </Alert>
          ) : null}
          {start.error ? (
            <Alert variant="destructive">
              <AlertDescription>{start.error.message}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter className="sm:items-center">
            <p aria-live="polite" className="text-muted-foreground mr-auto text-sm">
              {data ? problem : 'Loading'}
            </p>
            <Button onClick={onClose} type="button" variant="outline">
              Cancel
            </Button>
            <Button disabled={!data || Boolean(problem) || start.isPending} type="submit">
              {start.isPending ? <Spinner /> : null}
              Start the count
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
