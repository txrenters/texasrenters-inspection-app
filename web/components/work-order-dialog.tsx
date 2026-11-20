'use client';

import { isUpcomingVisit, visitStateOf } from '@texasrenters/shared';

import { ErrorState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { EMPTY, formatScheduledDate, humanize } from '@/lib/format';
import { useInspection } from '@/lib/queries';

/**
 * The visit types only the maintenance app's hand-off files (the Jobber sync
 * never types a visit either way). A row of one is a work order.
 */
const WORK_ORDER_TYPES = new Set(['MAINTENANCE', 'PEST_CONTROL']);

export function isWorkOrderVisit(row: { inspectionType?: string | null }): boolean {
  return WORK_ORDER_TYPES.has(row.inspectionType ?? '');
}

/**
 * A handed-over work order, read where it was clicked.
 *
 * Not the inspection page: a work order has no rooms, baseline or report, and
 * that page read it as an inspection ("it should be a modal, and not treat it
 * as inspection", the office, 2026-11-21). What the crew needs is the work
 * order the maintenance app sent -- its text is the visit's notes -- and who is
 * going when. Nothing is approved or changed here; that stays with the
 * maintenance app.
 */
export function WorkOrderDialog({ inspectionId, onClose }: { inspectionId: string; onClose: () => void }) {
  const visit = useInspection(inspectionId);
  const data = visit.data;
  const state = data ? visitStateOf(data) : null;
  const technician = data?.assignments?.find((assignment) => assignment.isCurrent)?.technician?.displayName ?? null;
  const building = data?.propertywareBuilding;
  const address = [building?.name, data?.propertywareUnit?.name ? `Unit ${data.propertywareUnit.name}` : null]
    .filter(Boolean)
    .join(' · ');

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{data?.workOrderNumber ? `Work order #${data.workOrderNumber}` : 'Work order'}</DialogTitle>
          <DialogDescription>{address || (visit.isLoading ? 'Loading…' : EMPTY)}</DialogDescription>
        </DialogHeader>

        {visit.isLoading ? (
          <div aria-busy="true" aria-label="Loading work order" className="space-y-3">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : visit.isError ? (
          <ErrorState error={visit.error} retry={() => void visit.refetch()} />
        ) : data ? (
          <div className="space-y-4">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
              <div>
                <dt className="text-muted-foreground text-xs">Status</dt>
                <dd className="mt-0.5">{state ? <StatusBadge value={state} /> : EMPTY}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground text-xs">Crew</dt>
                <dd className="mt-0.5">{humanize(data.inspectionType)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground text-xs">Scheduled</dt>
                <dd className="mt-0.5">{formatScheduledDate(data.scheduledAt)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground text-xs">Technician</dt>
                <dd className="mt-0.5">
                  {technician ??
                    (state && isUpcomingVisit(state) ? <StatusBadge value="UNASSIGNED" /> : EMPTY)}
                </dd>
              </div>
            </dl>

            <div>
              <h3 className="text-muted-foreground mb-1 text-xs">Work order</h3>
              {data.internalNotes?.trim() ? (
                <p className="bg-muted/50 max-h-80 overflow-y-auto rounded-md p-3 text-sm whitespace-pre-wrap">
                  {data.internalNotes.trim()}
                </p>
              ) : (
                <p className="text-muted-foreground text-sm">The maintenance app sent no details.</p>
              )}
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
