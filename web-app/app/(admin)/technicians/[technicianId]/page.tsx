'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
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
import { TableCell, TableRow } from '@/components/ui/table';
import { Alert } from '@/components/ui/alert';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';

import {
  Badge,
  DataTable,
  ErrorState,
  LoadingState,
  Pagination,
  PageHeader,
  TableLoadingState,
  formatDate,
} from '@/components/shared';
import { usePermissions } from '@/lib/auth';
import { useAdminMutations, useAssignments, useTechnician } from '@/lib/queries';

export default function TechnicianDetailPage() {
  const id = useParams<{ technicianId: string }>().technicianId;
  const canManage = usePermissions().has('technicians:manage');
  const [assignmentPage, setAssignmentPage] = useState(1);
  const technician = useTechnician(id);
  const assignments = useAssignments({ technicianId: id, page: assignmentPage, pageSize: 20 });
  const mutation = useAdminMutations().updateTechnician;
  if (technician.isLoading) return <LoadingState label="Loading technician…" />;
  if (technician.isError)
    return <ErrorState error={technician.error} retry={() => void technician.refetch()} />;
  const item = technician.data!;
  async function toggle() {
    await mutation.mutateAsync({ id, isActive: !item.isActive });
  }
  return (
    <>
      <PageHeader
        title={item.displayName}
        description={item.email}
        breadcrumbs={[{ label: 'Technicians', href: '/technicians' }, { label: item.displayName }]}
        action={
          canManage ? (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <button
                  className={buttonVariants({ variant: item.isActive ? 'danger' : 'primary' })}
                  disabled={mutation.isPending}
                >
                  {item.isActive ? 'Deactivate' : 'Activate'}
                </button>
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
                    className={buttonVariants({
                      variant: item.isActive ? 'danger' : 'primary',
                    })}
                    onClick={() => void toggle()}
                  >
                    {item.isActive ? 'Deactivate' : 'Activate'}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : undefined
        }
      />
      {mutation.error ? (
        <Alert variant="destructive" role="alert">
          {mutation.error.message}
        </Alert>
      ) : null}
      <Card className="p-[22px] max-[560px]:p-4" asChild>
        <section>
        <div className="grid grid-cols-3 gap-4 max-[560px]:grid-cols-1">
          <div className="rounded-xl bg-background p-3.5">
            <span>Status</span>
            <Badge value={item.isActive ? 'ACTIVE' : 'INACTIVE'} />
          </div>
          <div className="rounded-xl bg-background p-3.5">
            <span>Current assignments</span>
            <strong>{item.workload?.current ?? 0}</strong>
          </div>
          <div className="rounded-xl bg-background p-3.5">
            <span>Account created</span>
            <strong>{formatDate(item.createdAt)}</strong>
          </div>
        </div>
        </section>
      </Card>
      <Card className="p-[22px] max-[560px]:p-4" asChild>
        <section className="section-gap">
        <CardHeader className="p-0 pb-4">
          <CardTitle className="text-[17px]">Assignment history</CardTitle>
        </CardHeader>
        {assignments.isLoading ? (
          <TableLoadingState
            headers={['Inspection', 'Assigned', 'Ended', 'Status', 'Reason']}
            rows={5}
            label="Loading assignment history"
          />
        ) : assignments.isError ? (
          <ErrorState error={assignments.error} retry={() => void assignments.refetch()} />
        ) : assignments.data?.items.length ? (
          <>
            <DataTable headers={['Inspection', 'Assigned', 'Ended', 'Status', 'Reason']}>
              {assignments.data.items.map((assignment) => (
                <TableRow key={assignment.id}>
                  <TableCell>
                    <Link className="font-semibold text-primary" href={`/inspections/${assignment.inspectionId}`}>
                      {assignment.inspection?.propertywareBuilding?.name ?? 'Open inspection'}
                    </Link>
                  </TableCell>
                  <TableCell>{formatDate(assignment.assignedAt)}</TableCell>
                  <TableCell>{formatDate(assignment.endedAt)}</TableCell>
                  <TableCell>
                    <Badge value={assignment.isCurrent ? 'CURRENT' : assignment.status} />
                  </TableCell>
                  <TableCell>{assignment.reason ?? '—'}</TableCell>
                </TableRow>
              ))}
            </DataTable>
            <Pagination
              page={assignmentPage}
              totalPages={assignments.data.totalPages}
              onPage={setAssignmentPage}
            />
          </>
        ) : (
          <p>No assignment history.</p>
        )}
        </section>
      </Card>
    </>
  );
}
