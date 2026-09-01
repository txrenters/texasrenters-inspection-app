'use client';

import { useState } from 'react';

import { DataTable, DataTableSkeleton, type Column } from '@/components/data-table';
import { PageHeader } from '@/components/page-header';
import { Stat, StatGroup } from '@/components/stat-card';
import { EmptyState, ErrorState, PageSkeleton } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { usePermissions } from '@/lib/auth';
import { EMPTY, formatCount, formatDateTime, formatRelative, humanize } from '@/lib/format';
import {
  useJobberConnection,
  useJobberMutations,
  useJobberQueue,
  useJobberVisitImports,
  useLeases,
  usePropertyOptions,
  useUnits,
} from '@/lib/queries';
import { useUrlState } from '@/lib/url-state';

type QueueRow = NonNullable<ReturnType<typeof useJobberQueue>['data']>[number];
type VisitRow = NonNullable<ReturnType<typeof useJobberVisitImports>['data']>[number];

/**
 * Why a link is waiting, in the order a person can act on it.
 *
 * AMBIGUOUS and UNMATCHED need different things — one is "choose between these",
 * the other is "find this property" — so they are not collapsed into a single
 * "needs attention" badge that would tell a coordinator nothing about what to do
 * next.
 */
const QUEUE_COLUMNS = (onLink: (row: QueueRow) => void, canManage: boolean): Column<QueueRow>[] => [
  {
    key: 'address',
    header: 'Jobber property',
    primary: true,
    cell: (row) => (
      <div className="min-w-0">
        <div className="truncate font-medium">{row.jobberAddress ?? 'No address in Jobber'}</div>
        {row.jobberClientName ? (
          <div className="text-muted-foreground truncate text-xs">{row.jobberClientName}</div>
        ) : null}
      </div>
    ),
  },
  { key: 'status', header: 'State', cell: (row) => <StatusBadge value={row.status} /> },
  {
    key: 'reason',
    header: 'What is needed',
    hideBelow: 'md',
    cell: (row) => (
      <span className="text-muted-foreground text-sm">{row.unresolvedReason ?? EMPTY}</span>
    ),
  },
  {
    key: 'suggested',
    header: 'Suggested property',
    hideBelow: 'lg',
    // Present only when address matching got as far as a building but could not
    // finish — showing it saves the coordinator searching for what we already found.
    cell: (row) =>
      row.propertywareBuilding ? (
        <Badge variant="outline">{row.propertywareBuilding.name}</Badge>
      ) : (
        EMPTY
      ),
  },
  {
    key: 'blocked',
    header: 'Visits held',
    numeric: true,
    // The number that says how much work is stuck behind this row, which is why
    // the queue is worth working in any particular order.
    cell: (row) => formatCount(row._count?.visitImports ?? 0),
  },
  {
    key: 'action',
    header: '',
    cell: (row) =>
      canManage ? (
        <Button size="sm" variant="outline" onClick={() => onLink(row)}>
          Resolve
        </Button>
      ) : null,
  },
];

const VISIT_COLUMNS: Column<VisitRow>[] = [
  {
    key: 'property',
    header: 'Property',
    primary: true,
    cell: (row) => (
      <div className="min-w-0">
        <div className="truncate">{row.link?.jobberAddress ?? 'Unknown property'}</div>
        <div className="text-muted-foreground truncate text-xs">Visit {row.jobberVisitId}</div>
      </div>
    ),
  },
  { key: 'status', header: 'State', cell: (row) => <StatusBadge value={row.status} /> },
  {
    key: 'why',
    header: 'Why it was held',
    cell: (row) => (
      <div className="min-w-0">
        <div className="truncate text-sm">{row.failureMessage ?? EMPTY}</div>
        {row.failureCode ? (
          <code className="text-muted-foreground text-xs">{row.failureCode}</code>
        ) : null}
      </div>
    ),
  },
  {
    key: 'attempts',
    header: 'Tries',
    numeric: true,
    hideBelow: 'sm',
    cell: (row) => formatCount(row.attempts),
  },
  {
    key: 'last',
    header: 'Last tried',
    hideBelow: 'lg',
    cell: (row) => formatRelative(row.lastAttemptAt),
  },
];

