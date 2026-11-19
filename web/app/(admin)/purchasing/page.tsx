'use client';

import {
  MOST_REQUISITION_QUOTES,
  REQUISITION_STATUSES,
  REQUISITION_STATUS_LABEL,
  formatMoney,
  parseMoney,
  type PurchasingSettings,
  type RequisitionRow,
  type RequisitionStatus,
} from '@texasrenters/shared';
import { ClipboardListIcon } from 'lucide-react';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';

import { DataTable, DataTableSkeleton, type Column } from '@/components/data-table';
import { PageHeader } from '@/components/page-header';
import { CodesTab } from '@/components/purchasing/codes-tab';
import { OrdersTab } from '@/components/purchasing/orders-tab';
import { RequisitionStatusBadge, approverFor } from '@/components/purchasing/requisition-parts';
import { Stat, StatGroup } from '@/components/stat-card';
import { EmptyState, ErrorState } from '@/components/states';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { usePermissions } from '@/lib/auth';
import { EMPTY, formatCount, formatDay } from '@/lib/format';
import { usePurchasingEdits, useRequisitions } from '@/lib/purchasing-queries';
import { useUrlState } from '@/lib/url-state';

/**
 * Purchasing (2026-11-19, phase 2 of the inventory and purchasing plan): the
 * purchase requisitions, and the purchase orders made from them (phase 3).
 * Whoever makes requisitions sees their own; whoever approves them or buys
 * sees everyone's once submitted. Receiving and bills join this page in
 * their own phase.
 *
 * One read of the open requisitions, or of the latest closed ones; the status
 * filter and the search work on the rows in hand.
 */

const ALL = 'all';

function columns(settings: PurchasingSettings): Array<Column<RequisitionRow>> {
  const waitingOn = (row: RequisitionRow) =>
    row.status === 'SUBMITTED' ? approverFor(row.estimatedTotalCents, settings) : row.status === 'DRAFT' || row.status === 'SENT_BACK' ? row.requestedBy.name : row.status === 'APPROVED' ? 'A purchaser, to make the order' : EMPTY;
  return [
    { key: 'number', header: 'No.', cell: (row) => row.number ?? 'Draft', className: 'whitespace-nowrap' },
    {
      key: 'what',
      header: 'What',
      primary: true,
      cell: (row) => (
        <span className="grid gap-0.5">
          <span className="font-medium">{row.summary || 'Nothing asked for yet'}</span>
          <span className="text-muted-foreground text-xs">
            {row.decisionNote && (row.status === 'SENT_BACK' || row.status === 'REJECTED')
              ? `${REQUISITION_STATUS_LABEL[row.status]}: “${row.decisionNote}”`
              : `${formatCount(row.lineCount)} item${row.lineCount === 1 ? '' : 's'}${row.quoteCount ? ` · ${formatCount(row.quoteCount)} quote${row.quoteCount === 1 ? '' : 's'}` : ''}`}
          </span>
        </span>
      ),
    },
    { key: 'by', header: 'Asked by', hideBelow: 'md', cell: (row) => row.requestedBy.name },
    { key: 'day', header: 'Day', hideBelow: 'lg', cell: (row) => formatDay(row.submittedAt ?? row.createdAt), className: 'whitespace-nowrap' },
    { key: 'company', header: 'Company', hideBelow: 'xl', cell: (row) => row.company?.name ?? EMPTY },
    { key: 'total', header: 'Est. total', numeric: true, cell: (row) => formatMoney(row.estimatedTotalCents) },
    { key: 'needed', header: 'Needed by', hideBelow: 'lg', cell: (row) => (row.neededBy ? formatDay(row.neededBy) : EMPTY), className: 'whitespace-nowrap' },
    { key: 'status', header: 'Status', cell: (row) => <RequisitionStatusBadge status={row.status} /> },
    { key: 'waiting', header: 'Waiting on', hideBelow: 'xl', cell: waitingOn },
  ];
}

