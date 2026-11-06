import { visitStateOf } from '@texasrenters/shared';

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
}) => visitStateOf(inspection) === 'DONE';
