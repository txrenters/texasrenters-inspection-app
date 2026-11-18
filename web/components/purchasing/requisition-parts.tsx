import { REQUISITION_STATUS_LABEL, type PurchasingSettings, type RequisitionStatus } from '@texasrenters/shared';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const TONE: Record<RequisitionStatus, 'secondary' | 'warning' | 'info' | 'success' | 'destructive'> = {
  DRAFT: 'secondary',
  SUBMITTED: 'warning',
  SENT_BACK: 'info',
  APPROVED: 'success',
  REJECTED: 'destructive',
  CANCELLED: 'secondary',
};

export function RequisitionStatusBadge({ status }: { status: RequisitionStatus }) {
  return <Badge variant={TONE[status]}>{REQUISITION_STATUS_LABEL[status]}</Badge>;
}

/** Who a requisition of this size goes to, in the office's words. */
export function approverFor(totalCents: number, settings: PurchasingSettings): string {
  return totalCents > settings.approvalLimitCents ? 'Somebody who may approve any amount' : 'An approver';
}

/** Draft, Submitted, Approved: where the requisition is on its way. One that left the way says where it ended instead. */
export function RequisitionSteps({ status }: { status: RequisitionStatus }) {
  const reached = status === 'APPROVED' ? 2 : status === 'SUBMITTED' ? 1 : 0;
  const ended = status === 'REJECTED' || status === 'CANCELLED';
  return (
    <ol aria-label="Where this requisition is" className="flex flex-wrap items-center gap-1.5 text-xs font-medium">
      {['Draft', 'Submitted', 'Approved'].map((step, index) => (
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
      {ended || status === 'SENT_BACK' ? (
        <li className="flex items-center gap-1.5">
          <span aria-hidden className="text-muted-foreground">·</span>
          <span className="text-muted-foreground">{REQUISITION_STATUS_LABEL[status]}</span>
        </li>
      ) : null}
    </ol>
  );
}
