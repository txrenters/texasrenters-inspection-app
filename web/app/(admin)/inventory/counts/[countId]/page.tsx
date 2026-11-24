'use client';

import {
  RECOUNT_OVER_CENTS,
  STOCK_COUNT_REASON_LABEL,
  STOCK_COUNT_STATUS_LABEL,
  formatMoney,
  stockCountReasonsFor,
  type StockCountDetail,
  type StockCountLineRow,
  type StockCountReason,
  type StockCountStatus,
} from '@texasrenters/shared';
import { ClipboardCheckIcon } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { ScanField } from '@/components/inventory/scan-field';

import { StockCountStatusBadge } from '@/components/inventory/counts-tab';
import { PageHeader } from '@/components/page-header';
import { AsideCard, FactTable } from '@/components/record/record-kit';
import { ErrorState, PageSkeleton } from '@/components/states';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { EMPTY, formatCount, formatDateTime, formatDay } from '@/lib/format';
import { useStockCount, useStockCountEdits } from '@/lib/inventory-queries';

/**
 * One count (2026-11-19, phase 6). The same page is three things, by what the
 * server says this person may see and do:
 *
 * - for whoever counts, the items and a box each, with no expected number, so
 *   the count is a real count;
 * - for somebody who approves and did not count, the differences, a reason
 *   for each, a second count where one is wanted, and "Approve and post";
 * - for anybody else, what was counted and where the count stands.
 *
 * Read when it opens and after its own saves; nothing is polled or billed.
 */

const STEPS: StockCountStatus[] = ['OPEN', 'COUNTING', 'REVIEW', 'POSTED'];
/** Radix's Select has no empty value: this stands for "none chosen". */
const NONE = 'none';
const whole = (value: string) => (/^\d+$/.test(value.trim()) ? Number(value.trim()) : null);

export default function StockCountPage() {
  const { countId } = useParams<{ countId: string }>();
  const detail = useStockCount(countId);
  const [cancelling, setCancelling] = useState(false);

  if (detail.isLoading) return <PageSkeleton />;
  if (detail.isError || !detail.data) return <ErrorState error={detail.error} retry={() => void detail.refetch()} />;
  const count = detail.data;
  const everywhere = count.place === null;

  return (
    <>
      <PageHeader
        actions={
          count.can.cancel ? (
            <Button onClick={() => setCancelling(true)} variant="outline">
              Cancel count
            </Button>
          ) : undefined
        }
        badges={<StockCountStatusBadge status={count.status} />}
        description={
          <>
            <Link className="underline-offset-4 hover:underline" href="/inventory?tab=counts">
              Counts
            </Link>
            {` · ${count.number} · ${count.place?.name ?? 'Every place'} · ${formatCount(count.lines)} ${count.lines === 1 ? 'item' : 'items'}${count.countedBy ? ` · counted by ${count.countedBy}` : ''}`}
          </>
        }
        prominent
        record={{ icon: ClipboardCheckIcon, tone: 'text-info', label: 'Inventory count' }}
        title={count.title}
      />

      {count.status === 'CANCELLED' ? (
        <Alert className="mb-4">
          <AlertDescription>
            Cancelled by {count.cancelled?.by} on {formatDateTime(count.cancelled?.at)}: {count.cancelled?.reason}. Nothing it counted was posted.
          </AlertDescription>
        </Alert>
      ) : (
        <ol aria-label="Where the count stands" className="text-muted-foreground mb-4 flex flex-wrap items-center gap-1.5 text-xs font-semibold">
          {STEPS.map((step, index) => {
            const at = STEPS.indexOf(count.status);
            return (
              <li aria-current={index === at ? 'step' : undefined} className="flex items-center gap-1.5" key={step}>
                {index ? <span aria-hidden="true">›</span> : null}
                <Badge variant={index === at ? 'default' : index < at ? 'success' : 'secondary'}>{STOCK_COUNT_STATUS_LABEL[step]}</Badge>
              </li>
            );
          })}
        </ol>
      )}

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        {/* Remounted when the server's answer changes, so each form starts from what is saved. */}
        {count.can.count ? (
          <CountingForm count={count} everywhere={everywhere} key={`counting-${count.rows.map((row) => `${row.waiting ? 'w' : 'h'}${row.counted ?? ''}`).join('.')}`} />
        ) : count.reviewing ? (
          <Review count={count} everywhere={everywhere} key={`review-${count.status}-${count.counted}`} />
        ) : (
          <Counted count={count} everywhere={everywhere} />
        )}
        <AsideCard title="This count">
          <FactTable
            facts={[
              { label: 'Started', value: `${count.startedBy}, ${formatDay(count.day)}` },
              { label: 'Counted by', value: count.countedBy ?? EMPTY },
              { label: 'Handed in', value: count.submittedAt ? formatDateTime(count.submittedAt) : EMPTY },
              { label: 'Approved by', value: count.approvedBy ?? EMPTY },
              { label: 'Posted', value: count.postedAt ? formatDateTime(count.postedAt) : EMPTY },
              ...(count.netValueCents === null ? [] : [{ label: 'Difference posted', value: formatMoney(count.netValueCents) }]),
              ...(count.note ? [{ label: 'Note', value: count.note }] : []),
            ]}
            label="This count"
          />
        </AsideCard>
      </div>
      {cancelling ? <CancelDialog count={count} onClose={() => setCancelling(false)} /> : null}
    </>
  );
}

