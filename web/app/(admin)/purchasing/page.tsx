'use client';

import {
  DEFAULT_FILE_RULES,
  DEFAULT_PAGE_LAYOUT,
  KEEPER_PERMISSIONS,
  REQUISITION_STAGES,
  REQUISITION_STAGE_LABEL,
  REQUISITION_STATUS_LABEL,
  formatMoney,
  stepsFromLimit,
  type PurchasingSettings,
  type RequisitionRow,
  type RequisitionStage,
} from '@texasrenters/shared';
import { ClipboardListIcon } from 'lucide-react';
import Link from 'next/link';

import { DataTable, DataTableSkeleton, type Column } from '@/components/data-table';
import { PageHeader } from '@/components/page-header';
import { ApprovalsTab } from '@/components/purchasing/approvals-tab';
import { CodesTab } from '@/components/purchasing/codes-tab';
import { OrdersTab } from '@/components/purchasing/orders-tab';
import { RequisitionStageBadge, waitingOn } from '@/components/purchasing/requisition-parts';
import { SetupTab } from '@/components/purchasing/setup-tab';
import { Stat, StatGroup } from '@/components/stat-card';
import { EmptyState, ErrorState } from '@/components/states';
import { buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { usePermissions } from '@/lib/auth';
import { EMPTY, formatCount, formatDay } from '@/lib/format';
import { useRequisitions } from '@/lib/purchasing-queries';
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
    { key: 'department', header: 'Department', hideBelow: 'lg', cell: (row) => row.department?.code ?? EMPTY },
    { key: 'company', header: 'Company', hideBelow: 'xl', cell: (row) => row.company?.name ?? EMPTY },
    { key: 'total', header: 'Est. total', numeric: true, cell: (row) => formatMoney(row.estimatedTotalCents) },
    { key: 'needed', header: 'Needed by', hideBelow: 'lg', cell: (row) => (row.neededBy ? formatDay(row.neededBy) : EMPTY), className: 'whitespace-nowrap' },
    // Where it is, NAV's way (2026-11-21), and so whose turn it is.
    { key: 'status', header: 'Status', cell: (row) => <RequisitionStageBadge stage={row.stage} /> },
    { key: 'waiting', header: 'Waiting on', hideBelow: 'xl', cell: (row) => waitingOn(row, settings) },
  ];
}

