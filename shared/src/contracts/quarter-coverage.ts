/**
 * Where every property in the benefit package stands for a quarter (the office,
 * 2026-11-20): "Properties that has Q4 2026 TBP completed ... Scheduled but not
 * completed ... Not schedule ... no Q4 2026 TBP created".
 *
 * One row per property (building), not per lease: a lease that changed hands
 * mid-quarter keeps the visit its old lease had, and a visit booked straight in
 * Jobber under the programme's name counts as much as one the plan made. The
 * quarter is the plan's, never the day's (`visitQuarter`).
 */

/** The four groups, in the order the office asked for them. */
export const COVERAGE_GROUPS = ['COMPLETED', 'SCHEDULED', 'NOT_SCHEDULED', 'NONE'] as const;
export type CoverageGroup = (typeof COVERAGE_GROUPS)[number];

/** Why a property is in its group. */
export type CoverageDetail =
  /** COMPLETED: the office finished the report. */
  | 'FINISHED'
  /** COMPLETED: the technician submitted it; the office has not finished it yet. */
  | 'IN_REVIEW'
  /** SCHEDULED: its day is today or later. */
  | 'UPCOMING'
  /** SCHEDULED: its day has gone and nothing was submitted. */
  | 'PAST_DUE'
  /** NOT_SCHEDULED: published with no day -- it waits on Jobber's Unscheduled list. */
  | 'NO_DAY'
  /** NOT_SCHEDULED: blocked until a person fixes it, such as choosing the unit. */
  | 'NEEDS_PERSON'
  /** NOT_SCHEDULED: in the plan, but no visit has been booked from it. */
  | 'NOT_SENT'
  /** NONE: its only visit this quarter was taken out of the plan. */
  | 'EXCLUDED'
  /** NONE: the plan has no visit for it, most often because it joined after the quarter was built. */
  | 'NOT_PLANNED';

/** Each reason's group, in the order a list shows them: the one to act on first. */
export const COVERAGE_DETAILS: readonly { detail: CoverageDetail; group: CoverageGroup }[] = [
  { detail: 'IN_REVIEW', group: 'COMPLETED' },
  { detail: 'FINISHED', group: 'COMPLETED' },
  { detail: 'PAST_DUE', group: 'SCHEDULED' },
  { detail: 'UPCOMING', group: 'SCHEDULED' },
  { detail: 'NEEDS_PERSON', group: 'NOT_SCHEDULED' },
  { detail: 'NO_DAY', group: 'NOT_SCHEDULED' },
  { detail: 'NOT_SENT', group: 'NOT_SCHEDULED' },
  { detail: 'NOT_PLANNED', group: 'NONE' },
  { detail: 'EXCLUDED', group: 'NONE' },
];

/** The visit that decides a property's group. */
export interface CoverageVisit {
  /** The plan's stop; null for a visit booked straight in Jobber. */
  stopId: string | null;
  inspectionId: string | null;
  /** OCCUPIED or HVAC. */
  inspectionType: string | null;
  /** YYYY-MM-DD; null for a visit with no day. */
  scheduledOn: string | null;
  technician: string | null;
  /** The inspection's status; null when no inspection exists. */
  inspectionStatus: string | null;
  /** The stop's status: PUBLISHED, UNSCHEDULED, EXCLUDED and so on; null for a Jobber-only visit. */
  stopStatus: string | null;
  /** Jobber has a visit for it. */
  bookedInJobber: boolean;
  /** Booked in Jobber under the programme's name, with no stop in the plan. */
  fromJobber: boolean;
  /** Made for a lease that has ended since; the property has a new one. */
  previousLease: boolean;
  /** Why it was blocked or excluded, as the plan recorded it. */
  note: string | null;
}

export interface QuarterCoverageProperty {
  buildingId: string;
  address: string;
  city: string | null;
  /** The zone the tenant report gives its enrolled lease, as written. */
  zone: string | null;
  /** Enrolled leases at the property: more than one for a building of units. */
  leases: number;
  /** When its newest enrolled lease first appeared on the tenant report. ISO timestamp. */
  firstOnReport: string | null;
  group: CoverageGroup;
  detail: CoverageDetail;
  /** Null for NOT_PLANNED. */
  visit: CoverageVisit | null;
  /**
   * Other visits here, for a lease that has ended, still waiting: on Jobber's
   * Unscheduled list or booked. A person should cancel them in Jobber.
   */
  previousLeaseOpen: number;
  /**
   * Its enrolled leases with no stop in this quarter's plan: what "Add to the
   * quarter" would add. A lease that joined after the quarter was built.
   */
  missingLeases: number;
  /**
   * What "Add to the quarter" does here, when a lease has no stop: ADD a new
   * one; CARRY_OVER the one visit waiting for an ended lease to the new lease;
   * or nothing, when a visit for an ended lease is ALREADY_BOOKED and a second
   * would send somebody twice. Null when every lease has a stop.
   */
  missingLeaseAction: 'ADD' | 'CARRY_OVER' | 'ALREADY_BOOKED' | null;
}

/** What adding a property to a quarter did (`POST quarters/:planId/properties/:buildingId`). */
export interface AddToQuarterResult {
  planId: string;
  /** The stops made, one for each of its enrolled leases that had none, with no day yet. */
  added: string[];
  /** Its leases' stops already in the plan, left as they were. */
  kept: string[];
  /**
   * A stop made for a lease that has ended since, still waiting for its day,
   * moved to the new lease instead of a second: the same Jobber visit, with
   * the new lease's Details.
   */
  carried: string[];
}

/** Out of the package now, with a visit this quarter still going ahead. */
export interface QuarterCoverageLeaver {
  buildingId: string;
  address: string;
  city: string | null;
  visit: CoverageVisit;
}

export interface QuarterCoverage {
  planId: string;
  quarterYear: number;
  quarterNumber: number;
  /** The Texas day it was read on: a booked visit before it is past its day. YYYY-MM-DD. */
  today: string;
  /** Every property in the package now, by group, then by day, then by address. */
  properties: QuarterCoverageProperty[];
  /** Out of the package now with a visit still booked or waiting in Jobber: cancel it or keep it. */
  leftWithOpenVisit: QuarterCoverageLeaver[];
}
