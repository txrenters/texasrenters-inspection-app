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
export const propertywareLeaseReportSchema = z.object({
  totalCount: z.number().int().nonnegative(),
  columns: z.array(z.object({ index: z.string(), dataType: z.string(), label: z.string() })),
  records: z.array(
    z
      .object({
        '0': z.string(), // Status
        '4': z.string(), // Lease Name
        '5': z.string(), // Start Date (MM/DD/YYYY)
        '6': z.string(), // End Date
        '7': z.string(), // Notice Given Date
        '9': z.string(), // Building Entity ID
      })
      .passthrough(),
  ),
});

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
    portfolioExternalId: z.string().min(1),
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
