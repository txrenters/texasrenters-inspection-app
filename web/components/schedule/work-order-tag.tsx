import type { JobberDayWorkOrder } from '@texasrenters/shared';

import { cn } from '@/lib/utils';

/** What is still missing before a work order is ready to send someone: approval, else an estimate. */
export function workOrderGaps(workOrder: JobberDayWorkOrder | null | undefined): string[] {
  if (!workOrder) return [];
  const gaps: string[] = [];
  if (!workOrder.approved) gaps.push('Not approved');
  if (workOrder.estimate === null) gaps.push('No estimate');
  return gaps;
}

/**
 * The tag on a work order the maintenance app sent before it was approved, or
 * without an estimate (2026-11-26: "add a tag on card or change the color of
 * the card, that there is no approval or estimate"). Amber, as a warning:
 * nobody should be sent until it is approved.
 */
export function WorkOrderTag({
  workOrder,
  compact = false,
  className,
}: {
  workOrder: JobberDayWorkOrder | null | undefined;
  /** On a calendar card: one short tag for the first thing missing. */
  compact?: boolean;
  className?: string;
}) {
  const gaps = workOrderGaps(workOrder);
  if (!gaps.length) return null;
  const shown = compact ? gaps.slice(0, 1) : gaps;
  return (
    <span className={cn('flex shrink-0 flex-wrap gap-1', className)}>
      {shown.map((gap) => (
        <span
          className={cn(
            'border-warning/50 bg-warning/15 text-warning rounded-full border px-1.5 font-semibold whitespace-nowrap',
            compact ? 'text-[10px] leading-4' : 'text-xs leading-5',
          )}
          key={gap}
          title={gaps.join(' · ')}
        >
          {gap}
        </span>
      ))}
    </span>
  );
}
