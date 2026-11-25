import { jobberScheduleOf } from '../src/work-orders/work-order-jobber-schedule';

/** Whether a work order is already booked in Jobber (2026-11-26). Places and people invented. */
const visit = (startAt: string, over: Record<string, unknown> = {}) => ({
  id: `v-${startAt}`,
  title: '1204 Cedar Hollow Dr - Zone 1 - General Maintenance - #44901',
  startAt,
  endAt: null,
  allDay: true,
  completedAt: null,
  assignedUsers: { nodes: [{ id: 'j-ada', email: { raw: 'ada@example.test' }, name: { full: 'Ada Lane' } }] },
  ...over,
});

const TODAY = '2026-11-26';

describe('whether a work order is scheduled in Jobber', () => {
  it('is not, when its job has no visit the sync holds', () => {
    expect(jobberScheduleOf([], TODAY)).toEqual({ scheduled: false, date: null, startAt: null, team: [], completed: false });
    // A visit Jobber has not put on a day is not a booking.
    expect(jobberScheduleOf([visit('', { startAt: null })], TODAY).scheduled).toBe(false);
  });

  it('is, on the next visit still to do -- its day, Anytime or its clock time, and who is on it', () => {
    const result = jobberScheduleOf(
      [
        visit('2026-11-20T06:00:00Z', { completedAt: '2026-11-20T20:00:00Z' }),
        visit('2026-12-02T15:00:00Z', { allDay: false }),
        visit('2026-11-28T06:00:00Z'),
      ],
      TODAY,
    );
    expect(result).toEqual({ scheduled: true, date: '2026-11-28', startAt: null, team: ['Ada Lane'], completed: false });

    const timed = jobberScheduleOf([visit('2026-12-02T15:00:00Z', { allDay: false })], TODAY);
    expect(timed.startAt).toBe('2026-12-02T15:00:00.000Z');
  });

  it('shows the latest visit, done, when none is still to come', () => {
    const result = jobberScheduleOf(
      [visit('2026-11-19T06:00:00Z', { completedAt: 'x' }), visit('2026-11-24T06:00:00Z', { completedAt: '2026-11-24T21:00:00Z' })],
      TODAY,
    );
    expect(result).toMatchObject({ scheduled: true, date: '2026-11-24', completed: true });
  });

  it('reads nobody on it as an empty team, never a guess', () => {
    expect(jobberScheduleOf([visit('2026-11-28T06:00:00Z', { assignedUsers: { nodes: [] } })], TODAY).team).toEqual([]);
  });
});
