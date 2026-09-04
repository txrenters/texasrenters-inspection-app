import { z } from 'zod';

const propertywareIdSchema = z.union([z.string().min(1), z.number().int().nonnegative()]);
const optionalDateTime = z.string().min(1).optional().nullable();

export const propertywareAddressSchema = z
  .object({
    address: z.string().optional().nullable(),
    addressCont: z.string().optional().nullable(),
    city: z.string().optional().nullable(),
    stateRegion: z.string().optional().nullable(),
    postalCode: z.string().optional().nullable(),
    country: z.string().optional().nullable(),
  })
  .passthrough();

export const propertywareOwnerSchema = z
  .object({
    id: propertywareIdSchema,
    name: z.string().optional().nullable(),
    firstName: z.string().optional().nullable(),
    lastName: z.string().optional().nullable(),
    percentageOwnership: z.number().optional().nullable(),
  })
  .passthrough();

export const propertywarePortfolioSchema = z
  .object({
    id: propertywareIdSchema,
    name: z.string().min(1),
    abbreviation: z.string().optional().nullable(),
    active: z.boolean(),
    createdDateTime: optionalDateTime,
    lastModifiedDateTime: optionalDateTime,
    owners: z.array(propertywareOwnerSchema).optional().default([]),
  })
  .passthrough();

export const propertywarePortfolioReportSchema = z.object({
  totalCount: z.number().int().nonnegative(),
  columns: z.array(
    z.object({
      index: z.string(),
      dataType: z.string(),
      label: z.string(),
    }),
  ),
  records: z.array(
    z
      .object({
        '0': z.string(),
        '1': z.string(),
        '2': z.string(),
        '3': z.string(),
        '4': z.string(),
      })
      .passthrough(),
  ),
});

const propertywarePropertyBaseSchema = z
  .object({
    id: propertywareIdSchema,
    portfolioID: propertywareIdSchema,
    idNumber: propertywareIdSchema.optional().nullable(),
    name: z.string().min(1),
    abbreviation: z.string().optional().nullable(),
    active: z.boolean(),
    address: propertywareAddressSchema.optional().nullable(),
    type: z.string().optional().nullable(),
    status: z.string().optional().nullable(),
    createdDateTime: optionalDateTime,
    lastModifiedDateTime: optionalDateTime,
  })
  .passthrough();

export const propertywareBuildingSchema = propertywarePropertyBaseSchema.extend({
  /**
   * Buildings, alone among the property types, come back with a null portfolio.
   * Requiring one rejected nineteen live properties outright — hiding them from
   * the whole app rather than importing them unassigned. Units keep the base
   * schema's requirement: a unit always belongs to a building's portfolio.
   */
  portfolioID: propertywareIdSchema.optional().nullable(),
  propertyType: z.string().optional().nullable(),
  // Verified building-level total area, its unit label, and category.
  totalArea: z.number().optional().nullable(),
  areaUnits: z.string().optional().nullable(),
  category: z.string().optional().nullable(),
});

export const propertywareUnitSchema = propertywarePropertyBaseSchema.extend({
  buildingID: propertywareIdSchema,
  rentable: z.boolean().optional().nullable(),
  syndicate: z.boolean().optional().nullable(),
  numberOfBedrooms: z.number().int().nonnegative().optional().nullable(),
  numberOfBathrooms: z.number().nonnegative().optional().nullable(),
});

export const propertywareLeaseContactSchema = z
  .object({
    firstName: z.string().optional().nullable(),
    lastName: z.string().optional().nullable(),
    name: z.string().optional().nullable(),
  })
  .passthrough();

export const propertywareLeaseSchema = z
  .object({
    id: propertywareIdSchema,
    // The REST API always supplies portfolio and unit. The published-report
    // fallback exposes only building-level identifiers, so both are optional
    // here and the portfolio is resolved from the building at persist time.
    portfolioID: propertywareIdSchema.optional().nullable(),
    buildingID: propertywareIdSchema,
    unitID: propertywareIdSchema.optional().nullable(),
    idNumber: propertywareIdSchema.optional().nullable(),
    leaseName: z.string().optional().nullable(),
    active: z.boolean(),
    status: z.string().optional().nullable(),
    startDate: z.string().optional().nullable(),
    endDate: z.string().optional().nullable(),
    moveInDate: z.string().optional().nullable(),
    scheduleMoveOutDate: z.string().optional().nullable(),
    moveOutDate: z.string().optional().nullable(),
    noticeGivenDate: z.string().optional().nullable(),
    reasonForLeaving: z.string().optional().nullable(),
    contacts: z.array(propertywareLeaseContactSchema).optional().default([]),
    createdDateTime: optionalDateTime,
    lastModifiedDateTime: optionalDateTime,
  })
  .passthrough();

