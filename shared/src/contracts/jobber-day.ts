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
  /**
   * Where it is on the map (2026-11-26): the inspection's building, else the
   * building Jobber's property is linked to. Null when neither is known.
   */
  buildingId?: string | null;
  /** e.g. OCCUPIED; null for a Jobber-only visit whose type is not known yet. */
  inspectionType: string | null;
  /** The inspection's own status here; null when there is no inspection. */
  status: string | null;
  /** Console technician id this row is grouped under; null for nobody. */
  technicianId: string | null;
  /**
   * Everyone on it here, `technicianId` first (2026-11-25): a visit Jobber has
   * two people on is in both their columns, as on Jobber's calendar. Empty for
   * nobody. Absent on a day read before this existed.
   */
  technicianIds?: string[];
  here: JobberDaySide | null;
  jobber: (JobberDaySide & { title: string | null; completed: boolean } & JobberVisitExtras) | null;
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
  /**
   * The job the inspection was booked in (2026-11-20), so the Schedule draws
   * one card a job. Absent or null for a visit booked before jobs, or one only
   * Jobber has.
   */
  job?: JobberDayJob | null;
  /**
   * Jobber work that is not an inspection -- a work order, a key pickup --
   * drawn on the calendar so it holds what Jobber's does (2026-11-25).
   * Read-only: nothing here sends it anywhere.
   */
  jobberWork?: boolean;
}

/** A row's job: its number, its title, and every kind of work in it, the lead first. */
export interface JobberDayJob {
  id: string;
  number: string;
  title: string;
  /** Inspection types still live in the job, the lead first: ["HVAC", "OCCUPIED"]. */
  kinds: string[];
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

/**
 * What Jobber's visit popup shows beside the title (2026-11-25): the job's
 * number, the visit's Details, and the whole address. Optional on a day read
 * before they were carried.
 */
export interface JobberVisitExtras {
  jobNumber?: string | null;
  details?: string | null;
  address?: string | null;
  /**
   * Where the office dragged it among the day's Anytime work in Jobber
   * (`overrideOrder`, 2026-11-25): Jobber lists a person's Anytime visits by
   * it, lowest first.
   */
  order?: number | null;
}

export interface JobberDayOtherWork extends JobberVisitExtras {
  jobberVisitId: string;
  /** The building Jobber's property is linked to, for the map; null when unlinked. */
  buildingId?: string | null;
  title: string | null;
  property: string;
  technician: string | null;
  /** The technician here it is filed under, by Jobber's assignee email; null for nobody (2026-11-25). */
  technicianId: string | null;
  /** Everyone on it here, `technicianId` first; empty for nobody. */
  technicianIds: string[];
  startAt: string | null;
  /** Jobber has it completed. */
  completed: boolean;
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
  /**
   * Whether this screen's buttons that send to Jobber (our time or
   * technician, a cancellation, a completion) are switched on:
   * JOBBER_DAY_ACTIONS_ENABLED, off until one has been tried on a demo visit.
   * The buttons that only read from Jobber do not depend on it.
   */
  actionsEnabled: boolean;
  connected: boolean;
  technicians: JobberDayTechnician[];
  rows: JobberDayRow[];
  /** Jobber work that is not an inspection, listed so the counts add up. */
  otherWork: JobberDayOtherWork[];
}

/**
 * Everything Jobber's "Visit details" window shows for one visit (2026-11-25):
 * read from Jobber when the office opens it, never written back.
 */
export interface JobberVisitDetails {
  jobberVisitId: string;
  title: string | null;
  completed: boolean;
  /** The clock start, or null for Anytime. */
  startAt: string | null;
  /** The Texas day it is on. */
  date: string | null;
  /** The address one line a part, as Jobber prints it. */
  addressLines: string[];
  instructions: string | null;
  job: { number: string | null; title: string | null; url: string | null } | null;
  team: string[];
  client: { name: string | null; phones: string[]; emails: string[]; url: string | null } | null;
  notes: { message: string; createdAt: string | null }[];
  notesTotal: number;
  /** Checklists still to fill in on it, as Jobber counts them. */
  checklistsToDo: number | null;
  /** Null when Jobber's line items could not be read. */
  lineItems: { name: string | null; description: string | null; quantity: number | null; totalPrice: number | null }[] | null;
  /** When this was read from Jobber. */
  readAt: string;
}
