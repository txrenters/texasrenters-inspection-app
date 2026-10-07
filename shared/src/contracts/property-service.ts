/**
 * What the office knows about a property before Propertyware says it.
 *
 * Propertyware is updated late (the office, 2026-10-08), so a property whose
 * owner has ended the management contract, or that has left the tenant benefit
 * package, still looks managed and enrolled there -- and the lease schedule
 * kept booking its move-outs and move-ins. Two switches on the property's
 * Details tab say it here first, and everything that books visits obeys them:
 *
 * - **Management ended**: the owner no longer has Texas Renters manage the
 *   property. Nothing more is booked there: no move-out, no move-in, no
 *   benefit-package visit.
 * - **Benefit package opted out**: the property no longer gets the quarterly
 *   occupied and HVAC visits. Move-ins and move-outs go on as before -- they
 *   are a different kind of inspection, owed whenever a tenant comes or goes.
 */

/** Who turned a switch on, and when. */
export interface PropertyServiceMark {
  /** ISO timestamp. */
  at: string;
  by: { id: string; displayName: string } | null;
}

export interface PropertyServiceStatus {
  managementEnded: PropertyServiceMark | null;
  tbpOptedOut: PropertyServiceMark | null;
}

/** Either switch, or both; a switch left out is left as it is. */
export interface SetPropertyServiceStatusInput {
  managementEnded?: boolean;
  tbpOptedOut?: boolean;
}

/**
 * An upcoming inspection at the property that a switch says should not happen,
 * and that nothing cancelled by itself: one booked by hand or in Jobber, one
 * already started, a benefit-package visit already published. Listed for a
 * person to cancel -- or keep.
 */
export interface PropertyServiceStillBooked {
  inspectionId: string;
  inspectionType: string;
  status: string;
  /** `YYYY-MM-DD`. */
  scheduledOn: string;
  technician: string | null;
}

export interface PropertyServiceView {
  status: PropertyServiceStatus;
  /** Only for someone who may read inspections; empty otherwise. */
  stillBooked: PropertyServiceStillBooked[];
  /**
   * Whether the lease schedule runs each night. Off, a switch still stops
   * bookings, but nothing booked earlier is called off by itself.
   */
  leaseScheduleOn: boolean;
}

/** What turning a switch did, besides recording it. */
export interface PropertyServiceChange extends PropertyServiceView {
  /** Move-outs and move-ins the lease schedule had booked here, now cancelled. */
  calledOff: number;
  /** Ones it booked again, a switch having been turned off. */
  booked: number;
}
