import {
  isWorkedVisit,
  VISIT_SERVICE_LABEL,
  visitStateOf,
  type ReportableVisitService,
  type VisitOpenWork,
} from '@texasrenters/shared';

import { typeTitle } from './inspection-type-tone';

/**
 * Whether a job's page leads with its review.
 *
 * Reviewing the rooms is what the page is for once a technician has walked them,
 * so that is when the figures show and Areas comes first. Before then there is
 * nothing to review and the visit is what matters: who, when and what to do. A
 * job nobody got into was submitted but has nothing in it, so it stays with its
 * visit, whose alert says why.
 */
export const reviewComesFirst = (inspection: {
  status: string;
  completionBlockedReason?: string | null;
  openWork?: VisitOpenWork | null;
}) => isWorkedVisit(visitStateOf(inspection));

/**
 * What a partially complete visit still owes, in words: "Flea treatment still
 * to do", "Pest control and occupied inspection still to do". Empty when it
 * owes nothing.
 */
export function openWorkWords(work: VisitOpenWork | null | undefined): string {
  if (!work) return '';
  const jobs = [
    ...work.services.map((service) => VISIT_SERVICE_LABEL[service as ReportableVisitService] ?? service),
    ...work.inspections.map((type) => `${typeTitle(type)} inspection`),
  ].map((job, index) => (index === 0 || job.startsWith('HVAC') ? job : job.charAt(0).toLowerCase() + job.slice(1)));
  if (!jobs.length) return '';
  const listed = jobs.length > 1 ? `${jobs.slice(0, -1).join(', ')} and ${jobs.at(-1)}` : jobs[0];
  return `${listed} still to do`;
}

/**
 * Whether the visit's title and Details can be changed from here: one Jobber
 * has, when edits reach it, or one booked here and not sent yet.
 */
export const visitCanBeEdited = (inspection: {
  scheduledInJobber?: boolean;
  jobberEditsPushed?: boolean;
  jobberBooking?: { status: string } | null;
}) =>
  inspection.scheduledInJobber
    ? Boolean(inspection.jobberEditsPushed)
    : inspection.jobberBooking?.status === 'PENDING' || inspection.jobberBooking?.status === 'FAILED';
