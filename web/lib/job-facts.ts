import {
  REPORTABLE_VISIT_SERVICES,
  isWorkedVisit,
  parseVisitDetails,
  visitStateOf,
  type AdminInspection,
  type VisitServicesReport,
} from '@texasrenters/shared';

import { formatScheduledDate } from './format';
import { jobWorked } from './job-time';
import { weekdayOf } from './schedule-calendar';

/**
 * The facts a job page opens on, under its title (the office, 2026-11-17: "I
 * want the key information to be on the top").
 *
 * Technician, date and time on site come first on every job, in that order, so
 * the eye finds them in the same place whatever it is looking at. What follows
 * is what matters for that kind of job at that moment: who to call and how to
 * get in before the visit; what was done, what it is compared with and where
 * the review stands after it.
 *
 * Kept apart from its drawing so the rules are tested as rules.
 */

export interface JobFact {
  key: string;
  label: string;
  value: string;
  /** A second, quieter line. */
  detail?: string;
  /** Where the value leads. */
  href?: string;
  tone?: 'warning';
  /** The jobs on the visit, one mark each, in the order the office lists them. */
  meter?: Array<'done' | 'open'>;
}

/** The jobs a submitted visit was booked for, and whether each was done. */
export function jobsOnVisit(
  inspection: Pick<AdminInspection, 'inspectionType' | 'status' | 'completionBlockedReason' | 'openWork'>,
  report: VisitServicesReport | null | undefined,
): Array<{ job: string; done: boolean }> {
  const services = REPORTABLE_VISIT_SERVICES.filter((service) => report?.services[service]).map((service) => ({
    job: service as string,
    done: Boolean(report?.services[service]?.done),
  }));
  // A filter delivery has no inspection of its own: the services are the job.
  if (inspection.inspectionType === 'AC_FILTER_DELIVERY') return services;
  const others = (inspection.openWork?.inspections ?? []).map((type) => ({ job: type, done: false }));
  return [...services, { job: inspection.inspectionType, done: true }, ...others];
}

const COMPARED_TYPES = new Set(['MOVE_OUT', 'OCCUPIED', 'BACK_TO_MARKET']);

export function jobKeyFacts(input: {
  inspection: AdminInspection;
  technicianName: string | null;
  /** The move-in this job is compared with; undefined while that is not known. */
  baseline: { id: string; scheduledAt: string } | null | undefined;
  areas: { reviewed: number; total: number } | null;
  /** Findings waiting for a decision; null when the reader may not see findings, or they are loading. */
  pendingFindings: number | null;
  now?: number;
}): JobFact[] {
  const { inspection } = input;
  const state = visitStateOf(inspection);
  const worked = jobWorked(inspection, input.now);
  const walked = isWorkedVisit(state);
  const upcoming = state === 'SCHEDULED' || state === 'IN_PROGRESS' || state === 'FOLLOW_UP';
  const facts: JobFact[] = [
    input.technicianName
      ? { key: 'technician', label: 'Technician', value: input.technicianName }
      : {
          key: 'technician',
          label: 'Technician',
          value: 'Not assigned',
          ...(upcoming ? { detail: 'Required before field work can start', tone: 'warning' as const } : {}),
        },
    {
      key: 'date',
      label: 'Date',
      value: `${weekdayOf(inspection.scheduledAt.slice(0, 10))}, ${formatScheduledDate(inspection.scheduledAt)}`,
    },
    worked
      ? {
          key: 'onSite',
          label: 'On site',
          value: worked.window,
          detail: `${worked.worked}${worked.running ? ' so far' : ''} on the job`,
        }
      : { key: 'onSite', label: 'On site', value: 'Not started' },
  ];

  if (upcoming) {
    // Before the visit: who to call and how to get in, as the visit's Details give them.
    const read = parseVisitDetails(inspection.jobberVisitDetails);
    const tenant = read.tenants.find((entry) => entry.name || entry.phones.length);
    if (tenant)
      facts.push({
        key: 'tenant',
        label: read.tenants.length > 1 ? `Tenant · 1 of ${read.tenants.length}` : 'Tenant',
        value: tenant.name ?? tenant.phones[0],
        ...(tenant.name && tenant.phones.length ? { detail: tenant.phones.join(' · ') } : {}),
      });
    if (read.accessNotes.length)
      facts.push({
        key: 'access',
        label: 'Access',
        value: read.accessNotes[0],
        ...(read.accessNotes.length > 1 ? { detail: `and ${read.accessNotes.length - 1} more, under Instructions` } : {}),
      });
    if (input.areas?.total)
      facts.push({
        key: 'areas',
        label: 'To inspect',
        value: `${input.areas.total} ${input.areas.total === 1 ? 'area' : 'areas'}`,
      });
    return facts;
  }
  if (!walked) return facts;

  const report = inspection.servicesReport ?? null;
  const jobs = jobsOnVisit(inspection, report);
  // One job is the inspection alone: "1 of 1" says nothing the status has not.
  if (jobs.length > 1) {
    const done = jobs.filter((job) => job.done).length;
    facts.push({
      key: 'work',
      label: 'Work done',
      value: `${done} of ${jobs.length} jobs`,
      meter: jobs.map((job) => (job.done ? 'done' : 'open')),
      // Marked only while something is still owed: a job the office took off
      // the visit stays "not done" in the report without being a problem.
      ...(state === 'PARTIALLY_COMPLETE' ? { tone: 'warning' as const } : {}),
    });
  }
  if (inspection.inspectionType === 'HVAC' && report?.filters?.length) {
    const changed = report.filters.filter((filter) => filter.changed).length;
    facts.push({
      key: 'filters',
      label: 'Filters',
      value: `${changed} of ${report.filters.length} changed`,
      detail: [...new Set(report.filters.map((filter) => filter.size))].join(' · '),
      ...(changed < report.filters.length ? { tone: 'warning' as const } : {}),
    });
  }
  if (COMPARED_TYPES.has(inspection.inspectionType))
    facts.push(
      input.baseline
        ? {
            key: 'baseline',
            label: 'Compared with',
            value: `Move-in · ${formatScheduledDate(input.baseline.scheduledAt)}`,
            href: `/inspections/${input.baseline.id}`,
          }
        : {
            key: 'baseline',
            label: 'Compared with',
            value: 'No move-in',
            ...(inspection.inspectionType === 'MOVE_OUT' ? { tone: 'warning' as const } : {}),
          },
    );
  if (inspection.inspectionType === 'MOVE_IN')
    facts.push({
      key: 'baseline',
      label: 'Used as',
      value: 'Move-in baseline',
      detail: 'The next move-out is compared with it',
    });
  if (input.areas)
    facts.push({
      key: 'review',
      label: 'Review',
      value: `${input.areas.reviewed} of ${input.areas.total} areas`,
      ...(input.pendingFindings === null
        ? {}
        : input.pendingFindings
          ? {
              detail: `${input.pendingFindings} ${input.pendingFindings === 1 ? 'finding' : 'findings'} to decide`,
              tone: 'warning' as const,
            }
          : { detail: 'No findings to decide' }),
    });
  if (inspection.inspectionType === 'HVAC' && inspection.nextInspectionAlert?.trim())
    facts.push({ key: 'alert', label: 'Next inspection alert', value: inspection.nextInspectionAlert.trim() });
  return facts;
}
