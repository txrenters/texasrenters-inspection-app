'use client';

import { TBP_INSPECTION_REASON_TEXT, type TbpInspectionReason } from '@texasrenters/shared';
import { AlertTriangleIcon, MoreHorizontalIcon, PanelRightOpenIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { DataTable, type Column } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Field, FieldLabel } from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { EMPTY, formatScheduledDate } from '@/lib/format';
import { usePlanningMutations, type PlanStop, type PlanStopStatus } from '@/lib/planning-queries';

export const STOP_STATUS: Record<PlanStopStatus, { label: string; variant: 'secondary' | 'warning' | 'outline' | 'success' | 'destructive' }> = {
  PLANNED: { label: 'Planned', variant: 'secondary' },
  BLOCKED: { label: 'Needs attention', variant: 'warning' },
  EXCLUDED: { label: 'Excluded', variant: 'outline' },
  PUBLISHED: { label: 'Published', variant: 'success' },
  FAILED: { label: 'Failed', variant: 'destructive' },
};

/** Why a stop is the kind of visit it is, in the office's words. */
export function reasonText(reason: string | null) {
  return reason && reason in TBP_INSPECTION_REASON_TEXT ? TBP_INSPECTION_REASON_TEXT[reason as TbpInspectionReason] : null;
}

const COLUMNS: Array<Column<PlanStop>> = [
  {
    key: 'sequence',
    header: '#',
    numeric: true,
    className: 'w-0',
    cell: (stop) => stop.sequence,
  },
  {
    key: 'property',
    header: 'Property',
    primary: true,
    cell: (stop) => (
      <div className="min-w-0">
        <div className="truncate">{stop.tenant.addressLine1 ?? EMPTY}</div>
        <div className="text-muted-foreground truncate text-xs">
          {[stop.tenant.city, stop.zone && /^\d+$/.test(stop.zone) ? `Zone ${stop.zone}` : null, stop.tenant.managementPlan]
            .filter(Boolean)
            .join(' · ')}
        </div>
      </div>
    ),
  },
  {
    key: 'visit',
    header: 'Visit',
    cell: (stop) => (
      <div className="grid gap-1">
        <div className="flex items-center gap-1.5">
          <Badge variant={stop.inspectionType === 'HVAC' ? 'info' : 'secondary'}>
            {stop.inspectionType === 'HVAC' ? 'HVAC' : 'Occupied'}
          </Badge>
          {stop.inspectionTypeNeedsReview ? (
            <AlertTriangleIcon aria-label="Worth checking" className="text-warning size-3.5" />
          ) : null}
        </div>
        <span className="text-muted-foreground text-xs">
          {reasonText(stop.inspectionTypeReason) ?? EMPTY}
          {stop.tenant.hvacPlan ? ` (${stop.tenant.hvacPlan})` : ''}
        </span>
      </div>
    ),
  },
  {
    key: 'day',
    header: 'Day',
    hideBelow: 'md',
    cell: (stop) =>
      stop.scheduledOn ? (
        <div className="min-w-0">
          <div>{formatScheduledDate(stop.scheduledOn)}</div>
          <div className="text-muted-foreground truncate text-xs">{stop.assignedTechnician?.displayName ?? 'Nobody yet'}</div>
        </div>
      ) : (
        EMPTY
      ),
  },
  {
    key: 'details',
    header: 'Details',
    hideBelow: 'xl',
    className: 'max-w-md',
    cell: (stop) => (
      <div className="min-w-0">
        <div className="truncate text-xs">{stop.visitDetails?.split('\n')[0] ?? EMPTY}</div>
        <div className="text-muted-foreground text-xs">{stop.officeDetails ? 'From the office’s sheet' : 'Written from the tenant report'}</div>
      </div>
    ),
  },
  {
    key: 'status',
    header: 'Status',
    cell: (stop) => (
      <div className="grid gap-1">
        <Badge variant={STOP_STATUS[stop.status].variant}>{STOP_STATUS[stop.status].label}</Badge>
        {stop.blockedMessage ? <span className="text-muted-foreground text-xs text-pretty">{stop.blockedMessage}</span> : null}
      </div>
    ),
  },
];

