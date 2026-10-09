/**
 * One Texas day, the console's inspections set beside the Jobber visits the
 * sync last saved (console-development, 2026-10-09).
 *
 * Read-only: it is built from what the sync has already stored and never calls
 * Jobber, so opening it costs nothing against Jobber's rate limit and cannot
 * race the sync for a token.
 */

/**
 * Where a visit stands between the two systems, most urgent first. A row
 * carries the first that applies; `differences` lists all that do.
 */
export type JobberDayState =
  /** Cancelled here; Jobber still has the visit on the day, open. */
  | 'CANCELLED_HERE'
  /** Submitted or finished here; Jobber has not been told it is done. */
  | 'DONE_HERE'
  /** Jobber says the visit is completed; it is still open here. */
  | 'DONE_IN_JOBBER'
  /** Linked, but the last full sync did not see it: deleted in Jobber, or moved to Unscheduled. */
  | 'UNSEEN'
  /** The two systems put it on different days. */
  | 'DAY_DIFFERS'
  /** Same day, different clock time. */
  | 'TIME_DIFFERS'
  /** Different person on it (only when Jobber names anybody). */
  | 'TECHNICIAN_DIFFERS'
  /** An inspection here with no Jobber visit linked. */
  | 'NOT_IN_JOBBER'
  /** A visit named as an inspection in Jobber that did not become one here. */
  | 'ONLY_IN_JOBBER'
  | 'MATCHES';

export interface JobberDaySide {
  /** ISO instant, or null for a whole-day / untimed visit. */
  startAt: string | null;
  /** The person on it, as each system names them. */
  technician: string | null;
}

export interface JobberDayRow {
  /** Stable for the day: the inspection id, else `jobber:<visit id>`. */
  key: string;
  inspectionId: string | null;
  jobberVisitId: string | null;
  /** The property as the office knows it: the building, else Jobber's street. */
  property: string;
  /** e.g. OCCUPIED; null for a Jobber-only visit whose type is not known yet. */
  inspectionType: string | null;
  /** The inspection's own status here; null when there is no inspection. */
  status: string | null;
  /** Console technician id this row is grouped under; null for nobody. */
  technicianId: string | null;
  here: JobberDaySide | null;
  jobber: (JobberDaySide & { title: string | null; completed: boolean }) | null;
  state: JobberDayState;
  /** Every difference that applies, in words. Empty when they match. */
  differences: string[];
  /**
   * A change of ours is queued for Jobber and not sent yet. While it is, the
   * sync holds Jobber's copy back, so a difference here may close on its own.
   */
  waitingToSend: boolean;
  /** Why a Jobber-only visit did not become an inspection, in the sync's words. */
  importNote: string | null;
}

export interface JobberDayTechnician {
  /** Console technician id; null groups the visits nobody here is on. */
  technicianId: string | null;
  name: string;
  /** Inspections here on the day, cancelled ones left out. */
  here: number;
  /** Visits named as inspections in Jobber on the day for this person. */
  inJobber: number;
  /** Of `here`, how many are submitted or finished. */
  done: number;
  /** Rows of this person's that do not match. */
  differences: number;
}

export interface JobberDayOtherWork {
  jobberVisitId: string;
  title: string | null;
  property: string;
  technician: string | null;
  startAt: string | null;
  /** Why the sync left it alone: not an inspection, a filter delivery, ignored by the office. */
  reason: string;
}

export interface JobberDayComparison {
  /** The Texas day, `YYYY-MM-DD`. */
  date: string;
  /** When the last full sync finished; what "Jobber" means on this screen. */
  syncedAt: string | null;
  /** Whether the console may send its edits to Jobber at all. */
  pushesEnabled: boolean;
  connected: boolean;
  technicians: JobberDayTechnician[];
  rows: JobberDayRow[];
  /** Jobber work that is not an inspection, listed so the counts add up. */
  otherWork: JobberDayOtherWork[];
}