export default function JobberIntegrationPage() {
  const canManage = usePermissions().has('integrations:manage');
  const [state, setState] = useUrlState({ tab: 'queue' });
  const connection = useJobberConnection();
  const queue = useJobberQueue();
  const visits = useJobberVisitImports();
  const mutations = useJobberMutations();
  const [linking, setLinking] = useState<QueueRow | null>(null);
  const queueColumns = QUEUE_COLUMNS((row) => setLinking(row), canManage);

  if (connection.isLoading) return <PageSkeleton />;
  if (connection.isError)
    return <ErrorState error={connection.error} retry={() => void connection.refetch()} />;

  const jobber = connection.data;
  const connected = jobber?.status === 'CONNECTED';

  /**
   * Consent happens in Jobber, in a browser, as a Jobber admin.
   *
   * The backend returns the URL rather than redirecting, because a 302 would be
   * followed by fetch and land Jobber's login page inside an XHR response. The
   * new tab is opened here, from the click, so the browser does not treat it as
   * a popup.
   */
  const connect = async () => {
    const { authorizationUrl } = await mutations.authorize.mutateAsync();
    window.open(authorizationUrl, '_blank', 'noopener,noreferrer');
  };

  /**
   * Why a connected account still needs this.
   *
   * Widening the app's scopes in Jobber invalidates its refresh token, so a
   * connection that looks healthy stops working at the next refresh. Consenting
   * again is the fix, and it is the same flow as the first connection — the
   * backend upserts onto the existing row and keeps the account identity.
   */
  const reconnectHint =
    connected && jobber?.status === 'CONNECTED'
      ? 'Reconnect after changing the app’s scopes in Jobber — a scope change invalidates the stored credentials.'
      : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Jobber"
        description="Scheduling comes from Jobber. Inspections are created from its visits."
        actions={
          <div className="flex items-center gap-3">
            <StatusBadge value={jobber?.status ?? 'DISCONNECTED'} />
            {canManage ? (
              connected ? (
                <>
                  <Button
                    variant="outline"
                    disabled={mutations.sync.isPending}
                    onClick={() => mutations.sync.mutate()}
                  >
                    {mutations.sync.isPending ? 'Syncing…' : 'Sync now'}
                  </Button>
                  {/* Re-authorizing is a normal thing to need: Jobber
                      invalidates the refresh token whenever the app's scopes
                      change, and the only route was previously Disconnect then
                      Connect — unobvious, and it revokes a working connection
                      to fix one that merely needs widening. */}
                  <Button
                    variant="outline"
                    disabled={mutations.authorize.isPending}
                    onClick={() => void connect()}
                  >
                    Reconnect
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={mutations.disconnect.isPending}
                    onClick={() => mutations.disconnect.mutate()}
                  >
                    Disconnect
                  </Button>
                </>
              ) : (
                <Button disabled={mutations.authorize.isPending} onClick={() => void connect()}>
                  Connect Jobber
                </Button>
              )
            ) : null}
          </div>
        }
      />

      {/* Re-authorization is not a transient error: nothing syncs until a Jobber
          admin consents again, so it is stated rather than left to a badge. */}
      {jobber?.status === 'REAUTHORIZATION_REQUIRED' ? (
        <Alert variant="destructive">
          <AlertDescription>
            Jobber refused the stored credentials{' '}
            {jobber.lastRefreshError ? `— ${jobber.lastRefreshError}` : ''}. A Jobber administrator
            has to connect it again before any scheduling syncs.
          </AlertDescription>
        </Alert>
      ) : null}

      {jobber?.lastSyncError ? (
        <Alert variant="destructive">
          <AlertDescription>Last sync failed: {jobber.lastSyncError}</AlertDescription>
        </Alert>
      ) : null}

      {mutations.sync.isSuccess ? (
        <Alert>
          <AlertDescription>
            {formatCount(mutations.sync.data.visitsSeen)} visits seen,{' '}
            {formatCount(mutations.sync.data.imported)} imported,{' '}
            {formatCount(mutations.sync.data.unmatched)} waiting on a property,{' '}
            {formatCount(mutations.sync.data.rejected)} held.
            {/* Only when it happened. This one takes inspections out of the
                scheduled list, so a reader needs to see it — but printing
                "0 closed" on every ordinary sync is noise. */}
            {mutations.sync.data.completedFromJobber > 0
              ? ` ${formatCount(mutations.sync.data.completedFromJobber)} closed because Jobber finished the visit.`
              : null}
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Connection</CardTitle>
          <CardDescription>
            {connected
              ? `Reading the calendar for ${jobber?.jobberAccountName ?? 'this Jobber account'}.`
              : 'Not connected. Nothing is being imported.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {reconnectHint ? (
            <p className="text-muted-foreground text-xs">{reconnectHint}</p>
          ) : null}
          <StatGroup columns="grid-cols-1 sm:grid-cols-3 lg:grid-cols-5">
            <Stat label="Account" value={jobber?.jobberAccountName ?? EMPTY} />
            <Stat label="Schema version" value={jobber?.apiVersion ?? EMPTY} />
            <Stat label="Last sync" value={formatRelative(jobber?.lastSyncCompletedAt)} />
            <Stat label="Visits last read" value={formatCount(jobber?.lastSyncVisitCount ?? 0)} />
            <Stat label="Connected" value={formatDateTime(jobber?.connectedAt)} />
          </StatGroup>
        </CardContent>
      </Card>

      <Tabs value={state.tab} onValueChange={(tab) => setState({ tab })}>
        <TabsList>
          <TabsTrigger value="queue">
            Properties to map
            {queue.data?.length ? ` (${queue.data.length})` : ''}
          </TabsTrigger>
          <TabsTrigger value="visits">
            Held visits
            {visits.data?.length ? ` (${visits.data.length})` : ''}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="queue" className="mt-4">
          {queue.isLoading ? (
            <DataTableSkeleton columns={queueColumns} />
          ) : queue.data?.length === 0 ? (
            <EmptyState
              title="Every Jobber property is mapped"
              description="New properties appear here the first time a visit is seen at one."
            />
          ) : (
            <DataTable
              rows={queue.data ?? []}
              columns={queueColumns}
              rowKey={(row) => row.id}
              label="Jobber properties awaiting mapping"
            />
          )}
        </TabsContent>

        <TabsContent value="visits" className="mt-4">
          {visits.isLoading ? (
            <DataTableSkeleton columns={VISIT_COLUMNS} />
          ) : visits.data?.length === 0 ? (
            <EmptyState
              title="No visits are held"
              description="Visits appear here when a scheduling rule refuses them or their property is unmapped."
            />
          ) : (
            <DataTable
              rows={visits.data ?? []}
              columns={VISIT_COLUMNS}
              rowKey={(row) => row.id}
              label="Jobber visits that were held"
            />
          )}
        </TabsContent>
      </Tabs>

      <LinkDialog
        row={linking}
        onClose={() => setLinking(null)}
        onLink={async (input) => {
          await mutations.link.mutateAsync(input);
          setLinking(null);
        }}
        onIgnore={async (linkId) => {
          await mutations.ignore.mutateAsync({ linkId });
          setLinking(null);
        }}
      />
    </div>
  );
}

