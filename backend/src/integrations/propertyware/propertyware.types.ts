import type { PropertywareEntity } from './propertyware.constants';

export interface PropertywareConfig {
  provider: 'mock' | 'live';
  store: 'memory' | 'prisma';
  baseUrl: string;
  clientId?: string;
  clientSecret?: string;
  organizationId?: string;
  portfolioReportUrl?: string;
  /** Published lease report, used when REST /leases is not permitted. */
  leaseReportUrl?: string;

  /** The office tenancy report: TBP enrolment, HVAC plan, building address. */

  tenantReportUrl?: string;
  tenantSyncCron: string;
  requestTimeoutMs: number;
  pageSize: number;
  maxRetries: number;
  syncEnabled: boolean;
  incrementalSyncCron?: string;
  reconciliationCron?: string;
  // Internal organization UUID that scheduled (automatic) syncs run for.
  schedulerOrganizationId?: string;
  initialSyncLookbackDays: number;
  cursorOverlapSeconds: number;
  databaseConcurrency: number;
  databaseBatchSize: number;
}

export interface PropertywarePage<T> {
  records: T[];
  receivedCount?: number;
  validationErrors?: Array<{
    index: number;
    externalId?: string;
    code: 'PROPERTYWARE_SCHEMA_ERROR';
    // Sanitized field-level reason (paths + type mismatches, never data values).
    detail?: string;
  }>;
  totalCount?: number;
  offset: number;
  limit: number;
}

export interface PropertywarePageQuery {
  offset?: number;
  limit?: number;
  lastModifiedDateTimeStart?: string;
  lastModifiedDateTimeEnd?: string;
  includeDeactivated?: boolean;
}

export interface NormalizedOwner {
  externalId: string;
  displayName: string;
  percentageOwnership?: number;
  isActive: boolean;
}

export interface NormalizedPortfolio {
  entityType: 'portfolios';
  externalId: string;
  idNumber?: string;
  name: string;
  abbreviation?: string;
  isActive: boolean;
  sourceStatus: string;
  sourceCreatedAt?: string;
  sourceUpdatedAt?: string;
  owners: NormalizedOwner[];
}

export interface NormalizedAddress {
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}

export interface NormalizedBuilding extends NormalizedAddress {
  entityType: 'buildings';
  externalId: string;
  /** Absent for buildings Propertyware holds without a portfolio assignment. */
  portfolioExternalId?: string;
  idNumber?: string;
  name: string;
  abbreviation?: string;
  propertyType?: string;
  totalArea?: number;
  areaUnits?: string;
  category?: string;
  isActive: boolean;
  sourceStatus: string;
  sourceCreatedAt?: string;
  sourceUpdatedAt?: string;
}

export interface NormalizedUnit extends NormalizedAddress {
  entityType: 'units';
  externalId: string;
  buildingExternalId: string;
  portfolioExternalId: string;
  idNumber?: string;
  name: string;
  abbreviation?: string;
  type?: string;
  vacant?: boolean;
  publishedForRent?: boolean;
  bedrooms?: number;
  bathrooms?: number;
  isActive: boolean;
  sourceStatus: string;
  sourceCreatedAt?: string;
  sourceUpdatedAt?: string;
}

export interface NormalizedLease {
  entityType: 'leases';
  externalId: string;
  /** Absent for report-sourced leases; resolved from the building instead. */
  portfolioExternalId?: string;
  buildingExternalId: string;
  /** Absent for report-sourced leases, which link at building level. */
  unitExternalId?: string;
  idNumber?: string;
  leaseName?: string;
  isActive: boolean;
  sourceStatus: string;
  startDate?: string;
  endDate?: string;
  moveInDate?: string;
  scheduledMoveOutDate?: string;
  moveOutDate?: string;
  noticeGivenDate?: string;
  reasonForLeaving?: string;
  tenantDisplayNames: string[];
  sourceCreatedAt?: string;
  sourceUpdatedAt?: string;
}

export type NormalizedPropertywareRecord =
  NormalizedPortfolio | NormalizedBuilding | NormalizedUnit | NormalizedLease;

export type SyncMode = 'initial' | 'incremental' | 'reconciliation';
export type SyncRunStatus =
  'PENDING' | 'RUNNING' | 'COMPLETED' | 'COMPLETED_WITH_ERRORS' | 'FAILED' | 'CANCELLED';

export interface SyncMetrics {
  recordsFetched: number;
  recordsCreated: number;
  recordsUpdated: number;
  recordsUnchanged: number;
  recordsDeactivated: number;
  recordsReactivated: number;
  recordsFailed: number;
  pagesFetched: number;
  warnings: number;
}

export interface PropertywareDryRunResult {
  mode: 'dry-run';
  provider: 'mock' | 'live';
  entities: Array<{
    entityType: PropertywareEntity;
    pagesFetched: number;
    recordsFetched: number;
    recordsMapped: number;
    warnings: string[];
  }>;
  totals: {
    pagesFetched: number;
    recordsFetched: number;
    recordsMapped: number;
    warnings: number;
  };
}

export interface SyncRequest {
  entities: PropertywareEntity[];
  mode: SyncMode;
  requestedBy: string;
}