/**
 * The published Propertyware lease report (a saved report rendered as JSON).
 * Columns are positional, so the indices below are the contract — see
 * PROPERTYWARE_LEASE_REPORT_COLUMNS for what each one holds.
 */
/**
 * A published Propertyware report, whose columns are addressed by label.
 *
 * The record keys used to be pinned here by index — `'9'` annotated "Building
 * Entity ID", `'0'` annotated "Status", and so on. Propertyware reports carry
 * their own column list, and this one was edited upstream: index 9 is now
 * "Balance" and index 0 is "Lease Name". Nothing failed. The parser read
 * `$0.00` as a building id and `Abuah - Abuah` as a status, the
 * `/^active/i` filter matched **0 of 448 rows**, and the lease table sat empty
 * for weeks behind a warning that reads the same as a quiet week.
 *
 * So the indices are no longer part of the contract. `columns` is, and
 * `leaseReportColumns` below resolves the labels and refuses a report that is
 * missing one rather than returning nothing and calling it success.
 */
export const propertywareLeaseReportSchema = z.object({
  totalCount: z.number().int().nonnegative(),
  columns: z
    .array(z.object({ index: z.string(), dataType: z.string(), label: z.string() }))
    .min(1),
  records: z.array(z.record(z.string(), z.string()).and(z.object({}).passthrough())),
});

/** The labels a lease report must carry, and the field each one feeds. */
export const LEASE_REPORT_COLUMNS = {
  status: 'Status',
  leaseName: 'Lease Name',
  startDate: 'Start Date',
  endDate: 'End Date',
  noticeGivenDate: 'Notice Given Date',
  /**
   * The one the currently configured report does not have.
   *
   * A lease that cannot be tied to a building cannot become anything here, so
   * this is required rather than optional — and naming it in the failure is the
   * whole point: "the lease report has no Building Entity ID column" is a
   * sentence somebody can act on, where 448 rows silently becoming 0 is not.
   */
  buildingId: 'Building Entity ID',
} as const;

export type LeaseReportColumnKey = keyof typeof LEASE_REPORT_COLUMNS;

/** Compared without case or surrounding space; Propertyware edits both. */
const columnKey = (label: string) => label.trim().toLowerCase();

/**
 * Maps each named field to the record key that holds it.
 *
 * Returns the missing labels rather than throwing, so a caller can name all of
 * them at once instead of revealing them one failed sync at a time.
 *
 * Generic because there is more than one report: the lease report and the
 * office's tenancy report have entirely different columns and the same hazard.
 * One resolver means the rule about labels-not-positions is stated once.
 */
export function reportColumnIndexes<Field extends string>(
  columns: ReadonlyArray<{ index: string; label: string }>,
  required: Readonly<Record<Field, string>>,
  optional: Readonly<Record<string, string>> = {},
): { indexes: Record<Field, string>; optionalIndexes: Record<string, string>; missing: string[] } {
  const byLabel = new Map(columns.map((column) => [columnKey(column.label), column.index]));
  const indexes = {} as Record<Field, string>;
  const missing: string[] = [];
  for (const [field, label] of Object.entries(required) as Array<[Field, string]>) {
    const index = byLabel.get(columnKey(label));
    if (index === undefined) missing.push(label);
    else indexes[field] = index;
  }
  // Absent optional columns are simply absent; the report is still readable.
  const optionalIndexes: Record<string, string> = {};
  for (const [field, label] of Object.entries(optional)) {
    const index = byLabel.get(columnKey(label));
    if (index !== undefined) optionalIndexes[field] = index;
  }
  return { indexes, optionalIndexes, missing };
}

export function leaseReportColumns(columns: ReadonlyArray<{ index: string; label: string }>): {
  indexes: Record<LeaseReportColumnKey, string>;
  missing: string[];
} {
  const { indexes, missing } = reportColumnIndexes(columns, LEASE_REPORT_COLUMNS);
  return { indexes, missing };
}

/**
 * The office's tenancy report — the one that knows about the benefit package.
 *
 * Only the columns without which a row means nothing are required. The rest are
 * optional: this report is maintained by the office and columns come and go, and
 * refusing the whole thing because the HVAC filter size was renamed would lose
 * 418 tenancies to recover one field.
 *
 * `Building Address` is the important one, and the reason this report can do
 * what the lease report cannot: it is what ties a tenancy to a property.
 */
export const TENANT_REPORT_COLUMNS = {
  leaseName: 'Lease Name',
  status: 'Status',
  buildingAddress: 'Building Address',
} as const;