export function PlanStopsTable({
  stops,
  editable,
  onOpen,
}: {
  stops: PlanStop[];
  editable: boolean;
  /** Opens a visit's details, as its pin on the map does. */
  onOpen?: (stopId: string) => void;
}) {
  const { setType, exclude } = usePlanningMutations();
  const [excluding, setExcluding] = useState<PlanStop | null>(null);
  const [reason, setReason] = useState('');

  const changeType = (stop: PlanStop) => {
    const inspectionType = stop.inspectionType === 'HVAC' ? 'OCCUPIED' : 'HVAC';
    setType.mutate(
      { stopId: stop.id, inspectionType },
      {
        onSuccess: () =>
          toast.success(`${stop.tenant.addressLine1 ?? 'The visit'} is now an ${inspectionType === 'HVAC' ? 'HVAC' : 'occupied'} inspection`, {
            description: 'Its day is measured again with the new length.',
          }),
        onError: (error) => toast.error('The visit could not be changed', { description: error.message }),
      },
    );
  };

  const confirmExclude = () => {
    if (!excluding) return;
    exclude.mutate(
      { stopId: excluding.id, reason: reason.trim() },
      {
        onSuccess: (result) => {
          if (!result.excluded) {
            toast.error(result.message ?? 'This visit can no longer be excluded.');
            return;
          }
          toast.success(`${excluding.tenant.addressLine1 ?? 'The visit'} is left out of this quarter`);
          setExcluding(null);
          setReason('');
        },
        onError: (error) => toast.error('The visit could not be excluded', { description: error.message }),
      },
    );
  };

  const editableStop = (stop: PlanStop) => editable && !stop.inspectionId && stop.status !== 'PUBLISHED' && stop.status !== 'EXCLUDED';

  return (
    <>
      <DataTable
        actions={(stop) => (
          <div className="flex items-center justify-end gap-0.5">
            {onOpen ? (
              <Button
                aria-label={`Details of the visit at ${stop.tenant.addressLine1 ?? 'this property'}`}
                className="relative z-10"
                onClick={() => onOpen(stop.id)}
                size="icon-sm"
                title="Details"
                variant="ghost"
              >
                <PanelRightOpenIcon />
              </Button>
            ) : null}
            {editableStop(stop) ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button aria-label={`Change the visit at ${stop.tenant.addressLine1 ?? 'this property'}`} className="relative z-10" size="icon-sm" variant="ghost">
                  <MoreHorizontalIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem disabled={setType.isPending} onSelect={() => changeType(stop)}>
                  {stop.inspectionType === 'HVAC' ? 'Make it an occupied inspection' : 'Make it an HVAC inspection'}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => setExcluding(stop)} variant="destructive">
                  Leave out of this quarter…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            ) : null}
          </div>
        )}
        columns={COLUMNS}
        label="Visits in this quarter's plan"
        rowKey={(stop) => stop.id}
        rows={stops}
      />

      <Dialog onOpenChange={(open) => !open && setExcluding(null)} open={Boolean(excluding)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Leave {excluding?.tenant.addressLine1 ?? 'this visit'} out of the quarter?</DialogTitle>
            <DialogDescription>
              No inspection is created and no visit is booked for this tenancy this quarter. The reason stays on the plan.
            </DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="exclude-reason">Why</FieldLabel>
            <Textarea
              id="exclude-reason"
              onChange={(event) => setReason(event.target.value)}
              placeholder="Tenant moving out on Oct 15"
              rows={3}
              value={reason}
            />
          </Field>
          <DialogFooter>
            <Button onClick={() => setExcluding(null)} variant="outline">
              Keep it
            </Button>
            <Button disabled={reason.trim().length < 2 || exclude.isPending} onClick={confirmExclude} variant="destructive">
              {exclude.isPending ? <Spinner /> : null}
              Leave it out
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
