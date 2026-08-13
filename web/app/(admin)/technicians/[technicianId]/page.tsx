'use client';

import { useParams, useRouter } from 'next/navigation';

import { DataTable, DataTableSkeleton, type Column } from '@/components/data-table';
import { DeleteAccountDialog } from '@/components/delete-account-dialog';
import { PageHeader } from '@/components/page-header';
import { Pagination } from '@/components/pagination';
import { StatCard } from '@/components/stat-card';
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
import { EMPTY, formatDateTime } from '@/lib/format';
import { usePermissions } from '@/lib/auth';
import { useAdminMutations, useAssignments, useTechnician } from '@/lib/queries';
import { useUrlState } from '@/lib/url-state';

type AssignmentRow = NonNullable<ReturnType<typeof useAssignments>['data']>['items'][number];

const ASSIGNMENT_COLUMNS: Array<Column<AssignmentRow>> = [
  {
    key: 'inspection',
    header: 'Inspection',
    primary: true,
    cell: (row) => row.inspection?.propertywareBuilding?.name ?? 'Open inspection',
  },
  { key: 'assigned', header: 'Assigned', cell: (row) => formatDateTime(row.assignedAt) },
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
  const canManage = usePermissions().has('technicians:manage');
  const [state, setState] = useUrlState({ page: 1 });
  const technician = useTechnician(id);
  const assignments = useAssignments({ technicianId: id, page: state.page, pageSize: 20 });
  const { updateTechnician: mutation, deleteTechnician: remove } = useAdminMutations();

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
          canManage ? (
            <>
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
              <DeleteAccountDialog
                displayName={item.displayName}
                error={remove.error}
                id={id}
                isPending={remove.isPending}
                onDelete={deleteTechnician}
                scope="TECHNICIAN"
              />
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

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="gap-0 p-5">
          <p className="text-muted-foreground text-sm font-medium">Status</p>
          <div className="mt-2">
            <StatusBadge value={item.isActive ? 'ACTIVE' : 'INACTIVE'} />
          </div>
        </Card>
        <StatCard label="Current assignments" value={item.workload?.current ?? 0} />
        <StatCard label="In progress" value={item.workload?.inProgress ?? 0} />
        <StatCard
          detail={formatDateTime(item.createdAt)}
          label="Completed"
          value={item.workload?.completed ?? 0}
        />
      </div>

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
