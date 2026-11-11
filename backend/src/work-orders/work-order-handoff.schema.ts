import { z } from 'zod';

/**
 * The envelope the maintenance app sends to `POST /gateway/work-orders`.
 *
 * Validated with zod rather than a class DTO for the reason the Jobber webhook
 * is: the shape is the other system's contract, in its own field names, and
 * every field is present on every send with `null` for unknown. Unknown keys
 * are dropped rather than refused, so the maintenance app can add a field
 * before this side reads it. Renaming or removing one is a contract change on
 * both sides.
 *
 * See docs/integrations/TX_MAINTENANCE_WORK_ORDERS.md for the whole contract.
 */

const text = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) => text(max).nullable().optional();
/** ISO 8601, as the sender writes it; parsed where a date is needed. */
const isoDate = z.string().trim().max(40).nullable().optional();

export const workOrderHandoffSchema = z.object({
  idempotency_key: text(120).min(1),
  source_system: text(40).min(1),
  work_order: z.object({
    id: z.number().int().nonnegative(),
    number: z.number().int().nullable(),
    propertyware_id: optionalText(40),
    source: optionalText(80),
    is_crystal_creek: z.boolean(),
    status: optionalText(40),
    service_status: optionalText(120),
    local_status: optionalText(40),
    priority: optionalText(40),
    is_emergency: z.boolean().nullable(),
    category: optionalText(120),
    type: optionalText(120),
    description: z.string().max(10000).nullable(),
    specific_location: optionalText(500),
    authorized_to_enter: optionalText(40),
    zone: optionalText(20),
    created_date: isoDate,
    approved_date: isoDate,
    date_to_enter: isoDate,
    scheduled_end_date: isoDate,
    completed_date: isoDate,
    jobber: z.object({
      job_gid: optionalText(120),
      web_uri: optionalText(500),
    }),
    url: optionalText(500),
  }),
  property: z
    .object({
      propertyware_building_id: text(40).min(1),
      propertyware_unit_id: optionalText(40),
      propertyware_lease_id: optionalText(40),
      portfolio_id: optionalText(40),
      name: optionalText(200),
      address: optionalText(200),
      address_cont: optionalText(200),
      city: optionalText(120),
      state: optionalText(40),
      postal_code: optionalText(20),
      latitude: z.number().nullable(),
      longitude: z.number().nullable(),
      location: optionalText(200),
    })
    .nullable(),
  outside_customer: z
    .object({
      name: optionalText(200),
      phone: optionalText(40),
      email: optionalText(200),
      address: optionalText(300),
      street: optionalText(200),
      city: optionalText(120),
      state: optionalText(40),
      postal_code: optionalText(20),
    })
    .nullable(),
  occupied: z.boolean(),
  tenants: z
    .array(
      z.object({
        name: optionalText(200),
        phone: optionalText(40),
        email: optionalText(200),
      }),
    )
    .max(20),
  vendors: z
    .array(
      z.object({
        propertyware_id: optionalText(40),
        name: optionalText(200),
        in_house: z.boolean(),
      }),
    )
    .max(20),
});

export type WorkOrderHandoff = z.infer<typeof workOrderHandoffSchema>;
