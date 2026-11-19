/**
 * Jobs (2026-11-20, phase 1 of the jobs plan).
 *
 * What the office books is a job: a number, a title, one property, and every
 * inspection the visit is for -- an occupied visit with its HVAC inspection,
 * filters and pest control is one job, not two bookings. Each inspection in it
 * is still its own, with its own areas, report and review; the job groups them.
 *
 * The services (filter change, pest control, flea treatment) ride on one of the
 * job's inspections, the lead, as they ride on an inspection today: that is
 * where the phone lists them from. The lead also holds the job's Jobber visit
 * when it is booked there; the others follow it, as an HVAC visit's occupied
 * companion does.
 *
 * Phase 1 makes jobs that hold at least one inspection. A job of services
 * alone needs a visit the phone shows without rooms, which comes with an app
 * update (phase 6), and work orders join in phase 4.
 */
import type { JobberBookingInput, VisitServicesBooking } from './visit-details-writer.js';
import { isBookableInspectionType } from './visit-details-writer.js';
import { REPORTABLE_VISIT_SERVICES, VISIT_SERVICE_LABEL, type ReportableVisitService } from './visit-services.js';
import type { VisitState } from './visit-state.js';

/** The inspections a job can hold, in the order the office lists them. */
export const JOB_INSPECTION_TYPES = [
  'MOVE_IN',
  'MOVE_OUT',
  'OCCUPIED',
  'BACK_TO_MARKET',
  'HVAC',
  'ROOF',
  'SUPRA_LOCKBOX_PLACEMENT',
  'SUPRA_LOCKBOX_REMOVAL',
] as const;
export type JobInspectionType = (typeof JOB_INSPECTION_TYPES)[number];

export function isJobInspectionType(type: string | null | undefined): type is JobInspectionType {
  return (JOB_INSPECTION_TYPES as readonly string[]).includes(type ?? '');
}

export const JOB_INSPECTION_LABEL: Record<JobInspectionType, string> = {
  MOVE_IN: 'Move-in',
  MOVE_OUT: 'Move-out',
  OCCUPIED: 'Occupied',
  BACK_TO_MARKET: 'Back to market',
  HVAC: 'HVAC',
  ROOF: 'Roof',
  SUPRA_LOCKBOX_PLACEMENT: 'Supra lockbox placement',
  SUPRA_LOCKBOX_REMOVAL: 'Supra lockbox removal',
};

/**
 * Which inspection leads the job: holds its services and its Jobber visit.
 *
 * HVAC first, because the AC filters are scored on the filter change (Moses,
 * 2026-10-01) and Jobber's HVAC + Occupied visits are held by HVAC already;
 * then the kinds that can carry services; then the rest.
 */
const LEAD_ORDER: readonly JobInspectionType[] = [
  'HVAC',
  'OCCUPIED',
  'MOVE_OUT',
  'MOVE_IN',
  'BACK_TO_MARKET',
  'ROOF',
  'SUPRA_LOCKBOX_PLACEMENT',
  'SUPRA_LOCKBOX_REMOVAL',
];

export function jobLeadType(types: readonly JobInspectionType[]): JobInspectionType | null {
  return LEAD_ORDER.find((type) => types.includes(type)) ?? null;
}

/**
 * A job's kinds of work as the Schedule lists them: the lead first, then the
 * office order, each once. A kind a job cannot be made with (a work order that
 * joined it) comes last, as it is.
 */
export function jobKindsInOrder(types: readonly string[]): string[] {
  const known = JOB_INSPECTION_TYPES.filter((type) => types.includes(type));
  const lead = jobLeadType(known);
  const rest = [...new Set(types.filter((type) => !isJobInspectionType(type)))];
  return [...(lead ? [lead] : []), ...known.filter((type) => type !== lead), ...rest];
}

/** Whether the lead can carry services: only the kinds whose Details this system writes. */
export function jobCanCarryServices(types: readonly JobInspectionType[]): boolean {
  return isBookableInspectionType(jobLeadType(types));
}

const SERVICE_WORDS: { key: keyof VisitServicesBooking['services']; words: string }[] = [
  { key: 'filterChange', words: 'filters' },
  { key: 'pestControl', words: 'pest control' },
  { key: 'fleaTreatment', words: 'flea treatment' },
];

/**
 * The title a job is given when the office types none: "Occupied + HVAC,
 * filters and pest control". The inspections in the office's order, then the
 * services.
 */
export function jobTitleFor(
  types: readonly JobInspectionType[],
  services?: VisitServicesBooking['services'] | null,
): string {
  const inspections = JOB_INSPECTION_TYPES.filter((type) => types.includes(type)).map(
    (type) => JOB_INSPECTION_LABEL[type],
  );
  const extras = SERVICE_WORDS.filter(({ key }) => services?.[key]).map(({ words }) => words);
  const tail =
    extras.length > 1 ? `${extras.slice(0, -1).join(', ')} and ${extras[extras.length - 1]}` : extras[0];
  const head = inspections.join(' + ') || 'Job';
  return tail ? `${head}, ${tail}` : head;
}

/**
 * The work in a job, one line each, as the technician's email lists it:
 * "Occupied inspection", "HVAC inspection", "AC filter change", "Pest control".
 * The lead first, as the job was made.
 */
