import { nextQuarter, quarterOf } from './quarter-plan.js';
import { parseVisitDetails } from './visit-details.js';
import { MAX_BOOKING_FILTER_QUANTITY, tenancyZoneLabel, type JobberBookingInput } from './visit-details-writer.js';
import { REPORTABLE_VISIT_SERVICES, type ReportableVisitService } from './visit-services.js';
import { rescheduleMondaysOfQuarter } from './zone-rotation.js';

/**
 * A visit somebody has to book again, and the office's answer (2026-10-21).
 *
 * A technician's "book it again" used to be a flag in the services report and a
 * line in the Jobber note: nothing listed them and nothing said whether one was
 * booked. Each is now a request the console's queue answers -- the same visit
 * moved to another day, a new visit booked for what was not done, or dismissed
 * with a reason -- and each answer reaches Jobber.
 */

export type RescheduleRequestKind = 'BEFORE_VISIT' | 'NO_ACCESS' | 'SERVICES_NOT_DONE';
export type RescheduleRequestStatus = 'OPEN' | 'SENDING' | 'DONE' | 'DISMISSED';
export type RescheduleRequestOutcome = 'MOVED' | 'REBOOKED';

/** What the queue offers: a visit still to happen moves; one already closed is booked again. */
export type RescheduleRequestAction = 'MOVE' | 'BOOK_AGAIN';

export const RESCHEDULE_KIND_LABEL: Record<RescheduleRequestKind, string> = {
  BEFORE_VISIT: 'Asked before the visit',
  NO_ACCESS: 'Could not get in',
  SERVICES_NOT_DONE: 'Not done on the visit',
};

/** The queue's two lists: what is still with the office, and what was answered. */
export const RESCHEDULE_REQUEST_FILTERS = ['open', 'closed'] as const;
export type RescheduleRequestFilter = (typeof RESCHEDULE_REQUEST_FILTERS)[number];

export interface RescheduleRequestPerson {
  id: string;
  displayName: string;
}

export interface RescheduleRequestView {
  id: string;
  kind: RescheduleRequestKind;
  status: RescheduleRequestStatus;
  outcome: RescheduleRequestOutcome | null;
  /** Moved or booked by a coordinator in Jobber, and closed by the sync. */
  resolvedInJobber: boolean;
  /** The booked services to do again. Empty when the visit itself is what is asked for. */
  services: ReportableVisitService[];
  reason: string;
  /** The day the technician suggested, `YYYY-MM-DD`. */
  preferredOn: string | null;
  requestedAt: string;
  requestedBy: RescheduleRequestPerson | null;
  /** The visit that asked. */
  inspection: {
    id: string;
    inspectionType: string;
    /** `YYYY-MM-DD`: a day, never a moment. */
    scheduledOn: string;
    status: string;
    address: string | null;
    city: string | null;
    technician: RescheduleRequestPerson | null;
    /** Booked in Jobber, so an answer is sent there too. */
    inJobber: boolean;
  };
  /** The visit booked again for it, here or by a coordinator in Jobber. */
  rebook: { id: string; scheduledOn: string; status: string } | null;
  action: RescheduleRequestAction;
  /** The day the queue offers first: the technician's, else the next Monday kept for rescheduled visits. */
  suggestedDay: string | null;
  dismissReason: string | null;
  /** Why Jobber refused the answer; the request is back with the office. */
  jobberError: string | null;
  resolvedAt: string | null;
  resolvedBy: RescheduleRequestPerson | null;
}

export interface RescheduleRequestList {
  items: RescheduleRequestView[];
  counts: { open: number; sending: number };
  /** Console edits reach Jobber on this server (JOBBER_PUSH_EDITS_ENABLED): a Jobber visit can be moved here. */
  jobberEditsPushed: boolean;
  /** Visits can be booked in Jobber from here (JOBBER_BOOKING_ENABLED). */
  jobberBookingEnabled: boolean;
}