export const TENANT_REPORT_OPTIONAL_COLUMNS = {
  startDate: 'Start Date',
  endDate: 'End Date',
  tbpEnrollment: 'Enrolled in Tenant Benefits Package',
  zone: 'Zone',
  managementPlan: 'Management Plan',
  hvacPlan: 'HVAC Plan',
  hvacFilterLocation: 'HVAC Filter Location Information',
  hvacFilterSize1: 'HVAC Filter Size 1',
  hvacFilterSize2: 'HVAC Filter Size 2',
  hvacFilterSize3: 'HVAC Filter Size 3',
  hvacFilterSize4: 'HVAC Filter Size 4',
  lastFilterDelivery: 'Last Filter Delivery',
  lastHvacInspection: 'Last HVAC Inspection',
  lastOccupiedInspection: 'Last Occupied Inspection',
  city: 'Building City',
  state: 'Building State',
  postalCode: 'Building Zip',
} as const;

export type TenantReportColumnKey = keyof typeof TENANT_REPORT_COLUMNS;

export function tenantReportColumns(columns: ReadonlyArray<{ index: string; label: string }>) {
  return reportColumnIndexes(columns, TENANT_REPORT_COLUMNS, TENANT_REPORT_OPTIONAL_COLUMNS);
}

export const propertywareSchemas = {
  portfolios: propertywarePortfolioSchema,
  buildings: propertywareBuildingSchema,
  units: propertywareUnitSchema,
  leases: propertywareLeaseSchema,
} as const;

export type RawPropertywarePortfolio = z.infer<typeof propertywarePortfolioSchema>;
export type RawPropertywareBuilding = z.infer<typeof propertywareBuildingSchema>;
export type RawPropertywareUnit = z.infer<typeof propertywareUnitSchema>;
export type RawPropertywareLease = z.infer<typeof propertywareLeaseSchema>;

const normalizedBaseSchema = z.object({
  externalId: z.string().min(1),
  isActive: z.boolean(),
  sourceStatus: z.string().min(1),
  sourceCreatedAt: z.string().optional(),
  sourceUpdatedAt: z.string().optional(),
});

const normalizedAddressSchema = z.object({
  addressLine1: z.string().optional(),
  addressLine2: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().optional(),
});

export const normalizedPropertywareRecordSchema = z.discriminatedUnion('entityType', [
  normalizedBaseSchema.extend({
    entityType: z.literal('portfolios'),
    idNumber: z.string().optional(),
    name: z.string().min(1),
    abbreviation: z.string().optional(),
    owners: z.array(
      z.object({
        externalId: z.string().min(1),
        displayName: z.string().min(1),
        percentageOwnership: z.number().optional(),
        isActive: z.boolean(),
      }),
    ),
  }),
  normalizedBaseSchema.merge(normalizedAddressSchema).extend({
    entityType: z.literal('buildings'),
    /** Absent for the buildings Propertyware holds without a portfolio. */
    portfolioExternalId: z.string().min(1).optional(),
    idNumber: z.string().optional(),
    name: z.string().min(1),
    abbreviation: z.string().optional(),
    propertyType: z.string().optional(),
    totalArea: z.number().int().nonnegative().optional(),
    areaUnits: z.string().optional(),
    category: z.string().optional(),
  }),
  normalizedBaseSchema.merge(normalizedAddressSchema).extend({
    entityType: z.literal('units'),
    buildingExternalId: z.string().min(1),
    portfolioExternalId: z.string().min(1),
    idNumber: z.string().optional(),
    name: z.string().min(1),
    abbreviation: z.string().optional(),
    type: z.string().optional(),
    vacant: z.boolean().optional(),
    publishedForRent: z.boolean().optional(),
    bedrooms: z.number().int().nonnegative().optional(),
    bathrooms: z.number().nonnegative().optional(),
  }),
  normalizedBaseSchema.extend({
    entityType: z.literal('leases'),
    // Report-sourced leases carry only a building; the portfolio is resolved
    // from it and the unit link is left empty. REST leases supply both.
    portfolioExternalId: z.string().min(1).optional(),
    buildingExternalId: z.string().min(1),
    unitExternalId: z.string().min(1).optional(),
    idNumber: z.string().optional(),
    leaseName: z.string().optional(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    moveInDate: z.string().optional(),
    scheduledMoveOutDate: z.string().optional(),
    moveOutDate: z.string().optional(),
    noticeGivenDate: z.string().optional(),
    reasonForLeaving: z.string().optional(),
    tenantDisplayNames: z.array(z.string()),
  }),
]);

// The database write boundary intentionally validates the same minimal normalized
// contract and never accepts raw provider payloads.
export const propertywareDatabaseUpsertSchema = normalizedPropertywareRecordSchema;
