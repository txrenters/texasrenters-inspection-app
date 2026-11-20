import type { AdminWorkOrder } from '@texasrenters/shared';

import { workOrderHandoffSchema } from './work-order-handoff.schema';

/**
 * The work order a stored hand-off carries, as the console's work order
 * dialog reads it. Null for a payload that no longer parses: the dialog then
 * falls back to the visit's notes, which hold the same text.
 */
export function workOrderView(payload: unknown, receivedAt: Date): AdminWorkOrder | null {
  const parsed = workOrderHandoffSchema.safeParse(payload);
  if (!parsed.success) return null;
  const { work_order: wo, property, tenants, vendors, approval, occupied } = parsed.data;
  const street = [property?.address, property?.address_cont].filter(Boolean).join(' ');
  const address =
    [street || property?.name, property?.city, [property?.state, property?.postal_code].filter(Boolean).join(' ')]
      .filter(Boolean)
      .join(', ') || null;

  return {
    number: wo.number,
    propertywareId: wo.propertyware_id ?? null,
    url: wo.url ?? null,
    status: wo.status ?? null,
    serviceStatus: wo.service_status ?? null,
    priority: wo.priority ?? null,
    isEmergency: wo.is_emergency,
    category: wo.category ?? null,
    type: wo.type ?? null,
    source: wo.source ?? null,
    description: wo.description?.trim() || null,
    specificLocation: wo.specific_location ?? null,
    authorizedToEnter: wo.authorized_to_enter ?? null,
    zone: wo.zone ?? null,
    occupied,
    costEstimate: wo.cost_estimate ?? null,
    createdDate: wo.created_date ?? null,
    approvedDate: wo.approved_date ?? null,
    dateToEnter: wo.date_to_enter ?? null,
    scheduledEndDate: wo.scheduled_end_date ?? null,
    address,
    tenants: tenants.map((tenant) => ({
      name: tenant.name ?? null,
      phone: tenant.phone ?? null,
      email: tenant.email ?? null,
    })),
    vendors: vendors.map((vendor) => ({ name: vendor.name ?? null, inHouse: vendor.in_house })),
    approval: approval
      ? {
          rule: approval.rule ?? null,
          threshold: approval.threshold,
          estimate: approval.estimate,
          recordedBy: approval.recorded_by ?? null,
          recordedAt: approval.recorded_at ?? null,
          aiConfidence: approval.ai_confidence,
          summary: approval.summary ?? null,
          problems: approval.problems.map((problem) => ({
            item: problem.item,
            decision: problem.decision,
            evidence: problem.evidence ?? null,
          })),
        }
      : null,
    notes: (parsed.data.notes ?? []).map((note) => ({
      subject: note.subject ?? null,
      body: note.body,
      author: note.author ?? null,
      date: note.date ?? null,
      isPrivate: note.is_private,
    })),
    messagesSummary: parsed.data.messages_summary
      ? {
          summary: parsed.data.messages_summary.summary,
          messagesRead: parsed.data.messages_summary.messages_read,
          readAt: parsed.data.messages_summary.read_at ?? null,
        }
      : null,
    receivedAt: receivedAt.toISOString(),
  };
}
