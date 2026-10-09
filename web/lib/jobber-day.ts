import type { JobberDayState } from '@texasrenters/shared';

/**
 * How the console words and marks a visit's standing against Jobber, in one
 * place, so the dashboard, the schedule and the inspections list agree.
 */
export const JOBBER_DAY_LABEL: Record<JobberDayState, string> = {
  CANCELLED_HERE: 'Cancelled here, open in Jobber',
  DONE_HERE: 'Done here, open in Jobber',
  DONE_IN_JOBBER: 'Completed in Jobber, open here',
  UNSEEN: 'Gone from Jobber?',
  DAY_DIFFERS: 'Different day',
  TIME_DIFFERS: 'Different time',
  TECHNICIAN_DIFFERS: 'Different technician',
  NOT_IN_JOBBER: 'Not booked in Jobber',
  ONLY_IN_JOBBER: 'Only in Jobber',
  MATCHES: 'Matches',
};

/** Coral for what looks lost or wrong, amber for what needs a decision, grey when they agree. */
export function jobberDayTone(state: JobberDayState): 'destructive' | 'warning' | 'muted' {
  if (state === 'CANCELLED_HERE' || state === 'UNSEEN') return 'destructive';
  return state === 'MATCHES' ? 'muted' : 'warning';
}

/** Only one system has it at all. Drawn with a dashed edge rather than a colour. */
export const isOneSided = (state: JobberDayState) => state === 'NOT_IN_JOBBER' || state === 'ONLY_IN_JOBBER';

/** Short type marks for a dense grid: the office's own abbreviations. */
export const TYPE_MARK: Record<string, string> = {
  MOVE_IN: 'MI',
  MOVE_OUT: 'MO',
  OCCUPIED: 'OCC',
  BACK_TO_MARKET: 'BTM',
  HVAC: 'HVAC',
};
