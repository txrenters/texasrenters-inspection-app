import { createHash } from 'node:crypto';

import {
  propertywareLeaseReportSchema,
  tenantReportColumns,
} from './propertyware.schemas';
import { PropertywareError } from './propertyware.errors';
import { reportDate } from './propertyware.client';

/**
 * The office's tenancy report, turned into rows this system can hold.
 *
 * This is the report that knows about the Tenant Benefit Package. The REST
 * lease endpoint does not expose enrolment, the HVAC plan, filter sizes, or
 * when a filter was last delivered — and the *other* published report has no
 * building column at all, so its rows cannot be tied to a property.
 *
 * This one carries `Building Address`, which is the whole reason it can be the
 * source for a tenant list: the address is matched with the same normalizer the
 * Jobber integration uses, so a tenancy and a visit resolve to the same
 * building or to neither.
 *
 * Nothing here is trusted as a shape. Columns are found by label, because this
 * report is maintained by hand and the last one that was addressed by position
 * quietly returned zero rows for weeks after somebody reordered it.
 */

export interface TenantReportRow {
  externalId: string;
  /** Propertyware's building id, when the report carries one. Exact, so it is
   * used in preference to matching the address. */
  buildingExternalId: string | null;
  leaseName: string;
  sourceStatus: string | null;
  startDate: string | null;
  endDate: string | null;
  tbpEnrollment: string | null;
  zone: string | null;
  managementPlan: string | null;
  hvacPlan: string | null;
  hvacFilterLocation: string | null;
  hvacFilterSizes: string[];
  lastFilterDelivery: string | null;
  lastHvacInspection: string | null;
  lastOccupiedInspection: string | null;
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
}

/**
 * Stable identity for a tenancy the report does not identify.
 *
 * Hashed from values Propertyware owns — lease name, start date, address — so
 * re-running the sync produces the same key and rows update rather than
 * duplicate. The address is part of it because two tenancies can share a lease
 * name across different properties, and the report offers nothing else to tell
 * them apart.
 */
export function tenantExternalId(leaseName: string, startDate: string, address: string) {
  const digest = createHash('sha256')
    .update(`${leaseName}|${startDate}|${address}`.toLowerCase())
    .digest('hex')
    .slice(0, 16);
  return `tenant-${digest}`;
}

/** Empty strings are how this report writes "no value"; null is how we store it. */
const value = (raw: string | undefined) => {
  const trimmed = (raw ?? '').trim();
  return trimmed ? trimmed : null;
};

/**
 * Placeholders the office types into a field it is not using.
 *
 * The four filter-size columns always exist, so a home with one filter reads
 * `16x25x1, N/A, N/A, N/A`. Storing those would make every property look like
 * it has four filters and put "N/A" in front of a technician holding a filter.
 */
const PLACEHOLDERS = new Set(['n/a', 'na', 'none', '-', '--', 'tbd', 'unknown']);
const isPlaceholder = (raw: string) => PLACEHOLDERS.has(raw.trim().toLowerCase());

export function parseTenantReport(payload: unknown): TenantReportRow[] {
  const report = propertywareLeaseReportSchema.safeParse(payload);
  if (!report.success)
    throw new PropertywareError(
      'Propertyware returned an unexpected tenant report shape.',
      'PROPERTYWARE_INVALID_TENANT_REPORT',
    );

  const { indexes, optionalIndexes, missing } = tenantReportColumns(report.data.columns);
  if (missing.length)
    throw new PropertywareError(
      `The Propertyware tenant report is missing ${missing.map((label) => `"${label}"`).join(', ')}. It has: ${report.data.columns.map((column) => column.label).join(', ')}.`,
      'PROPERTYWARE_TENANT_REPORT_MISSING_COLUMNS',
    );

  const required = (record: Record<string, string>, field: keyof typeof indexes) =>
    value(record[indexes[field]]);
  const opt = (record: Record<string, string>, field: string) =>
    optionalIndexes[field] === undefined ? null : value(record[optionalIndexes[field]]);

  return report.data.records.flatMap((raw) => {
    const record = raw as Record<string, string>;
    const leaseName = required(record, 'leaseName');
    const address = required(record, 'buildingAddress');
    // A row with neither a name nor an address identifies nothing and could
    // not be shown, matched or de-duplicated. Dropped rather than stored as a
    // row of blanks somebody has to explain later.
    if (!leaseName || !address) return [];

    const rawStart = opt(record, 'startDate');
    return [
      {
        externalId: tenantExternalId(leaseName, rawStart ?? '', address),
        buildingExternalId: opt(record, 'buildingExternalId'),
        leaseName,
        sourceStatus: required(record, 'status'),
        startDate: reportDate(rawStart ?? undefined) ?? null,
        endDate: reportDate(opt(record, 'endDate') ?? undefined) ?? null,
        tbpEnrollment: opt(record, 'tbpEnrollment'),
        zone: opt(record, 'zone'),
        managementPlan: opt(record, 'managementPlan'),
        hvacPlan: opt(record, 'hvacPlan'),
        hvacFilterLocation: opt(record, 'hvacFilterLocation'),
        hvacFilterSizes: [1, 2, 3, 4]
          .map((n) => opt(record, `hvacFilterSize${n}`))
          .filter((size): size is string => Boolean(size) && !isPlaceholder(size!)),
        // Left as written: these arrive as free text in this report, including
        // values like "Never" that no date parse would survive.
        lastFilterDelivery: opt(record, 'lastFilterDelivery'),
        lastHvacInspection: reportDate(opt(record, 'lastHvacInspection') ?? undefined) ?? null,
        lastOccupiedInspection: opt(record, 'lastOccupiedInspection'),
        addressLine1: address,
        city: opt(record, 'city'),
        state: opt(record, 'state'),
        postalCode: opt(record, 'postalCode'),
      },
    ];
  });
}

/** Enrolment as the office writes it, for filtering without guessing. */
export const TBP_ENROLLED = 'Yes';
export const isTbpEnrolled = (value: string | null | undefined) =>
  (value ?? '').trim().toLowerCase() === TBP_ENROLLED.toLowerCase();
