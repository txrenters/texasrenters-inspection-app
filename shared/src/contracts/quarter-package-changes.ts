import type { PackageLeftReason, PackageLeftReasonCode } from './group-template-changes.js';

/**
 * The benefit package's changes as a quarter sees them (the office,
 * 2026-10-15): which properties left since last quarter and the group and day
 * they were visited in, which are new since then and where this quarter put
 * them, and the dated history of every join and leave.
 *
 * A property is compared by building, not tenancy: a lease that changes hands
 * inside the package moves nobody in or out.
 */

/** A template group as a quarter's day kept it: its number, name and colour when the day was laid out. */
export interface QuarterDayGroup {
  position: number;
  name: string;
  color: string;
}

/** Where a property's visit sits in a quarter's plan. */
export interface QuarterVisitPlace {
  /** The plan stop's status: PLANNED, PUBLISHED, EXCLUDED and so on. */
  status: string;
  /** YYYY-MM-DD; null for a visit with no day. */
  scheduledOn: string | null;
  technician: string | null;
  /** The template group its day was laid out from; null for a day the planner grouped itself, or no day. */
  group: QuarterDayGroup | null;
}

/** A property visited last quarter, or planned this one, that is no longer in the package. */
export interface QuarterPackageLeaver {
  buildingId: string;
  address: string;
  /** Most telling first, as the Group maker gives them. */
  reasons: PackageLeftReason[];
  /** Its visit in last quarter's plan, when it had one. */
  lastQuarter: QuarterVisitPlace | null;
  /** Its visit in this quarter's plan, when it still has one: EXCLUDED once a switch took it out. */
  thisQuarter: QuarterVisitPlace | null;
}

/** A property in the package now that last quarter's plan did not visit. */
export interface QuarterPackageJoiner {
  buildingId: string;
  address: string;
  /** When it last joined, from the history: kept since 2026-10-15. ISO timestamp. */
  joinedAt: string | null;
  /** The first time any of its enrolled tenancies was on the tenant report. ISO timestamp. */
  firstOnReport: string | null;
  /** Its visit in this quarter's plan; null when the quarter was built before it joined. */
  thisQuarter: QuarterVisitPlace | null;
}

/** One join or leave, as the history recorded it. */
export interface QuarterPackageEvent {
  id: string;
  buildingId: string;
  address: string;
  kind: 'JOINED' | 'LEFT';
  /** The nightly tenant report, or the office's switch on the property's page. */
  source: 'TENANT_REPORT' | 'OFFICE';
  /** Why it left; null for a join. */
  reason: PackageLeftReasonCode | null;
  /** What the report said instead of Yes, for NOT_ENROLLED. */
  detail: string | null;
  /** Who turned the switch; null for the report. */
  by: string | null;
  /** ISO timestamp. */
  occurredAt: string;
}

export interface QuarterPackageChanges {
  planId: string;
  /** The quarter compared with; null when there is no plan for it. */
  previous: { planId: string; quarterYear: number; quarterNumber: number } | null;
  /** Grouped as last quarter's days were, then by address. */
  left: QuarterPackageLeaver[];
  /** Empty when there is no previous quarter to compare with: everything would be new. */
  joined: QuarterPackageJoiner[];
  /** Newest first, since the start of the previous quarter. */
  history: QuarterPackageEvent[];
  /** The history kept back beyond the most it lists. */
  historyMore: number;
}
