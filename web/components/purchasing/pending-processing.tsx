'use client';

import { formatMoney, type PendingOrderLine, type PurchaseOrdersMade } from '@texasrenters/shared';
import { ClipboardCheckIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Fragment, useState } from 'react';

import { EmptyState, ErrorState } from '@/components/states';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EMPTY, formatDay } from '@/lib/format';
import { andList, lineAmountCents, makeOrdersInput, pendingGroups, tickedSummary, vendorOf, type PendingGroup, type PendingVendor } from '@/lib/pending-processing';
import { usePendingOrderLines, usePurchaseOrderEdits } from '@/lib/purchasing-queries';
import { cn } from '@/lib/utils';

/**
 * Pending Processing (the office, 2026-11-23), as NAV's requisition
 * worksheet: every approved requisition line not ordered yet, by company and
 * vendor. The purchaser ticks lines, or a whole vendor, and Make Purchase
 * Orders makes one draft order a vendor and company -- the same item to the
 * same place one line, its quantities added, each line where it goes. One read
 * when it is opened; nothing it reads or makes is billed.
 */

const ALL = 'all';
const NONE = 'none';

/** NAV writes its amounts without the dollar sign. */
const amount = (cents: number) => (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const vendorName = (vendor: { number: string | null; name: string }) => (vendor.number ? `${vendor.number} · ${vendor.name}` : vendor.name);
const companyCode = (company: PendingOrderLine['company']) => company?.purchaserCode ?? company?.name ?? 'No company';
const placeCode = (place: PendingOrderLine['place']) => place?.code ?? place?.name ?? EMPTY;

const COLUMNS = [
  { key: 'requisition', label: 'Requisition' },
  { key: 'code', label: 'Item Code' },
  { key: 'description', label: 'Description' },
  { key: 'place', label: 'Location Code' },
  { key: 'quantity', label: 'Quantity', numeric: true },
  { key: 'unit', label: 'Unit' },
  { key: 'cost', label: 'Direct Unit Cost', numeric: true },
  { key: 'amount', label: 'Line Amount', numeric: true },
  { key: 'expected', label: 'Expected Receipt' },
  { key: 'department', label: 'Department' },
  { key: 'by', label: 'Requested by' },
] as const;

export function PendingProcessing({ onMade }: { onMade: () => void }) {
  const router = useRouter();
  const pending = usePendingOrderLines(true);
  const { makeFromLines } = usePurchaseOrderEdits();
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [chosen, setChosen] = useState<ReadonlyMap<string, PendingVendor>>(new Map());
  const [filter, setFilter] = useState({ company: ALL, vendor: ALL, place: ALL, q: '' });
  // What the last press made, when it was more than one order.
  const [made, setMade] = useState<PurchaseOrdersMade['orders']>([]);

  if (pending.isLoading) return <Skeleton aria-label="Loading the lines to order" className="h-64 w-full" />;
  if (pending.isError || !pending.data) return <ErrorState error={pending.error} retry={() => void pending.refetch()} />;

  const { lines, vendors } = pending.data;
  const words = filter.q.trim().toLowerCase();
  const shown = lines.filter((line) => {
    const vendor = vendorOf(line, chosen);
    return (
      (filter.company === ALL || (line.company?.tenantId ?? NONE) === filter.company) &&
      (filter.vendor === ALL || (vendor?.id ?? NONE) === filter.vendor) &&
      (filter.place === ALL || (line.place?.id ?? NONE) === filter.place) &&
      (!words || `${line.requisition.number ?? ''} ${line.item.code} ${line.item.name} ${line.requisition.requestedBy} ${line.department ?? ''}`.toLowerCase().includes(words))
    );
  });
  const groups = pendingGroups(shown, chosen);
  const summary = tickedSummary(lines, chosen, ticked);
  const merging = new Set(summary.merges.flatMap((merge) => merge.lineIds));
  const companies = [...new Map(lines.map((line) => [line.company?.tenantId ?? NONE, line.company])).entries()];
  const places = [...new Map(lines.map((line) => [line.place?.id ?? NONE, line.place])).entries()];
  const vendorsShown = [...new Map(lines.map((line) => vendorOf(line, chosen)).map((vendor) => [vendor?.id ?? NONE, vendor])).entries()];

  const tick = (ids: readonly string[], on: boolean) =>
    setTicked((now) => {
      const next = new Set(now);
      for (const lineId of ids) {
        if (on) next.add(lineId);
        else next.delete(lineId);
      }
      return next;
    });
  const choose = (line: PendingOrderLine, vendorId: string) => {
    const vendor = vendors.find((one) => one.id === vendorId);
    if (!vendor) return;
    setChosen((now) => new Map(now).set(line.requisitionLineId, vendor));
  };
  const make = () =>
    void makeFromLines
      .mutateAsync(makeOrdersInput(lines, chosen, ticked))
      .then(({ orders }) => {
        setTicked(new Set());
        setChosen(new Map());
        // One order opens: the purchaser carries on there. Several are listed, each to open in turn.
        if (orders.length === 1 && orders[0]) router.push(`/purchasing/orders/${orders[0].id}`);
        else setMade(orders);
      })
      .catch(() => undefined);

  if (!lines.length)
    return (
      <div className="grid gap-4">
        {made.length ? <MadeOrders made={made} onClose={() => (setMade([]), onMade())} /> : null}
        <EmptyState
          description="Every approved requisition line is on an order. A requisition comes here once it is approved."
          icon={ClipboardCheckIcon}
          title="Nothing to order"
        />
      </div>
    );

  return (
    <div className="grid gap-4">
      {made.length ? <MadeOrders made={made} onClose={() => (setMade([]), onMade())} /> : null}

      <div className="flex flex-wrap items-end gap-3">
        <FilterSelect
          id="pending-company"
          label="Company"
          onChange={(company) => setFilter((now) => ({ ...now, company }))}
          options={companies.map(([key, company]) => ({ value: key, label: company ? companyCode(company) : 'No company' }))}
          every="Every company"
          value={filter.company}
        />
        <FilterSelect
          id="pending-vendor"
          label="Vendor"
          onChange={(vendor) => setFilter((now) => ({ ...now, vendor }))}
          options={vendorsShown.map(([key, vendor]) => ({ value: key, label: vendor ? vendorName(vendor) : 'No vendor yet' }))}
          every="Every vendor"
          value={filter.vendor}
        />
        <FilterSelect
          id="pending-place"
          label="Location"
          onChange={(place) => setFilter((now) => ({ ...now, place }))}
          options={places.map(([key, place]) => ({ value: key, label: place ? placeCode(place) : 'No location' }))}
          every="Every location"
          value={filter.place}
        />
        <div className="grid w-full gap-1.5 sm:w-72">
          <Label htmlFor="pending-search">Search</Label>
          <Input id="pending-search" onChange={(event) => setFilter((now) => ({ ...now, q: event.target.value }))} placeholder="Requisition, item or person" type="search" value={filter.q} />
        </div>
      </div>

      <div className="overflow-x-auto border">
        <Table aria-label="Lines Pending Processing" className="w-max min-w-full border-collapse text-sm">
          {/* Static: this box scrolls sideways (see components/ui/table.tsx). */}
          <TableHeader className="bg-transparent lg:static">
            <TableRow>
              <TableHead className="bg-muted/60 w-10 border">
                <span className="sr-only">Order it</span>
              </TableHead>
              {COLUMNS.map((column) => (
                <TableHead className={cn('bg-muted/60 text-heading border px-2 text-xs font-medium whitespace-nowrap', 'numeric' in column ? 'text-right' : 'text-left')} key={column.key}>
                  {column.label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.length ? null : (
              <TableRow>
                <TableCell className="text-muted-foreground border px-2 py-6 text-center" colSpan={COLUMNS.length + 1}>
                  No line matches the filters.
                </TableCell>
              </TableRow>
            )}
            {groups.map((group) => (
              <GroupRows
                choose={choose}
                chosen={chosen}
                group={group}
                key={group.key}
                merging={merging}
                tick={tick}
                ticked={ticked}
                vendors={vendors}
              />
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="bg-card sticky bottom-0 z-10 flex flex-wrap items-center gap-x-6 gap-y-3 rounded-md border border-foreground/60 p-4" role="status">
        <div className="grid min-w-0 flex-[1_1_32rem] gap-1">
          <strong className="text-heading">
            {summary.lineCount
              ? `Ticked: ${summary.lineCount} line${summary.lineCount === 1 ? '' : 's'} from ${summary.requisitionCount} requisition${summary.requisitionCount === 1 ? '' : 's'} → ${summary.orders.length} purchase order${summary.orders.length === 1 ? '' : 's'}, ${formatMoney(summary.amountCents)} before tax`
              : 'Tick the lines to order, or a whole vendor.'}
          </strong>
          {summary.lineCount ? (
            <span className="text-muted-foreground text-sm">
              {summary.orders.map((order) => `${order.vendor.name} (${companyCode(order.company)}): ${order.lineCount} line${order.lineCount === 1 ? '' : 's'}`).join(' · ')}.{' '}
              {summary.merges.map((merge) => (
                <span className="border-info mr-1 border-l-[3px] pl-2" key={merge.key}>
                  {merge.item.code}
                  {merge.place ? ` to ${merge.place.name}` : ''}, asked for on {andList(merge.requisitions)}, becomes one line of {merge.quantity}.
                </span>
              ))}
            </span>
          ) : null}
        </div>
        <Button disabled={!summary.lineCount || makeFromLines.isPending} onClick={() => setTicked(new Set())} type="button" variant="outline">
          Clear the ticks
        </Button>
        <Button disabled={!summary.lineCount || makeFromLines.isPending} onClick={make} type="button">
          {makeFromLines.isPending ? <Spinner /> : null}
          Make Purchase Orders
        </Button>
      </div>
      {makeFromLines.error ? (
        <Alert variant="destructive">
          <AlertDescription>{makeFromLines.error.message}</AlertDescription>
        </Alert>
      ) : null}
      <p className="text-muted-foreground m-0 text-sm">
        Each order is made as a draft, for the purchasing manager to approve. Its requisitions move to Pending Order. A line can only be on one order; one not ticked stays here.
      </p>
    </div>
  );
}

function GroupRows({
  group,
  ticked,
  tick,
  chosen,
  choose,
  vendors,
  merging,
}: {
  group: PendingGroup;
  ticked: ReadonlySet<string>;
  tick: (ids: readonly string[], on: boolean) => void;
  chosen: ReadonlyMap<string, PendingVendor>;
  choose: (line: PendingOrderLine, vendorId: string) => void;
  vendors: readonly PendingVendor[];
  merging: ReadonlySet<string>;
}) {
  const ids = group.lines.map((line) => line.requisitionLineId);
  const on = ids.filter((lineId) => ticked.has(lineId)).length;
  const where = `${group.vendor?.name ?? 'no vendor yet'}, ${companyCode(group.company)}`;
  return (
    <>
      <TableRow className="bg-muted/40 hover:bg-muted/40">
        <TableCell className="border px-2 py-2">
          <Checkbox
            aria-label={group.vendor ? `Order every line for ${where}` : 'Choose a vendor first'}
            checked={on === 0 ? false : on === ids.length ? true : 'indeterminate'}
            disabled={!group.vendor}
            onCheckedChange={() => tick(ids, on !== ids.length)}
          />
        </TableCell>
        <TableCell className="border px-2 py-2" colSpan={COLUMNS.length}>
          <span className="text-heading font-semibold tabular-nums">{companyCode(group.company)}</span>
          {' · '}
          {group.vendor ? (
            <>
              {group.vendor.number ? <span className="text-heading font-semibold tabular-nums">{group.vendor.number} </span> : null}
              {group.vendor.name}
              <span className="text-muted-foreground">
                {' · '}
                {group.lines.length} line{group.lines.length === 1 ? '' : 's'} from {group.requisitionCount} requisition{group.requisitionCount === 1 ? '' : 's'} · {formatMoney(group.amountCents)}
                {group.otherCompany ? ' · another company, so its own order' : ''}
              </span>
            </>
          ) : (
            <>
              <Badge variant="warning">No vendor yet</Badge>
              <span className="text-muted-foreground"> · choose one on the line, and it joins that vendor</span>
            </>
          )}
        </TableCell>
      </TableRow>
      {group.lines.map((line) => {
        const vendor = vendorOf(line, chosen);
        const label = `Order ${line.item.code} of ${line.requisition.number ?? 'the requisition'}`;
        return (
          <Fragment key={line.requisitionLineId}>
            <TableRow className={cn(ticked.has(line.requisitionLineId) && 'bg-accent/60')}>
              <TableCell className="border px-2 py-1.5">
                <Checkbox aria-label={label} checked={ticked.has(line.requisitionLineId)} disabled={!vendor} onCheckedChange={(next) => tick([line.requisitionLineId], next === true)} />
              </TableCell>
              <TableCell className="border px-2 py-1.5 whitespace-nowrap">
                <Link className="font-medium underline-offset-4 hover:underline" href={`/purchasing/requisitions/${line.requisition.id}`}>
                  {line.requisition.number ?? 'Draft'}
                </Link>
              </TableCell>
              <TableCell className="text-heading border px-2 py-1.5 font-semibold whitespace-nowrap tabular-nums">{line.item.code}</TableCell>
              <TableCell className="border px-2 py-1.5">
                <span className={cn(merging.has(line.requisitionLineId) && 'border-info border-l-[3px] pl-2')}>{line.item.name}</span>
              </TableCell>
              <TableCell className="border px-2 py-1.5 whitespace-nowrap">{placeCode(line.place)}</TableCell>
              <TableCell className="border px-2 py-1.5 text-right tabular-nums">{line.quantity}</TableCell>
              <TableCell className="border px-2 py-1.5">{line.item.unit}</TableCell>
              <TableCell className="border px-2 py-1.5 text-right tabular-nums">{amount(line.estimatedUnitCostCents)}</TableCell>
              <TableCell className="border px-2 py-1.5 text-right tabular-nums">{amount(lineAmountCents(line))}</TableCell>
              <TableCell className="border px-2 py-1.5 whitespace-nowrap">{line.expectedOn ? formatDay(line.expectedOn) : EMPTY}</TableCell>
              <TableCell className="border px-2 py-1.5">{line.department ?? EMPTY}</TableCell>
              <TableCell className="border px-2 py-1.5 whitespace-nowrap">{line.requisition.requestedBy}</TableCell>
            </TableRow>
            {line.vendor ? null : (
              <TableRow className="hover:bg-transparent">
                <TableCell className="border" />
                <TableCell className="border px-2 py-1.5" colSpan={COLUMNS.length}>
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <Label className="text-muted-foreground font-normal" htmlFor={`vendor-${line.requisitionLineId}`}>
                      Vendor No. for {line.item.code}
                    </Label>
                    <Select onValueChange={(vendorId) => choose(line, vendorId)} value={vendor?.id ?? ''}>
                      <SelectTrigger className={cn('h-8 w-72', !vendor && 'border-warning')} id={`vendor-${line.requisitionLineId}`}>
                        <SelectValue placeholder="Choose a vendor" />
                      </SelectTrigger>
                      <SelectContent>
                        {vendors.map((one) => (
                          <SelectItem key={one.id} value={one.id}>
                            {vendorName(one)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </TableCell>
              </TableRow>
            )}
          </Fragment>
        );
      })}
    </>
  );
}

function FilterSelect({ id, label, every, value, options, onChange }: { id: string; label: string; every: string; value: string; options: { value: string; label: string }[]; onChange: (value: string) => void }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select onValueChange={onChange} value={value}>
        <SelectTrigger className="w-52" id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{every}</SelectItem>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function MadeOrders({ made, onClose }: { made: PurchaseOrdersMade['orders']; onClose: () => void }) {
  return (
    <Alert variant="success">
      <AlertDescription>
        <span>Made {made.length} draft purchase orders, one a vendor and company:</span>
        <span className="flex flex-wrap gap-x-4 gap-y-1">
          {made.map((order) => (
            <Link className="font-medium underline underline-offset-4" href={`/purchasing/orders/${order.id}`} key={order.id}>
              {order.vendor ? vendorName(order.vendor) : 'Vendor to choose'}
            </Link>
          ))}
          <button className="text-muted-foreground underline underline-offset-4" onClick={onClose} type="button">
            See every order
          </button>
        </span>
      </AlertDescription>
    </Alert>
  );
}
