'use client';

import { USAGE_PERIODS, USAGE_PERIOD_LABEL, formatMoney, type InventoryMonitoring, type ReorderRow, type UsagePeriod } from '@texasrenters/shared';
import { PackageCheckIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Stat, StatGroup } from '@/components/stat-card';
import { EmptyState, ErrorState } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EMPTY, formatCount, formatDay } from '@/lib/format';
import { useInventoryMonitoring } from '@/lib/inventory-queries';

/**
 * Reorder and usage (2026-11-19, phase 7): what has reached its reorder level
 * and what to ask for, and what the materials came to over a period. Nothing
 * is typed into stock here. "Make a purchase request" opens the new
 * requisition with the ticked items on it, to be read and submitted there:
 * this page writes nothing. Read when the tab opens and when the period
 * changes; nothing is polled or billed.
 */

const whole = (value: string) => (/^\d+$/.test(value.trim()) ? Number(value.trim()) : null);

export function ReorderTab({ period, onPeriod, canRequest }: { period: string; onPeriod: (period: UsagePeriod) => void; canRequest: boolean }) {
  const chosen = (USAGE_PERIODS as readonly string[]).includes(period) ? (period as UsagePeriod) : '30d';
  const report = useInventoryMonitoring(true, chosen);

  if (report.isError) return <ErrorState error={report.error} retry={() => void report.refetch()} />;
  if (!report.data)
    return (
      <div aria-label="Loading reorder and usage" className="text-muted-foreground flex items-center gap-2 text-sm" role="status">
        <Spinner /> Loading
      </div>
    );
  const data = report.data;
  const words = USAGE_PERIOD_LABEL[data.period].toLowerCase();

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="text-muted-foreground text-sm">
          {formatDay(data.from)} to {formatDay(data.to)}
        </p>
        <div className="grid gap-1.5">
          <Label htmlFor="usage-period">Period</Label>
          <Select onValueChange={(value) => onPeriod(value as UsagePeriod)} value={chosen}>
            <SelectTrigger className="w-44" id="usage-period">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {USAGE_PERIODS.map((option) => (
                <SelectItem key={option} value={option}>
                  {USAGE_PERIOD_LABEL[option]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <StatGroup columns="grid-cols-2 lg:grid-cols-4">
        <Stat label="To reorder now" tone={data.reorder.length ? 'warning' : 'default'} value={`${formatCount(data.reorder.length)} ${data.reorder.length === 1 ? 'item' : 'items'}`} />
        <Stat detail="Taken out less brought back, at cost" label={`Materials used, ${words}`} value={formatMoney(data.usedCents)} />
        <Stat detail="Received from vendors" label={`Bought, ${words}`} value={formatMoney(data.boughtCents)} />
        <Stat
          detail={data.lostInCountsCents < 0 ? 'The counts found more than they missed' : 'What the counts found missing, at cost'}
          label={data.lostInCountsCents < 0 ? `Found in counts, ${words}` : `Lost in counts, ${words}`}
          value={formatMoney(Math.abs(data.lostInCountsCents))}
        />
      </StatGroup>

      {/* Remounted when the list changes, so the ticks and quantities start from what the report says. */}
      <ReorderList canRequest={canRequest} key={data.reorder.map((row) => `${row.itemId}:${row.onOrder}`).join(',')} rows={data.reorder} words={words} />

      <div className="grid gap-4 lg:grid-cols-2">
        <ByTechnician data={data} />
        <ByJob data={data} />
      </div>
    </div>
  );
}

// ── Reorder ───────────────────────────────────────────────────────────────

function ReorderList({ rows, words, canRequest }: { rows: ReorderRow[]; words: string; canRequest: boolean }) {
  const router = useRouter();
  // Ticked to begin with: whatever is not already on order.
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(rows.filter((row) => !row.onOrder).map((row) => row.itemId)));
  const [typed, setTyped] = useState<Record<string, string>>(() => Object.fromEntries(rows.map((row) => [row.itemId, String(row.suggested)])));

  const picked = rows.filter((row) => ticked.has(row.itemId)).map((row) => ({ row, quantity: whole(typed[row.itemId] ?? '') }));
  const companies = new Set(picked.map(({ row }) => row.company?.tenantId ?? ''));
  const problem = !picked.length
    ? 'Tick the items to ask for.'
    : picked.some(({ quantity }) => !quantity)
      ? 'Give each ticked item a whole number to ask for.'
      : companies.size > 1
        ? 'The ticked items are for more than one company. A request is for one company: make one for each.'
        : null;

  return (
    <section aria-labelledby="reorder-heading" className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold" id="reorder-heading">
          At or below the reorder level
        </h2>
        {canRequest && rows.length ? (
          <Button
            disabled={Boolean(problem)}
            onClick={() => router.push(`/purchasing/requisitions/new?items=${picked.map(({ row, quantity }) => `${row.itemId}:${quantity}`).join(',')}`)}
          >
            Make a purchase request from the ticked items
          </Button>
        ) : null}
      </div>
      {rows.length ? (
        <>
          <div className="overflow-x-auto rounded-xl border">
            <Table aria-label="Items to reorder">
              <TableHeader>
                <TableRow>
                  {canRequest ? (
                    <TableHead className="w-10">
                      <span className="sr-only">Include</span>
                    </TableHead>
                  ) : null}
                  <TableHead>Item</TableHead>
                  <TableHead className="text-right">On hand</TableHead>
                  <TableHead className="text-right">Reorder at</TableHead>
                  <TableHead className="text-right">On order</TableHead>
                  <TableHead className="text-right">Lasts about</TableHead>
                  <TableHead className="text-right">Suggested</TableHead>
                  <TableHead>Usual vendor</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.itemId}>
                    {canRequest ? (
                      <TableCell>
                        <Checkbox
                          aria-label={`Include ${row.name}`}
                          checked={ticked.has(row.itemId)}
                          onCheckedChange={(checked) => {
                            const next = new Set(ticked);
                            if (checked === true) next.add(row.itemId);
                            else next.delete(row.itemId);
                            setTicked(next);
                          }}
                        />
                      </TableCell>
                    ) : null}
                    <TableCell>
                      <span className="grid gap-0.5">
                        <span className="flex flex-wrap items-center gap-2 font-medium">
                          <Link className="underline-offset-4 hover:underline" href={`/inventory/items/${row.itemId}`}>
                            {row.name}
                          </Link>
                          <Badge variant={row.status === 'OUT' ? 'destructive' : 'warning'}>{row.status === 'OUT' ? 'Out' : 'Low'}</Badge>
                        </span>
                        <span className="text-muted-foreground text-xs">
                          {row.code}
                          {row.company ? ` · ${row.company.name}` : ''}
                        </span>
                      </span>
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{formatCount(row.onHand)}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{formatCount(row.reorderLevel)}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{formatCount(row.onOrder)}</TableCell>
                    <TableCell className="text-right whitespace-nowrap">{row.lastsDays === null ? EMPTY : `${formatCount(row.lastsDays)} ${row.lastsDays === 1 ? 'day' : 'days'}`}</TableCell>
                    <TableCell className="text-right">
                      {canRequest && ticked.has(row.itemId) ? (
                        <Input
                          aria-label={`Quantity of ${row.name}`}
                          className="ml-auto w-20 text-right"
                          inputMode="numeric"
                          onChange={(event) => setTyped((all) => ({ ...all, [row.itemId]: event.target.value }))}
                          value={typed[row.itemId] ?? ''}
                        />
                      ) : row.onOrder ? (
                        <span className="text-muted-foreground text-sm">Already on order</span>
                      ) : (
                        <span className="font-mono tabular-nums">{formatCount(row.suggested)}</span>
                      )}
                    </TableCell>
                    <TableCell>{row.usualVendor?.name ?? EMPTY}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <p aria-live="polite" className="text-muted-foreground text-xs">
            {canRequest && problem ? `${problem} ` : ''}&ldquo;Lasts about&rdquo; divides what is on hand by the average used a day over {words}; a dash means none was used.
          </p>
        </>
      ) : (
        <EmptyState description="Every item with a reorder level has more than that on hand." icon={PackageCheckIcon} title="Nothing to reorder" />
      )}
    </section>
  );
}

// ── Usage ─────────────────────────────────────────────────────────────────

function ByTechnician({ data }: { data: InventoryMonitoring }) {
  const most = Math.max(1, ...data.byTechnician.map((row) => row.valueCents));
  return (
    <section aria-labelledby="by-technician" className="bg-card grid content-start gap-3 rounded-xl border p-4">
      <h2 className="text-base font-semibold" id="by-technician">
        Materials used, by technician
      </h2>
      {data.byTechnician.length ? (
        <>
          <ul className="grid gap-2">
            {data.byTechnician.map((row) => (
              <li className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_5rem] items-center gap-3 text-sm" key={row.technicianId}>
                <Link className="truncate underline-offset-4 hover:underline" href={`/inventory?tab=withdrawals&technician=${row.technicianId}`}>
                  {row.name}
                </Link>
                {/* The figure beside it says the same thing in numbers. */}
                <span aria-hidden="true" className="bg-muted h-3 rounded">
                  <span className="bg-info block h-3 rounded" style={{ width: `${Math.max(0, Math.round((row.valueCents / most) * 100))}%` }} />
                </span>
                <span className="text-right font-mono tabular-nums">{formatMoney(row.valueCents)}</span>
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground text-xs">Open a name to see each withdrawal and its visit.</p>
        </>
      ) : (
        <p className="text-muted-foreground text-sm">Nobody took anything out in this period.</p>
      )}
    </section>
  );
}

function ByJob({ data }: { data: InventoryMonitoring }) {
  return (
    <section aria-labelledby="by-job" className="bg-card grid content-start gap-3 rounded-xl border p-4">
      <h2 className="text-base font-semibold" id="by-job">
        Materials used, by kind of job
      </h2>
      {data.byJob.length ? (
        <Table aria-label="Materials used, by kind of job">
          <TableHeader>
            <TableRow>
              <TableHead>Job</TableHead>
              <TableHead className="text-right">Visits</TableHead>
              <TableHead className="text-right">Materials</TableHead>
              <TableHead className="text-right">Per visit</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.byJob.map((row) => (
              <TableRow key={row.job ?? 'none'}>
                <TableCell>{row.job ?? 'No visit named'}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">{row.job ? formatCount(row.visits) : ''}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">{formatMoney(row.valueCents)}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">{row.job && row.visits ? formatMoney(Math.round(row.valueCents / row.visits)) : ''}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <p className="text-muted-foreground text-sm">No materials were used in this period.</p>
      )}
    </section>
  );
}
