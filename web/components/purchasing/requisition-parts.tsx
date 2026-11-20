import {
  PURCHASE_ORDER_STATUS_LABEL,
  REQUISITION_STAGE_LABEL,
  REQUISITION_STAGE_STEPS,
  REQUISITION_STATUS_LABEL,
  approvalStepFor,
  approverSaying,
  type PurchaseOrderStatus,
  type PurchasingSettings,
  type RequisitionRow,
  type RequisitionStage,
  type RequisitionStatus,
} from '@texasrenters/shared';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const TONE: Record<RequisitionStatus, 'secondary' | 'warning' | 'info' | 'success' | 'destructive'> = {
  DRAFT: 'secondary',
  SUBMITTED: 'warning',
  SENT_BACK: 'info',
  APPROVED: 'success',
  ORDERED: 'secondary',
  REJECTED: 'destructive',
  CANCELLED: 'secondary',
  CLOSED: 'secondary',
};

export function RequisitionStatusBadge({ status }: { status: RequisitionStatus }) {
  return <Badge variant={TONE[status]}>{REQUISITION_STATUS_LABEL[status]}</Badge>;
}

/** A requisition's stage, NAV's way (2026-11-21): amber where somebody in the office is to act. */
const STAGE_TONE: Record<RequisitionStage, 'secondary' | 'warning' | 'info' | 'success' | 'destructive'> = {
  OPEN: 'secondary',
  PENDING_APPROVAL: 'warning',
  SENT_BACK: 'info',
  PENDING_PROCESSING: 'warning',
  PENDING_ORDER: 'warning',
  ORDERED: 'success',
  RECEIVED: 'info',
  CLOSED: 'secondary',
  REJECTED: 'destructive',
  CANCELLED: 'secondary',
};

export function RequisitionStageBadge({ stage }: { stage: RequisitionStage }) {
  return <Badge variant={STAGE_TONE[stage]}>{REQUISITION_STAGE_LABEL[stage]}</Badge>;
}

/** Whose turn it is at each stage, in the office's words (2026-11-21). */
export function waitingOn(row: Pick<RequisitionRow, 'stage' | 'requestedBy' | 'department' | 'estimatedTotalCents'>, settings: PurchasingSettings): string {
  switch (row.stage) {
    case 'OPEN':
    case 'SENT_BACK':
      return row.requestedBy.name;
    case 'PENDING_APPROVAL':
      return row.department ? `An approver of ${row.department.code}` : approverFor(row.estimatedTotalCents, settings);
    case 'PENDING_PROCESSING':
      return 'A purchaser, to make the order';
    case 'PENDING_ORDER':
      return 'The purchasing manager, then the purchaser';
    case 'ORDERED':
      return 'The vendor';
    case 'RECEIVED':
      return 'Accounts, to pay the bill';
    default:
      return '—';
  }
}

/** Who a requisition of this size goes to, in the office's words: by the approval step its amount falls in. */
export function approverFor(totalCents: number, settings: PurchasingSettings): string {
  return approverSaying(approvalStepFor(totalCents, settings.steps));
}

const ORDER_TONE: Record<PurchaseOrderStatus, 'secondary' | 'warning' | 'info' | 'success'> = {
  DRAFT: 'secondary',
  AWAITING_APPROVAL: 'warning',
  APPROVED: 'info',
  SENT: 'success',
  PARTLY_RECEIVED: 'warning',
  RECEIVED: 'info',
  CLOSED: 'secondary',
  CANCELLED: 'secondary',
};

export function PurchaseOrderStatusBadge({ status }: { status: PurchaseOrderStatus }) {
  return <Badge variant={ORDER_TONE[status]}>{PURCHASE_ORDER_STATUS_LABEL[status]}</Badge>;
}

/** Draft to Closed: where an order is on its way. Its bill has its own state, shown beside it. */
export function PurchaseOrderSteps({ status }: { status: PurchaseOrderStatus }) {
  const reached = { DRAFT: 0, AWAITING_APPROVAL: 1, APPROVED: 2, SENT: 3, PARTLY_RECEIVED: 4, RECEIVED: 5, CLOSED: 6, CANCELLED: 0 }[status];
  const ended = status === 'CANCELLED';
  return (
    <Steps
      ended={ended}
      label="Where this order is"
      reached={reached}
      steps={['Open', 'Pending Approval', 'Released', 'Sent to Vendor', 'Partly Received', 'Received', 'Closed']}
      tail={ended ? 'Cancelled' : null}
    />
  );
}

/** NAV's way, Open to Closed (2026-11-21): where the requisition is. One sent back is with its requester again; one that left the way says where it ended. */
export function RequisitionSteps({ stage }: { stage: RequisitionStage }) {
  const ended = stage === 'REJECTED' || stage === 'CANCELLED';
  const reached = stage === 'SENT_BACK' || ended ? 0 : REQUISITION_STAGE_STEPS.indexOf(stage);
  return (
    <Steps
      ended={ended}
      label="Where this requisition is"
      reached={reached}
      steps={REQUISITION_STAGE_STEPS.map((step) => REQUISITION_STAGE_LABEL[step])}
      tail={ended || stage === 'SENT_BACK' ? REQUISITION_STAGE_LABEL[stage] : null}
    />
  );
}

function Steps({ steps, reached, ended, tail, label }: { steps: readonly string[]; reached: number; ended: boolean; tail: string | null; label: string }) {
  return (
    <ol aria-label={label} className="flex flex-wrap items-center gap-1.5 text-xs font-medium">
      {steps.map((step, index) => (
        <li className="flex items-center gap-1.5" key={step}>
          {index ? <span aria-hidden className="text-muted-foreground">›</span> : null}
          <span
            aria-current={!ended && index === reached ? 'step' : undefined}
            className={cn(
              'rounded-full px-2.5 py-1',
              ended || index > reached ? 'bg-muted text-muted-foreground' : index === reached ? 'bg-foreground text-background' : 'bg-success/10 text-success',
            )}
          >
            {step}
          </span>
        </li>
      ))}
      {tail ? (
        <li className="flex items-center gap-1.5">
          <span aria-hidden className="text-muted-foreground">·</span>
          <span className="text-muted-foreground">{tail}</span>
        </li>
      ) : null}
    </ol>
  );
}