export default function PurchasingPage() {
  const { has } = usePermissions();
  // The code lists a requisition picks from (2026-11-20): only for whoever may manage them.
  const canCode = has('purchasing:codes');
  const [state, setState] = useUrlState({ tab: 'requisitions', show: 'open', status: ALL, q: '' });
  const show = state.show === 'closed' ? 'closed' : 'open';
  const list = useRequisitions(show);
  const [limits, setLimits] = useState(false);
  const data = list.data;

  const words = state.q.trim().toLowerCase();
  const rows = (data?.requisitions ?? []).filter(
    (row) => (state.status === ALL || row.status === state.status) && (!words || `${row.number ?? ''} ${row.summary} ${row.requestedBy.name}`.toLowerCase().includes(words)),
  );
  const count = (status: RequisitionStatus) => data?.requisitions.filter((row) => row.status === status).length ?? 0;
  const statuses = REQUISITION_STATUSES.filter((status) => data?.requisitions.some((row) => row.status === status));

  return (
    <>
      <PageHeader
        actions={
          <>
            {has('purchasing:approve-any') && data ? (
              <Button onClick={() => setLimits(true)} variant="outline">
                Approval limits
              </Button>
            ) : null}
            <Link className={buttonVariants()} href="/purchasing/requisitions/new">
              New requisition
            </Link>
          </>
        }
        description={data?.seesAll ? "Everyone's purchase requisitions and orders, and yours." : 'Your purchase requisitions, and the orders made from them.'}
        info={
          <>
            <p>A requisition asks for stock to be bought and says why. Somebody else approves it, sends it back with a note, or rejects it.</p>
            <p>It gets its number when it is submitted. Nobody approves their own.</p>
            <p>A purchaser makes the order from an approved requisition, somebody else approves the order, and it goes to the vendor as a PDF.</p>
          </>
        }
        infoLabel="About purchase requisitions"
        title="Purchasing"
      />

      <Tabs onValueChange={(tab) => setState({ tab, show: 'open', status: ALL, q: '' })} value={state.tab === 'orders' ? 'orders' : state.tab === 'codes' && canCode ? 'codes' : 'requisitions'}>
        <TabsList>
          <TabsTrigger value="requisitions">Requisitions</TabsTrigger>
          <TabsTrigger value="orders">Orders</TabsTrigger>
          {canCode ? <TabsTrigger value="codes">Codes</TabsTrigger> : null}
        </TabsList>
        {canCode ? (
          <TabsContent value="codes">
            <CodesTab enabled={state.tab === 'codes'} />
          </TabsContent>
        ) : null}
        <TabsContent value="orders">
          <OrdersTab setState={setState} state={state} />
        </TabsContent>
        <TabsContent value="requisitions">
      {list.isLoading ? (
        <DataTableSkeleton columns={columns({ approvalLimitCents: 0, quotesAboveLimit: 0 })} label="Loading requisitions" rows={6} />
      ) : list.isError || !data ? (
        <ErrorState error={list.error} retry={() => void list.refetch()} />
      ) : (
        <div className="grid gap-4">
          {show === 'open' ? (
            <StatGroup columns="grid-cols-1 sm:grid-cols-3">
              <Stat label="Waiting for approval" tone={count('SUBMITTED') ? 'warning' : 'default'} value={formatCount(count('SUBMITTED'))} />
              <Stat label="Approved, not ordered yet" value={formatCount(count('APPROVED'))} />
              <Stat label="Sent back to the requester" value={formatCount(count('SENT_BACK'))} />
            </StatGroup>
          ) : null}

          <div className="flex flex-wrap items-end gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="requisitions-show">Show</Label>
              <Select onValueChange={(next) => setState({ show: next, status: ALL })} value={show}>
                <SelectTrigger className="w-56" id="requisitions-show">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="open">Open requisitions</SelectItem>
                  <SelectItem value="closed">Ordered, rejected and cancelled</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {statuses.length > 1 ? (
              <div className="grid gap-1.5">
                <Label htmlFor="requisitions-status">Status</Label>
                <Select onValueChange={(status) => setState({ status })} value={state.status}>
                  <SelectTrigger className="w-52" id="requisitions-status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>Every status</SelectItem>
                    {statuses.map((status) => (
                      <SelectItem key={status} value={status}>
                        {REQUISITION_STATUS_LABEL[status]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            <div className="ml-auto grid w-full gap-1.5 sm:w-64">
              <Label htmlFor="requisitions-search">Search requisitions</Label>
              <Input id="requisitions-search" onChange={(event) => setState({ q: event.target.value })} placeholder="Number, item or person" type="search" value={state.q} />
            </div>
          </div>

          {rows.length ? (
            <DataTable columns={columns(data.settings)} label="Purchase requisitions" rowHref={(row) => `/purchasing/requisitions/${row.id}`} rowKey={(row) => row.id} rows={rows} />
          ) : (
            <EmptyState
              description={
                data.requisitions.length
                  ? 'No requisition matches what is chosen above.'
                  : show === 'open'
                    ? 'Ask for stock to be bought with a new requisition. It goes to an approver when you submit it.'
                    : 'Nothing has been ordered, rejected or cancelled.'
              }
              icon={ClipboardListIcon}
              title={data.requisitions.length ? 'Nothing to show' : show === 'open' ? 'No open requisitions' : 'None'}
            />
          )}
        </div>
      )}
        </TabsContent>
      </Tabs>

      {limits && data ? <LimitsDialog onClose={() => setLimits(false)} settings={data.settings} /> : null}
    </>
  );
}

/** The office's approval limit and how many quotes it asks for above it. Only for whoever may approve any amount. */
function LimitsDialog({ settings, onClose }: { settings: PurchasingSettings; onClose: () => void }) {
  const { saveSettings } = usePurchasingEdits();
  const [limit, setLimit] = useState((settings.approvalLimitCents / 100).toFixed(2));
  const [quotes, setQuotes] = useState(String(settings.quotesAboveLimit));
  const approvalLimitCents = limit.trim() ? parseMoney(limit) : null;
  const quotesAboveLimit = /^\d+$/.test(quotes.trim()) && Number(quotes) <= MOST_REQUISITION_QUOTES ? Number(quotes) : null;
  const invalid = approvalLimitCents === null || approvalLimitCents < 0 || quotesAboveLimit === null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (invalid || saveSettings.isPending) return;
    try {
      await saveSettings.mutateAsync({ approvalLimitCents, quotesAboveLimit });
      onClose();
    } catch {
      // The mutation holds the API's message; it is shown below.
    }
  }

  return (
    <Dialog onOpenChange={(open) => (open ? undefined : onClose())} open>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Approval limits</DialogTitle>
          <DialogDescription>Who may approve how much. A change applies to requisitions not yet decided.</DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
          <Field>
            <FieldLabel htmlFor="limit-amount">Approval limit</FieldLabel>
            <Input id="limit-amount" inputMode="decimal" onChange={(event) => setLimit(event.target.value)} value={limit} />
            <FieldDescription>Up to this, anybody with “Approve requisitions” approves. Above it, only “Approve any amount”.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="limit-quotes">Quotes needed above the limit</FieldLabel>
            <Input id="limit-quotes" inputMode="numeric" onChange={(event) => setQuotes(event.target.value)} value={quotes} />
            <FieldDescription>0 for none. At most {MOST_REQUISITION_QUOTES}.</FieldDescription>
          </Field>
          {saveSettings.error ? (
            <Alert variant="destructive">
              <AlertDescription>{saveSettings.error.message}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button onClick={onClose} type="button" variant="outline">
              Cancel
            </Button>
            <Button disabled={invalid || saveSettings.isPending} type="submit">
              Save limits
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
