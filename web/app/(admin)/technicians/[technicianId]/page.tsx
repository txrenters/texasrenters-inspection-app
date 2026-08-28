'use client';

import { useParams, useRouter } from 'next/navigation';

import { DataTable, DataTableSkeleton, type Column } from '@/components/data-table';
import { DeleteAccountDialog } from '@/components/delete-account-dialog';
import { PageHeader } from '@/components/page-header';
import { Pagination } from '@/components/pagination';
import { Stat, StatGroup } from '@/components/stat-card';
import { EmptyState, ErrorState, PageSkeleton } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { TechnicianRouteCard } from '@/components/technician-route-card';
import { EMPTY, formatDateTime } from '@/lib/format';
import { usePermissions } from '@/lib/auth';
import {
  useAdminMutations,
  useAssignments,
  useTechnician,
  useTechnicianRoute,
} from '@/lib/queries';
import { isOverdue, localToday, scheduledDay } from '@/lib/overdue';
import { useUrlState } from '@/lib/url-state';

type AssignmentRow = NonNullable<ReturnType<typeof useAssignments>['data']>['items'][number];

const ASSIGNMENT_COLUMNS: Array<Column<AssignmentRow>> = [
  {
    key: 'inspection',
    header: 'Inspection',
    primary: true,
    cell: (row) => row.inspection?.propertywareBuilding?.name ?? 'Open inspection',
  },
  /**
   * When the work is due -- which is not what "Assigned" says.
   *
   * `assignedAt` is when somebody handed the job out; `scheduledAt` is the day
   * it has to happen. Without both, a page showing four assignments all dated
   * the twenty-fifth beside a route for the twenty-eighth cannot be
   * reconciled, and three of those four were work nothing on this screen
   * accounted for.
   *
   * The date is rendered from its own `yyyy-MM-dd`, never through a `Date`:
   * `scheduledAt` is a Postgres `date` serialised at midnight UTC, and
   * localising it moves it to the previous day anywhere west of Greenwich.
   */
  {
    key: 'scheduled',
    header: 'Scheduled',
    cell: (row) => {
      const day = scheduledDay(row.inspection?.scheduledAt);
      if (!day) return EMPTY;

      const overdue = isOverdue({
        isCurrent: row.isCurrent,
        scheduledAt: row.inspection?.scheduledAt,
        status: row.inspection?.status,
        today: localToday(),
      });

      return (
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="tabular-nums">{day}</span>
          {/* Words, not just a colour: this is the one cell on the page that
              reports a problem, and it has to survive greyscale and a screen
              reader. */}
          {overdue ? <StatusBadge value="OVERDUE" /> : null}
        </span>
      );
    },
  },
  { key: 'assigned', header: 'Assigned', hideBelow: 'md', cell: (row) => formatDateTime(row.assignedAt) },
  { key: 'ended', header: 'Ended', hideBelow: 'md', cell: (row) => formatDateTime(row.endedAt) },
  {
    key: 'status',
    header: 'Status',
    cell: (row) => <StatusBadge value={row.isCurrent ? 'CURRENT' : row.status} />,
  },
  {
    key: 'reason',
    header: 'Reason',
    hideBelow: 'lg',
    cell: (row) => <span className="text-muted-foreground">{row.reason ?? EMPTY}</span>,
  },
];