export function jobWorkLines(
  types: readonly JobInspectionType[],
  services?: VisitServicesBooking['services'] | null,
): string[] {
  const lead = jobLeadType(types);
  const ordered = lead ? [lead, ...JOB_INSPECTION_TYPES.filter((type) => type !== lead && types.includes(type))] : [];
  return [
    ...ordered.map((type) =>
      type.startsWith('SUPRA_') ? JOB_INSPECTION_LABEL[type] : `${JOB_INSPECTION_LABEL[type]} inspection`,
    ),
    ...REPORTABLE_VISIT_SERVICES.filter((service) => services?.[service]).map(
      (service) => VISIT_SERVICE_LABEL[service],
    ),
  ];
}

export const JOB_NUMBER_PREFIX = 'J-';
export const JOB_NUMBER_MAX_LENGTH = 40;
export const JOB_TITLE_MAX_LENGTH = 160;

/** "J-00042": the console's own series, which never meets Jobber's plain numbers. */
export function formatJobNumber(sequence: number): string {
  return `${JOB_NUMBER_PREFIX}${String(sequence).padStart(5, '0')}`;
}

/**
 * A typed job number as it is kept: trimmed, spaces run together, capitals.
 * Null when it cannot be one -- empty, too long, or not letters, digits and
 * `- / . _` with spaces between.
 */
export function normalizeJobNumber(typed: string | null | undefined): string | null {
  const number = (typed ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
  if (!number || number.length > JOB_NUMBER_MAX_LENGTH) return null;
  return /^[A-Z0-9][A-Z0-9 ./_-]*$/.test(number) ? number : null;
}

/** POST /admin/jobs. */
export interface CreateJobInput {
  propertyId: string;
  unitId?: string;
  leaseId?: string;
  /** The day, "2026-11-23". Every inspection in the job takes it. */
  scheduledAt: string;
  technicianId?: string;
  /** Typed by the office; `jobTitleFor` otherwise. */
  title?: string;
  /** Typed by the office; the next in the series otherwise. */
  number?: string;
  inspectionTypes: JobInspectionType[];
  /** The services, when the job is not booked in Jobber (the booking carries its own). */
  visitServices?: VisitServicesBooking;
  /** Book the job's one visit in Jobber, on its lead inspection. */
  jobberBooking?: JobberBookingInput;
  priority?: 'STANDARD' | 'HIGH';
  internalNotes?: string;
  allowTechnicianAreaCapture?: boolean;
  /** One press of Save: a retry with the same key returns the job it made. */
  requestKey: string;
}

export interface AdminJobInspection {
  id: string;
  inspectionType: string;
  status: string;
  /** Where it stands, as the lists say it: Scheduled, Complete, Partially complete... */
  state: VisitState;
  /** Holds the job's services and, when booked, its Jobber visit. */
  lead: boolean;
  technician: { id: string; displayName: string } | null;
  /**
   * Whether it can come off the job: nobody has started it, and it is neither
   * the job's last piece of work nor its lead while others remain.
   */
  canTakeOff: boolean;
}

/** A service on the job's lead, and what the technician answered for it. */
export interface AdminJobService {
  key: ReportableVisitService;
  label: string;
  outcome: 'TODO' | 'DONE' | 'NOT_DONE';
  /** Why it was not done, as the technician said. */
  reason: string | null;
}

/** A job as the console reads it. */
export interface AdminJob {
  id: string;
  number: string;
  title: string;
  source: 'CONSOLE';
  /** The inspections' day, "2026-11-23". */
  scheduledAt: string | null;
  property: { id: string; name: string | null; addressLine1: string | null };
  unit: { id: string; name: string | null } | null;
  createdAt: string;
  /** The whole job, from its inspections: Partially complete while any is still owed (`jobStateOf`). */
  state: VisitState;
  /** Who the job is with: its lead's technician. */
  technician: { id: string; displayName: string } | null;
  /** The services on its lead, each with its answer. */
  services: AdminJobService[];
  /** Whether work can still be added: its lead is still to be done. */
  canAddWork: boolean;
  /** The lead first, then the office order; taken-off (cancelled) ones last. */
  inspections: AdminJobInspection[];
}

/** POST /admin/jobs/:jobId/work: more inspections on the job's day, for its technician. */
export interface AddJobWorkInput {
  inspectionTypes: JobInspectionType[];
}

/**
 * A job's state from its inspections' (2026-11-20): taken-off ones do not
 * count. Complete when every one is; Partially complete when some are done
 * and something is still owed; otherwise the furthest along of the rest.
 */
export function jobStateOf(states: readonly VisitState[]): VisitState {
  const live = states.filter((state) => state !== 'CANCELLED');
  if (!live.length) return states.length ? 'CANCELLED' : 'SCHEDULED';
  if (live.every((state) => state === 'DONE')) return 'DONE';
  if (live.every((state) => state === 'COULD_NOT_GET_IN')) return 'COULD_NOT_GET_IN';
  if (live.some((state) => state === 'IN_PROGRESS')) return 'IN_PROGRESS';
  if (live.some((state) => state === 'FOLLOW_UP')) return 'FOLLOW_UP';
  if (live.some((state) => state === 'DONE' || state === 'PARTIALLY_COMPLETE' || state === 'COULD_NOT_GET_IN'))
    return 'PARTIALLY_COMPLETE';
  return 'SCHEDULED';
}

/** GET /admin/jobs/next-number: what the series would give now. Not held. */
export interface JobNextNumber {
  number: string;
}