/**
 * Ties one Jobber property to a building, and to a unit where the building has
 * them.
 *
 * The unit step is not optional decoration: a building with units cannot back
 * an inspection without one, which is why such a property reaches this queue
 * even when its address matched exactly.
 */
function LinkDialog({
  row,
  onClose,
  onLink,
  onIgnore,
}: {
  row: QueueRow | null;
  onClose: () => void;
  onLink: (input: {
    linkId: string;
    buildingId: string;
    unitId?: string;
    leaseId?: string;
  }) => Promise<void>;
  onIgnore: (linkId: string) => Promise<void>;
}) {
  const [search, setSearch] = useState('');
  const [buildingId, setBuildingId] = useState('');
  const [unitId, setUnitId] = useState('');
  const [leaseId, setLeaseId] = useState('');
  const [busy, setBusy] = useState(false);

  // Seeded from the partial match the backend already found, so a coordinator
  // confirms an answer instead of searching for one we have.
  const selectedBuilding = buildingId || row?.propertywareBuildingId || '';
  const properties = usePropertyOptions('', search);
  const units = useUnits(selectedBuilding);
  const leases = useLeases(unitId);
  const unitOptions = units.data?.items ?? [];
  const needsUnit = unitOptions.length > 0;

  const reset = () => {
    setSearch('');
    setBuildingId('');
    setUnitId('');
    setLeaseId('');
  };

  if (!row) return null;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          reset();
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Map this Jobber property</DialogTitle>
          <DialogDescription>
            {row.jobberAddress ?? 'No address in Jobber'}
            {row.jobberClientName ? ` — ${row.jobberClientName}` : ''}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="jobber-property-search">
              Our property
            </label>
            <Input
              id="jobber-property-search"
              placeholder="Search by address or name"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <div className="max-h-48 space-y-1 overflow-y-auto">
              {properties.data?.pages
                .flatMap((page) => page.items)
                .map((property) => (
                  <button
                    key={property.id}
                    type="button"
                    onClick={() => {
                      setBuildingId(property.id);
                      setUnitId('');
                      setLeaseId('');
                    }}
                    className={`w-full rounded-md border px-3 py-2 text-left text-sm ${
                      selectedBuilding === property.id ? 'border-primary bg-accent' : 'border-border'
                    }`}
                  >
                    <div className="font-medium">{property.name}</div>
                    <div className="text-muted-foreground text-xs">
                      {[property.addressLine1, property.city, property.postalCode]
                        .filter(Boolean)
                        .join(', ')}
                    </div>
                  </button>
                ))}
            </div>
          </div>

          {selectedBuilding && needsUnit ? (
            <div className="space-y-2">
              <label className="text-sm font-medium">Unit</label>
              <Select value={unitId} onValueChange={setUnitId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose the unit Jobber means" />
                </SelectTrigger>
                <SelectContent>
                  {unitOptions.map((unit) => (
                    <SelectItem key={unit.id} value={unit.id}>
                      {unit.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-muted-foreground text-xs">
                This property has units, so an inspection cannot be created without knowing which
                one.
              </p>
            </div>
          ) : null}

          {unitId && leases.data?.items.length ? (
            <div className="space-y-2">
              <label className="text-sm font-medium">Lease (optional)</label>
              <Select value={leaseId} onValueChange={setLeaseId}>
                <SelectTrigger>
                  <SelectValue placeholder="No lease" />
                </SelectTrigger>
                <SelectContent>
                  {leases.data.items.map((lease) => (
                    <SelectItem key={lease.id} value={lease.id}>
                      {lease.leaseName ?? humanize(lease.sourceStatus ?? 'Lease')}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <Button
            variant="ghost"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onIgnore(row.id);
                reset();
              } finally {
                setBusy(false);
              }
            }}
          >
            Not ours to inspect
          </Button>
          <Button
            disabled={busy || !selectedBuilding || (needsUnit && !unitId)}
            onClick={async () => {
              setBusy(true);
              try {
                await onLink({
                  linkId: row.id,
                  buildingId: selectedBuilding,
                  unitId: unitId || undefined,
                  leaseId: leaseId || undefined,
                });
                reset();
              } finally {
                setBusy(false);
              }
            }}
          >
            Link property
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
