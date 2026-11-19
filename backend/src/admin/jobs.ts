import { InspectionStatus } from '@prisma/client';
import {
  VISIT_SERVICE_LABEL,
  isJobInspectionType,
  jobLeadType,
  jobServices,
  parseVisitDetails,
  reportableServices,
  type AdminJobService,
  type VisitServicesReport,
} from '@texasrenters/shared';

/**
 * What the job page reads off a job's inspections (2026-11-20, phase 5 of the
 * jobs plan). Plain functions over the rows, so the rules are tested apart
 * from the database.
 */

interface JobRow {
  id: string;
  inspectionType: string;
  status: InspectionStatus | string;
  startedAt?: Date | null;
  jobberVisitId?: string | null;
  jobberVisitDetails?: string | null;
}

/**
 * The inspection that leads a job: holds its Jobber visit, else its services,
 * else the kind that leads (`jobLeadType`). Read from what the rows carry, so
 * work added later -- an HVAC inspection beside an occupied lead -- never
 * takes the lead from the inspection the visit and the services are on.
 * Taken-off inspections lead only a job that has nothing else.
 */
export function jobLeadInspection<T extends JobRow>(rows: readonly T[]): T | undefined {
  const live = rows.filter((row) => row.status !== InspectionStatus.CANCELLED);
  const pool = live.length ? live : rows;
  return (
    pool.find((row) => row.jobberVisitId) ??
    pool.find((row) => reportableServices(parseVisitDetails(row.jobberVisitDetails)).length > 0) ??
    pool.find((row) => row.inspectionType === jobLeadType(pool.map((each) => each.inspectionType).filter(isJobInspectionType))) ??
    pool[0]
  );
}

/**
 * The services on the lead, as the phone lists them (`jobServices`: an HVAC
 * lead always has its filter change), each with what the technician answered.
 */
export function jobServicesOf(lead: JobRow & { servicesReport?: unknown }): AdminJobService[] {
  const report = (lead.servicesReport ?? null) as VisitServicesReport | null;
  return jobServices(parseVisitDetails(lead.jobberVisitDetails), lead.inspectionType).map((key) => {
    const answer = report?.services?.[key];
    return {
      key,
      label: VISIT_SERVICE_LABEL[key],
      outcome: !answer ? 'TODO' : answer.done ? 'DONE' : 'NOT_DONE',
      reason: answer && !answer.done ? answer.reason : null,
    };
  });
}

/**
 * Whether an inspection can come off its job: nobody has started it, and it
 * is neither the last piece of work left nor the lead while others remain --
 * the lead holds the services and the Jobber visit the others follow.
 */
export function canTakeOffJobWork(row: JobRow, lead: JobRow | undefined, liveCount: number): boolean {
  if (row.status !== InspectionStatus.SCHEDULED || row.startedAt) return false;
  if (liveCount <= 1) return false;
  return row.id !== lead?.id;
}
