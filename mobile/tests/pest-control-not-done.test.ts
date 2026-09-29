import type { VisitServicesReport } from '@texasrenters/shared';

import {
  jobChecklistProblems,
  jobTasks,
  notDoneReason,
  UNTICKED_REASON,
  withServiceAnswer,
  withUntickedNotDone,
} from '../src/utils/job-tasks';

/**
 * Pest control left undone never stops End job, and the office can always tell
 * it did not happen (the office, 2026-09-29).
 */

const DETAILS = 'Filter Change: 20x25x1 hallway + Pest Control + Occupied Inspection';

const empty = (): VisitServicesReport => ({ services: {}, filters: [], filtersInstalled: [], notes: null });

describe('a service left unticked at End job', () => {
  it('goes in as not done, to be booked again', () => {
    const report = withUntickedNotDone(empty(), ['pestControl']);
    expect(report.services.pestControl).toEqual({ done: false, reason: UNTICKED_REASON, reschedule: true });
  });

  it('satisfies the rule the server runs, so the job is not refused', () => {
    const before = jobChecklistProblems(DETAILS, empty());
    expect(before.some((problem) => /pest control/i.test(problem))).toBe(true);
    const after = jobChecklistProblems(DETAILS, withUntickedNotDone(empty(), ['pestControl']));
    expect(after.some((problem) => /pest control/i.test(problem))).toBe(false);
  });

  it('keeps an answer the technician already gave on the row', () => {
    const noted = withServiceAnswer(empty(), 'pestControl', {
      done: false,
      reason: 'Pets — dog loose in the yard',
      reschedule: false,
    });
    expect(withUntickedNotDone(noted, ['pestControl']).services.pestControl).toEqual({
      done: false,
      reason: 'Pets — dog loose in the yard',
      reschedule: false,
    });
  });

  it('reads on the list as not done, with the rebook', () => {
    const tasks = jobTasks({
      visitDetails: DETAILS,
      inspectionType: 'OCCUPIED',
      report: withUntickedNotDone(empty(), ['pestControl']),
      areas: { completed: 0, total: 3 },
    });
    expect(tasks.find((task) => task.key === 'pestControl')).toMatchObject({
      state: 'NOT_DONE',
      detail: `${UNTICKED_REASON} · rebook`,
    });
  });
});

describe('the note left on a service not done', () => {
  it('is the reason picked, then the note', () => {
    expect(notDoneReason('No time', '  Back Thursday  ')).toBe('No time — Back Thursday');
  });

  it('can be only a note, or only a reason', () => {
    expect(notDoneReason(null, 'Tenant asked for next week')).toBe('Tenant asked for next week');
    expect(notDoneReason('Pets', '')).toBe('Pets');
  });

  it('is never empty, because the server refuses a not done without a reason', () => {
    expect(notDoneReason(null, '   ')).toBe(UNTICKED_REASON);
  });
});