const itemCell = (row: StockCountLineRow, everywhere: boolean) => (
  <span className="grid gap-0.5">
    <span className="font-medium">{row.itemName}</span>
    <span className="text-muted-foreground text-xs">
      {row.itemCode} · {row.unit}
      {everywhere ? ` · ${row.place.name}` : ''}
    </span>
  </span>
);

// ── Counting ──────────────────────────────────────────────────────────────

function CountingForm({ count, everywhere }: { count: StockCountDetail; everywhere: boolean }) {
  const { save, handIn } = useStockCountEdits();
  const [typed, setTyped] = useState<Record<string, string>>(() => Object.fromEntries(count.rows.map((row) => [row.id, row.counted === null ? '' : String(row.counted)])));
  // The lines not handed in yet: every one at first, and afterwards only those sent back for a second count.
  const open = count.rows.filter((row) => row.waiting);
  const second = open.filter((row) => row.recount);
  const openIds = new Set(open.map((row) => row.id));
  /** The line the last scan found: marked, and its count field holds the cursor. */
  const [found, setFound] = useState<string | null>(null);
  // What a scan may land on: the open lines, one not yet counted before one that is, so an item kept in two places
  // is counted place by place.
  const scannable = [...open].sort((a, b) => Number((typed[a.id] ?? '').trim() !== '') - Number((typed[b.id] ?? '').trim() !== '')).map((row) => ({ id: row.id, code: row.itemCode }));
  const lineField = (lineId: string) => `count-line-${lineId}`;

  const lines = open.map((row) => ({ lineId: row.id, text: typed[row.id] ?? '' })).map((line) => ({ lineId: line.lineId, counted: line.text.trim() === '' ? null : whole(line.text), bad: line.text.trim() !== '' && whole(line.text) === null }));
  const bad = lines.some((line) => line.bad);
  const left = lines.filter((line) => line.counted === null).length;
  const input = { lines: lines.map(({ lineId, counted }) => ({ lineId, counted })) };
  const pending = save.isPending || handIn.isPending;
  const error = handIn.error ?? save.error;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (bad || left || pending) return;
    try {
      await handIn.mutateAsync({ countId: count.id, input });
    } catch {
      // The mutation holds the API's message; it is shown below.
    }
  }

  return (
    <form aria-label="Count" className="grid gap-4" onSubmit={(event) => void submit(event)}>
      {second.length ? (
        <Alert>
          <AlertDescription>
            {second.length === 1 ? '1 item needs' : `${formatCount(second.length)} items need`} a second count. Count {second.length === 1 ? 'it' : 'them'} again and hand the count in.
          </AlertDescription>
        </Alert>
      ) : (
        <p className="text-muted-foreground text-sm">Count what is on the shelf and type it in. The console&apos;s own number is not shown here, so the count is a real count.</p>
      )}
      <ScanField
        className="max-w-md"
        hint="Scan a shelf label to jump to its line, type the count and press Enter. The cursor comes back here for the next label."
        id="count-scan"
        items={scannable}
        missing={(code) => (count.rows.some((row) => row.itemCode === code) ? `${code} is already handed in.` : `${code} is not in this count.`)}
        onItem={(line) => {
          setFound(line.id);
          const field = document.getElementById(lineField(line.id));
          if (field instanceof HTMLInputElement) {
            field.focus();
            field.select();
          }
        }}
      />
      <div className="overflow-clip rounded-xl border">
        <Table aria-label="What to count">
          <TableHeader>
            <TableRow>
              <TableHead>Item</TableHead>
              <TableHead className="text-right">Counted</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {count.rows.map((row) => (
              <TableRow className={row.id === found ? 'bg-success/10' : undefined} data-scanned={row.id === found ? 'true' : undefined} key={row.id}>
                <TableCell>
                  {itemCell(row, everywhere)}
                  {row.recount && row.waiting ? <span className="text-warning text-xs">Count this one again.</span> : null}
                </TableCell>
                <TableCell className="text-right">
                  {openIds.has(row.id) ? (
                    <Input
                      aria-label={`Counted ${row.itemName}${everywhere ? ` in ${row.place.name}` : ''}`}
                      className="ml-auto w-24 text-right"
                      id={lineField(row.id)}
                      inputMode="numeric"
                      onChange={(event) => setTyped((all) => ({ ...all, [row.id]: event.target.value }))}
                      onKeyDown={(event) => {
                        // Enter is "next label", never "hand in": handing in is its own button.
                        if (event.key !== 'Enter') return;
                        event.preventDefault();
                        document.getElementById('count-scan')?.focus();
                      }}
                      placeholder="Count"
                      value={typed[row.id] ?? ''}
                    />
                  ) : (
                    <span className="font-mono tabular-nums">{formatCount(row.counted)}</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={bad || left > 0 || pending} type="submit">
          {handIn.isPending ? <Spinner /> : null}
          Hand in the count
        </Button>
        <Button disabled={bad || pending} onClick={() => void save.mutateAsync({ countId: count.id, input }).catch(() => undefined)} type="button" variant="outline">
          {save.isPending ? <Spinner /> : null}
          Save progress
        </Button>
        <p aria-live="polite" className="text-muted-foreground text-sm">
          {bad ? 'A count is a whole number, 0 or more.' : left ? `${formatCount(left)} still to count.` : 'Every item is counted. Once handed in it cannot be changed.'}
        </p>
      </div>
    </form>
  );
}

// ── Counted, for whoever may not see the differences ──────────────────────

function Counted({ count, everywhere }: { count: StockCountDetail; everywhere: boolean }) {
  return (
    <section className="grid gap-3">
      <p className="text-muted-foreground text-sm">
        {count.status === 'REVIEW'
          ? 'Handed in. Somebody who approves counts, and did not count this one, reviews the differences and posts it.'
          : count.status === 'CANCELLED'
            ? 'What had been counted when it was cancelled.'
            : 'What has been counted so far.'}
      </p>
      <div className="overflow-clip rounded-xl border">
        <Table aria-label="What was counted">
          <TableHeader>
            <TableRow>
              <TableHead>Item</TableHead>
              <TableHead className="text-right">Counted</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {count.rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell>{itemCell(row, everywhere)}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">{row.counted === null ? EMPTY : formatCount(row.counted)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

// ── Review ────────────────────────────────────────────────────────────────

function DifferenceBadge({ difference }: { difference: number }) {
  if (difference === 0) return <Badge variant="success">Matches</Badge>;
  return <Badge variant={difference < 0 ? 'destructive' : 'info'}>{`${formatCount(Math.abs(difference))} ${difference < 0 ? 'short' : 'over'}`}</Badge>;
}

function Review({ count, everywhere }: { count: StockCountDetail; everywhere: boolean }) {
  const { post, recount } = useStockCountEdits();
  const [reasons, setReasons] = useState<Record<string, StockCountReason>>({});
  const [all, setAll] = useState(false);

  const waiting = count.rows.filter((row) => row.counted === null);
  const differing = count.rows.filter((row) => row.difference !== null && row.difference !== 0);
  const shown = all ? count.rows : count.rows.filter((row) => row.counted === null || row.difference !== 0);
  const net = differing.reduce((sum, row) => sum + (row.valueCents ?? 0), 0);
  const unexplained = differing.filter((row) => !reasons[row.id]).length;
  const posted = count.status === 'POSTED';
  // Cancelled before everything was counted (production, 2026-11-24): nothing is waiting for anybody.
  const cancelled = count.status === 'CANCELLED';

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!count.can.post || unexplained || post.isPending) return;
    try {
      await post.mutateAsync({ countId: count.id, input: { reasons: differing.map((row) => ({ lineId: row.id, reason: reasons[row.id]! })) } });
    } catch {
      // The mutation holds the API's message; it is shown below.
    }
  }

  return (
    <form aria-label="Review the differences" className="grid gap-4" onSubmit={(event) => void submit(event)}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm">
          {cancelled
            ? waiting.length === count.rows.length
              ? 'Nothing had been counted when it was cancelled.'
              : `${formatCount(count.rows.length - waiting.length)} of ${formatCount(count.rows.length)} had been counted when it was cancelled.`
            : waiting.length
            ? `${formatCount(waiting.length)} ${waiting.length === 1 ? 'item is' : 'items are'} waiting for a second count. It comes back here once handed in.`
            : differing.length
              ? `${formatCount(count.matched ?? 0)} of ${formatCount(count.lines)} matched. ${differing.length === 1 ? 'The one that did not is' : `The ${formatCount(differing.length)} that did not are`} below.`
              : `All ${formatCount(count.lines)} matched what the console has.`}
        </p>
        {count.rows.length > shown.length || all ? (
          <Button onClick={() => setAll((value) => !value)} size="sm" type="button" variant="ghost">
            {all ? 'Show only the differences' : 'Show every line'}
          </Button>
        ) : null}
      </div>

      {shown.length ? (
        <div className="overflow-x-auto rounded-xl border">
          <Table aria-label="Differences">
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead className="text-right">Expected</TableHead>
                <TableHead className="text-right">Counted</TableHead>
                <TableHead className="text-right">Difference</TableHead>
                <TableHead className="text-right">Value</TableHead>
                <TableHead>Reason</TableHead>
                {count.can.recount ? <TableHead className="w-10" /> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((row) => {
                const fits = row.difference ? stockCountReasonsFor(row.difference) : [];
                return (
                  <TableRow key={row.id}>
                    <TableCell>
                      {itemCell(row, everywhere)}
                      {row.recount && row.counted !== null ? <span className="text-muted-foreground text-xs">Counted twice.</span> : null}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{row.expected === null ? EMPTY : formatCount(row.expected)}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{row.counted === null ? EMPTY : formatCount(row.counted)}</TableCell>
                    <TableCell className="text-right">{row.difference === null ? EMPTY : <DifferenceBadge difference={row.difference} />}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{row.valueCents === null ? EMPTY : formatMoney(row.valueCents)}</TableCell>
                    <TableCell>
                      {row.counted === null ? (
                        <span className="text-muted-foreground text-sm">{cancelled ? 'Not counted' : 'Waiting for the second count'}</span>
                      ) : !row.difference ? (
                        EMPTY
                      ) : count.can.post ? (
                        <Select onValueChange={(value) => setReasons((given) => ({ ...given, [row.id]: value as StockCountReason }))} value={reasons[row.id] ?? NONE}>
                          <SelectTrigger aria-label={`Reason for ${row.itemName}${everywhere ? ` in ${row.place.name}` : ''}`} className="w-full min-w-52">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem disabled value={NONE}>
                              Choose a reason
                            </SelectItem>
                            {fits.map((reason) => (
                              <SelectItem key={reason} value={reason}>
                                {STOCK_COUNT_REASON_LABEL[reason]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : row.reason ? (
                        STOCK_COUNT_REASON_LABEL[row.reason]
                      ) : (
                        EMPTY
                      )}
                    </TableCell>
                    {count.can.recount ? (
                      <TableCell>
                        <Button
                          aria-label={`Ask for a second count of ${row.itemName}${everywhere ? ` in ${row.place.name}` : ''}`}
                          disabled={recount.isPending}
                          onClick={() => void recount.mutateAsync({ countId: count.id, lineId: row.id }).catch(() => undefined)}
                          size="sm"
                          type="button"
                          variant="outline"
                        >
                          Recount
                        </Button>
                      </TableCell>
                    ) : null}
                  </TableRow>
                );
              })}
            </TableBody>
            {differing.length ? (
              <TableFooter>
                <TableRow>
                  <TableCell className="text-right font-semibold" colSpan={4}>
                    Net difference
                  </TableCell>
                  <TableCell className="text-right font-mono font-semibold tabular-nums">{formatMoney(net)}</TableCell>
                  <TableCell colSpan={count.can.recount ? 2 : 1} />
                </TableRow>
              </TableFooter>
            ) : null}
          </Table>
        </div>
      ) : null}

      {(post.error ?? recount.error) ? (
        <Alert variant="destructive">
          <AlertDescription>{(post.error ?? recount.error)!.message}</AlertDescription>
        </Alert>
      ) : null}
      {count.can.post ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={unexplained > 0 || post.isPending} type="submit">
            {post.isPending ? <Spinner /> : null}
            Approve and post
          </Button>
          <p aria-live="polite" className="text-muted-foreground text-sm">
            {unexplained
              ? `Give ${unexplained === 1 ? 'the difference' : `each of the ${formatCount(unexplained)} differences`} a reason.`
              : differing.length
                ? `Posting writes ${differing.length === 1 ? 'one adjustment' : `${formatCount(differing.length)} adjustments`} to the stock ledger. It cannot be undone here.`
                : 'Nothing differs, so posting changes no stock.'}
          </p>
        </div>
      ) : posted ? null : (
        <p className="text-muted-foreground text-sm">
          A difference worth more than {formatMoney(RECOUNT_OVER_CENTS)} is counted a second time before it comes here. The person who counted cannot approve.
        </p>
      )}
    </form>
  );
}

// ── Cancel ────────────────────────────────────────────────────────────────

function CancelDialog({ count, onClose }: { count: StockCountDetail; onClose: () => void }) {
  const { cancel } = useStockCountEdits();
  const [reason, setReason] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!reason.trim() || cancel.isPending) return;
    try {
      await cancel.mutateAsync({ countId: count.id, input: { reason: reason.trim() } });
      onClose();
    } catch {
      // The mutation holds the API's message; it is shown below.
    }
  }

  return (
    <Dialog onOpenChange={(open) => (open ? undefined : onClose())} open>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Cancel {count.number}?</DialogTitle>
          <DialogDescription>Nothing it counted is posted, and its place can be counted again. The count stays on the list, marked cancelled.</DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
          <Field>
            <FieldLabel htmlFor="cancel-count-reason">Why</FieldLabel>
            <Textarea id="cancel-count-reason" maxLength={500} onChange={(event) => setReason(event.target.value)} required rows={3} value={reason} />
          </Field>
          {cancel.error ? (
            <Alert variant="destructive">
              <AlertDescription>{cancel.error.message}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button onClick={onClose} type="button" variant="outline">
              Keep it
            </Button>
            <Button disabled={!reason.trim() || cancel.isPending} type="submit" variant="destructive">
              {cancel.isPending ? <Spinner /> : null}
              Cancel count
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
