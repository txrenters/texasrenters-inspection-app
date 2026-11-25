import type { JobberDayWorkOrder } from '@texasrenters/shared';

/** The maintenance app's rule for a work order it sent before anyone approved it (tx-maintenance #20). */
export const SENT_UNAPPROVED = 'sent_unapproved';

/**
 * Where a work order stands, from the hand-off the maintenance app last sent
 * (2026-11-26).
 *
 * **Not approved** only when the maintenance app sent it unapproved -- its
 * rule `sent_unapproved` -- and it still has no `approved_date`. Every other
 * hand-off went through the maintenance app's own approval rules (an
 * emergency, under the threshold, an approval on record or in the owner's
 * messages), so it is approved: ready for the calendar and for auto-assign
 * (the office: "the calendar, that is where we pass the work orders that ...
 * ready to get automated"). The estimate is the work order's `cost_estimate`.
 */
export function workOrderStanding(payload: unknown): JobberDayWorkOrder {
  const handoff = payload as {
    work_order?: { approved_date?: unknown; cost_estimate?: unknown };
    approval?: { rule?: unknown } | null;
  } | null;
  const order = handoff?.work_order;
  const approvedOnRecord = typeof order?.approved_date === 'string' && order.approved_date.length > 0;
  const sentUnapproved = handoff?.approval?.rule === SENT_UNAPPROVED;
  const estimate = order?.cost_estimate;
  return {
    approved: approvedOnRecord || !sentUnapproved,
    estimate: typeof estimate === 'number' && Number.isFinite(estimate) ? estimate : null,
  };
}