export default function TechnicianDetailPage() {
  const id = useParams<{ technicianId: string }>().technicianId;
  const router = useRouter();
  const permissions = usePermissions();
  const canManage = permissions.has('technicians:manage');
  // A separate grant from `technicians:manage`: issuing a credential and
  // activating an account are different powers, and somebody may hold one
  // without the other.
  const canProvision = permissions.has('technicians:provision');
  const [state, setState] = useUrlState({ page: 1 });
  const technician = useTechnician(id);
  const assignments = useAssignments({ technicianId: id, page: state.page, pageSize: 20 });
  // Today, in the technician's own calendar day. The schema stores a date with
  // no clock value, so there is no narrower window to ask for.
  const today = new Date().toISOString().slice(0, 10);
  const route = useTechnicianRoute(id, today, permissions.has('technicians:read'));
  const {
    updateTechnician: mutation,
    deleteTechnician: remove,
    sendTechnicianPasswordReset: sendReset,
  } = useAdminMutations();

  // isError first: a failed fetch has no data either.
  if (technician.isError)
    return <ErrorState error={technician.error} retry={() => void technician.refetch()} />;
  if (!technician.data) return <PageSkeleton cards={2} />;
  const item = technician.data;

  async function toggle() {
    try {
      await mutation.mutateAsync({ id, isActive: !item.isActive });
    } catch {
      // The mutation surfaces the sanitized API error inline.
    }
  }

  async function sendPasswordReset() {
    try {
      await sendReset.mutateAsync(id);
    } catch {
      // Rendered inline below, alongside the other mutation errors.
    }
  }

  async function deleteTechnician() {
    try {
      await remove.mutateAsync(id);
      // This page is about a record that no longer exists.
      router.push('/technicians');
    } catch {
      // The dialog renders the sanitized API error, including the reason the
      // account could not be deleted, so the confirmation stays open.
    }
  }

  return (
    <>
      <PageHeader
        actions={
          canManage || canProvision ? (
            <>
              {canProvision ? (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button disabled={sendReset.isPending} variant="outline">
                      {sendReset.isPending ? 'Sending…' : 'Send password reset'}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Send {item.displayName} a reset link?</AlertDialogTitle>
                      <AlertDialogDescription>
                        A link goes to {item.email} and expires in an hour. It sets a new password
                        and nothing else — it is not a way to sign in as them. Any reset link sent
                        earlier stops working.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={() => void sendPasswordReset()}>
                        Send link
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              ) : null}
              {canManage ? (
                <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    disabled={mutation.isPending}
                    variant={item.isActive ? 'destructive' : 'default'}
                  >
                    {item.isActive ? 'Deactivate' : 'Activate'}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {item.isActive ? 'Deactivate' : 'Activate'} {item.displayName}?
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {item.isActive
                        ? 'They lose access to the mobile app immediately. Inspections already assigned to them stay assigned and must be reassigned separately.'
                        : 'They regain access to the mobile app and can be assigned inspections again.'}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      className={
                        item.isActive ? buttonVariants({ variant: 'destructive' }) : undefined
                      }
                      onClick={() => void toggle()}
                    >
                      {item.isActive ? 'Deactivate' : 'Activate'}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
              ) : null}
              {canManage ? (
                <DeleteAccountDialog
                  displayName={item.displayName}
                  error={remove.error}
                  id={id}
                  isPending={remove.isPending}
                  onDelete={deleteTechnician}
                  scope="TECHNICIAN"
                />
              ) : null}
            </>
          ) : undefined
        }
        description={item.email}
        title={item.displayName}
      />

      {mutation.error ? (
        <Alert className="mb-4" variant="destructive">
          <AlertDescription>{mutation.error.message}</AlertDescription>
        </Alert>
      ) : null}

      {sendReset.error ? (
        <Alert className="mb-4" variant="destructive">
          <AlertDescription>{sendReset.error.message}</AlertDescription>
        </Alert>
      ) : null}

      {/* `delivered` is reported separately because the two outcomes need
          different actions. The link exists either way — that is the sensitive
          part and it is audited — but if the mail did not leave, telling the
          technician to check their inbox sends them looking for nothing. */}
      {sendReset.data ? (
        <Alert className="mb-4" variant={sendReset.data.delivered ? 'default' : 'destructive'}>
          <AlertDescription>
            {sendReset.data.delivered
              ? `Reset link sent to ${sendReset.data.email}. It expires in an hour.`
              : `A reset link was created for ${sendReset.data.email}, but the email could not be sent. Check mail delivery before telling them to look for it.`}
          </AlertDescription>
        </Alert>
      ) : null}

      <StatGroup columns="grid-cols-2 lg:grid-cols-4">
        <Stat label="Status" value={<StatusBadge value={item.isActive ? 'ACTIVE' : 'INACTIVE'} />} />
        <Stat label="Current assignments" value={item.workload?.current ?? 0} />
        <Stat label="In progress" value={item.workload?.inProgress ?? 0} />
        <Stat
          detail={formatDateTime(item.createdAt)}
          label="Completed"
          value={item.workload?.completed ?? 0}
        />
      </StatGroup>

      <TechnicianRouteCard displayName={item.displayName} route={route.data} />

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Assignment history</CardTitle>
        </CardHeader>
        <CardContent>
          {assignments.isLoading ? (
            <DataTableSkeleton
              columns={ASSIGNMENT_COLUMNS}
              label="Loading assignment history"
              rows={5}
            />
          ) : assignments.isError ? (
            <ErrorState error={assignments.error} retry={() => void assignments.refetch()} />
          ) : assignments.data?.items.length ? (
            <>
              <DataTable
                columns={ASSIGNMENT_COLUMNS}
                label="Assignment history"
                rowHref={(row) => `/inspections/${row.inspectionId}`}
                rowKey={(row) => row.id}
                rows={assignments.data.items}
              />
              <Pagination
                onPage={(page) => setState({ page })}
                page={state.page}
                total={assignments.data.total}
                totalPages={assignments.data.totalPages}
              />
            </>
          ) : (
            <EmptyState
              description="This technician has not been assigned an inspection yet."
              title="No assignment history"
            />
          )}
        </CardContent>
      </Card>
    </>
  );
}