export default function PurchasingPage() {
  const { has, hasAny } = usePermissions();
  // The code lists a requisition picks from (2026-11-20). Read by anybody in purchasing (Purchasing Setup, 2026-11-21); each list is changed by its keeper.
  const canCode = hasAny('purchasing:request', ...KEEPER_PERMISSIONS);
  // Purchasing Setup (2026-11-20): a system admin or a Purchasing admin.
  const canSetup = has('purchasing:setup');
  // Requests to Approve (2026-11-21): an approver's requisitions, a purchasing manager's orders.
  const approvesRequisitions = has('purchasing:approve');
  const approvesOrders = has('purchasing:approve-orders');
  const canApprove = approvesRequisitions || approvesOrders;
  // The codes live in Setup since 2026-11-21: read by anybody in purchasing, changed by each list's keeper.
  const seesSetup = canSetup || canCode;
  const [state, setState] = useUrlState({ tab: 'requisitions', show: 'open', status: ALL, q: '' });
  const show = state.show === 'closed' ? 'closed' : 'open';
  const list = useRequisitions(show);
  const data = list.data;

  const words = state.q.trim().toLowerCase();
  const rows = (data?.requisitions ?? []).filter(
    (row) =>
      (state.status === ALL || row.stage === state.status) &&
      (!words || `${row.number ?? ''} ${row.summary} ${row.requestedBy.name} ${row.department?.code ?? ''}`.toLowerCase().includes(words)),
  );
  const count = (stage: RequisitionStage) => data?.requisitions.filter((row) => row.stage === stage).length ?? 0;
  const stages = REQUISITION_STAGES.filter((stage) => data?.requisitions.some((row) => row.stage === stage));
  const tab = state.tab === 'orders' ? 'orders' : state.tab === 'approvals' && canApprove ? 'approvals' : (state.tab === 'setup' || state.tab === 'codes') && seesSetup ? 'setup' : 'requisitions';

  return (
    <>
      <PageHeader
        actions={
          <>
            <Link className={buttonVariants()} href="/purchasing/requisitions/new">
              New requisition
            </Link>
          </>
        }
        description={data?.seesAll ? "Everyone's purchase requisitions and orders, and yours." : 'Your purchase requisitions, and the orders made from them.'}
        info={
          <>
            <p>A requisition asks for stock to be bought. It goes Open, Pending Approval, Pending Processing, Pending Order, Ordered, Received, Closed.</p>
            <p>Pending Approval: an approver of its department and company approves it, sends it back with a note, or rejects it. An approver may approve their own, within their limit.</p>
            <p>Pending Processing: a purchaser makes the purchase order. Pending Order: the purchasing manager approves the order, and the purchaser sends it to the vendor.</p>
            <p>Requests to Approve lists what waits for you.</p>
          </>
        }
        infoLabel="About purchase requisitions"
        title="Purchasing"
      />

      <Tabs onValueChange={(next) => setState({ tab: next, show: 'open', status: ALL, q: '' })} value={tab}>
        <TabsList>
          {/* NAV's names (the office, 2026-11-21). */}
          <TabsTrigger value="requisitions">Purchase Requisitions</TabsTrigger>
          <TabsTrigger value="orders">Purchase Orders</TabsTrigger>
          {canApprove ? <TabsTrigger value="approvals">Requests to Approve</TabsTrigger> : null}
          {seesSetup ? <TabsTrigger value="setup">Setup</TabsTrigger> : null}
        </TabsList>
        {seesSetup ? (
          <TabsContent value="setup">
            <div className="grid gap-8">
              {canSetup ? <SetupTab enabled={tab === 'setup'} /> : null}
              {canCode ? (
                <section aria-labelledby="purchasing-codes" className="grid gap-3">
                  <h2 className="text-heading text-lg font-semibold" id="purchasing-codes">
                    Codes
                  </h2>
                  <CodesTab enabled={tab === 'setup'} />
                </section>
              ) : null}
            </div>
          </TabsContent>
        ) : null}
        {canApprove ? (
          <TabsContent value="approvals">
            {tab === 'approvals' ? <ApprovalsTab orders={approvesOrders} requisitions={approvesRequisitions} /> : null}
          </TabsContent>
        ) : null}
        <TabsContent value="orders">
          <OrdersTab setState={setState} state={state} />
        </TabsContent>
        <TabsContent value="requisitions">
      {list.isLoading ? (
        <DataTableSkeleton columns={columns({ steps: stepsFromLimit(0, 0), files: DEFAULT_FILE_RULES, page: DEFAULT_PAGE_LAYOUT })} label="Loading requisitions" rows={6} />
      ) : list.isError || !data ? (
        <ErrorState error={list.error} retry={() => void list.refetch()} />
      ) : (
        <div className="grid gap-4">
          {show === 'open' ? (
            <StatGroup columns="grid-cols-1 sm:grid-cols-3">
              <Stat label="Pending Approval" tone={count('PENDING_APPROVAL') ? 'warning' : 'default'} value={formatCount(count('PENDING_APPROVAL'))} />
              <Stat label="Pending Processing" tone={count('PENDING_PROCESSING') ? 'warning' : 'default'} value={formatCount(count('PENDING_PROCESSING'))} />
              <Stat label="Pending Order" tone={count('PENDING_ORDER') ? 'warning' : 'default'} value={formatCount(count('PENDING_ORDER'))} />
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
                  <SelectItem value="closed">Closed, rejected and cancelled</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {stages.length > 1 ? (
              <div className="grid gap-1.5">
                <Label htmlFor="requisitions-status">Status</Label>
                <Select onValueChange={(status) => setState({ status })} value={state.status}>
                  <SelectTrigger className="w-52" id="requisitions-status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>Every status</SelectItem>
                    {stages.map((stage) => (
                      <SelectItem key={stage} value={stage}>
                        {REQUISITION_STAGE_LABEL[stage]}
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
                    : 'Nothing has been closed, rejected or cancelled.'
              }
              icon={ClipboardListIcon}
              title={data.requisitions.length ? 'Nothing to show' : show === 'open' ? 'No open requisitions' : 'None'}
            />
          )}
        </div>
      )}
        </TabsContent>
      </Tabs>
    </>
  );
}