export interface MoveRescheduleRequestInput {
  /** The new day, `YYYY-MM-DD` (Texas). */
  scheduledOn: string;
}

export interface BookAgainRescheduleRequestInput {
  /** The day to book, `YYYY-MM-DD` (Texas). */
  scheduledOn: string;
  /** Who goes; the visit's technician when left out, nobody when null. */
  technicianId?: string | null;
}

export interface DismissRescheduleRequestInput {
  reason: string;
}

/** A reason the office or the technician gives, kept to what a Jobber note can carry. */
export const MAX_RESCHEDULE_REASON = 500;

/**
 * The next Monday kept for rescheduled visits after `today`.
 *
 * The plan keeps every Monday from its second week free for the visits moved
 * out of the week before (`isRescheduleMonday`), holidays already out. Read
 * from the quarter's start: a plan that starts early shifts its weeks, which
 * only ever moves the suggestion, and the office picks the day anyway.
 */
export function nextRescheduleMonday(today: string, closedDays: readonly string[] = []): string | null {
  const quarter = quarterOf(new Date(`${today}T00:00:00.000Z`));
  for (const candidate of [quarter, nextQuarter(quarter)]) {
    const monday = rescheduleMondaysOfQuarter(candidate, closedDays).find((date) => date > today);
    if (monday) return monday;
  }
  return null;
}

/**
 * The day the queue offers first (the office, 2026-10-21): the day the
 * technician suggested, while it is still ahead, else the next Monday kept for
 * rescheduled visits.
 */
export function suggestedRescheduleDay(today: string, preferredOn: string | null | undefined): string | null {
  if (preferredOn && preferredOn > today) return preferredOn;
  return nextRescheduleMonday(today);
}

/** The services a request names, in the office's order, whatever else was stored. */
export function rescheduleServices(services: readonly string[]): ReportableVisitService[] {
  return REPORTABLE_VISIT_SERVICES.filter((service) => services.includes(service));
}

/**
 * The booking that books a visit again, read from the visit that asked.
 *
 * Only the services still to do, and everything else as the first visit had
 * it -- the zone and the benefit package from its title, the plan, who to
 * call, how to get in, the filters to bring -- with the reason at the top of
 * the notes, so the technician sent back knows why. Read from the Details as
 * Jobber held them: the parse is a reading, but what it cannot read stays in
 * the notes rather than being dropped.
 */
export function rebookingFromVisit(visit: {
  title: string | null;
  details: string | null;
  services: readonly string[];
  /** The day the first visit was on, `YYYY-MM-DD`. */
  scheduledOn: string;
  reason: string;
}): JobberBookingInput {
  const read = parseVisitDetails(visit.details);
  const services = rescheduleServices(visit.services);
  const title = visit.title ?? '';
  const zone = /\bzone\s*(\d{1,2})\b/i.exec(title)?.[1] ?? null;
  return {
    zone: tenancyZoneLabel(zone),
    benefitPackage: /tenant\s+benefit\s+package/i.test(title),
    services: {
      filterChange: services.includes('filterChange'),
      pestControl: services.includes('pestControl'),
      fleaTreatment: services.includes('fleaTreatment'),
    },
    filters: services.includes('filterChange')
      ? read.filters.map((filter) => ({
          size: filter.size,
          quantity: Math.min(Math.max(filter.quantity, 1), MAX_BOOKING_FILTER_QUANTITY),
          location: filter.location,
          media: filter.media,
        }))
      : [],
    planTier: read.plan?.tier ?? null,
    hvacOptedOut: read.plan?.hvacOptedOut ?? false,
    contactTenantsBeforeArrival: read.contactTenantsBeforeArrival,
    tenants: read.tenants.map((tenant) => ({ name: tenant.name ?? '', phones: tenant.phones, unit: tenant.unit })),
    accessNotes: read.accessNotes,
    notes: [`Booked again from the visit on ${visit.scheduledOn}: ${visit.reason.trim()}`, ...read.notes].slice(0, 10),
  };
}
