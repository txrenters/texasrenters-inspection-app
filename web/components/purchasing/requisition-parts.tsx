import {
  PURCHASE_ORDER_STATUS_LABEL,
  REQUISITION_STATUS_LABEL,
  approvalStepFor,
  approverSaying,
  type PurchaseOrderStatus,
  type PurchasingSettings,
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
    <Steps ended={ended} label="Where this order is" reached={reached} steps={['Draft', 'Waiting for approval', 'Approved', 'Sent', 'Partly received', 'Received', 'Closed']} tail={ended ? 'Cancelled' : null} />
  );
}

/** Draft, Submitted, Approved, Ordered: where the requisition is on its way. One that left the way says where it ended instead. */
export function RequisitionSteps({ status }: { status: RequisitionStatus }) {
  const reached = status === 'CLOSED' ? 4 : status === 'ORDERED' ? 3 : status === 'APPROVED' ? 2 : status === 'SUBMITTED' ? 1 : 0;
  const ended = status === 'REJECTED' || status === 'CANCELLED';
  return (
    <Steps ended={ended} label="Where this requisition is" reached={reached} steps={['Draft', 'Submitted', 'Approved', 'Ordered', 'Received and paid']} tail={ended || status === 'SENT_BACK' ? REQUISITION_STATUS_LABEL[status] : null} />
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
