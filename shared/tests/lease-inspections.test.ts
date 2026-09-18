import { describe, expect, it } from 'vitest';

import {
  type LeaseDates,
  inspectionsDue,
  isWorkingDay,
  leavingOn,
  spreadOverdue,
  tenantIsLeaving,
  workingDayOnOrAfter,
} from '../src/leases/lease-inspections.js';

/** A lease on the report with nothing said about the tenant leaving. */
const lease = (over: Partial<LeaseDates> = {}): LeaseDates => ({
  status: 'Active',
  isActive: true,
  endDate: '2026-12-31',
  scheduledMoveOutDate: null,
  noticeGivenDate: null,
  droppedOn: null,
  renewed: false,
  ...over,
});

/** A Friday in September 2026. */
const TODAY = '2026-09-18';

describe('working days', () => {
  it('are weekdays that are not US federal holidays', () => {
    expect(isWorkingDay('2026-09-18')).toBe(true); // Friday
    expect(isWorkingDay('2026-09-19')).toBe(false); // Saturday
    expect(isWorkingDay('2026-11-26')).toBe(false); // Thanksgiving
  });

  it('move a day off to the next working day', () => {
    expect(workingDayOnOrAfter('2026-09-19')).toBe('2026-09-21');
    expect(workingDayOnOrAfter('2026-11-26')).toBe('2026-11-27');
    expect(workingDayOnOrAfter('2026-09-18')).toBe('2026-09-18');
  });
});

/** The office (2026-09-18): every lease, sixty days before it ends; Moses. */
describe('a move-out', () => {
  it('is sixty days before the lease ends, for every lease, notice or not', () => {
    // Ends Sunday 20 December 2026: sixty days before is Wednesday 21 October.
    expect(inspectionsDue(lease({ endDate: '2026-12-20' }), TODAY)).toEqual([
      { kind: 'MOVE_OUT', dueOn: '2026-10-21', scheduledOn: '2026-10-21' },
    ]);
  });

  it('counts from the scheduled move-out where Propertyware has one', () => {
    const due = inspectionsDue(lease({ endDate: '2027-03-31', scheduledMoveOutDate: '2026-12-20' }), TODAY);
    expect(due.find((entry) => entry.kind === 'MOVE_OUT')).toMatchObject({ dueOn: '2026-10-21' });
  });

  it('goes on the next working day when its day is not one', () => {
    // Ends Thursday 31 December: sixty days before is Sunday 1 November, so Monday the 2nd.
    expect(inspectionsDue(lease({ endDate: '2026-12-31' }), TODAY)).toEqual([
      { kind: 'MOVE_OUT', dueOn: '2026-11-01', scheduledOn: '2026-11-02' },
    ]);
  });

  it('is not booked more than ninety days ahead', () => {
    // Ends in April: its move-out is in February, beyond the ninety days.
    expect(inspectionsDue(lease({ endDate: '2027-04-30' }), TODAY)).toEqual([]);
  });

  it('goes on the next working day when its day has passed and the tenant is still there', () => {
    // Ends 20 October: sixty days before was 21 August.
    expect(inspectionsDue(lease({ endDate: '2026-10-20' }), TODAY)).toEqual([
      { kind: 'MOVE_OUT', dueOn: '2026-08-21', scheduledOn: '2026-09-21' },
    ]);
  });

  it('is not booked once the lease has ended, nor for a tenancy that has already gone month-to-month', () => {
    expect(inspectionsDue(lease({ endDate: '2026-09-10' }), TODAY)).toEqual([]);
    expect(inspectionsDue(lease({ status: 'Going MTM', endDate: '2026-06-30' }), TODAY)).toEqual([]);
  });

  it('is not booked after the tenant will have gone', () => {
    // Ends Saturday 19 September: the next working day after today is Monday the 21st.
    expect(inspectionsDue(lease({ endDate: '2026-09-19' }), TODAY)).toEqual([]);
  });
});

/** The office (2026-09-18): once the tenant is leaving, twenty-two days after they go; Amy. */
describe('a move-in', () => {
  it('is twenty-two days after a tenant who gave notice leaves', () => {
    const due = inspectionsDue(lease({ status: 'Active - Notice Given', noticeGivenDate: '2026-09-01', endDate: '2026-10-31' }), TODAY);
    // Out 31 October; twenty-two days later is Sunday 22 November, so Monday the 23rd.
    expect(due.find((entry) => entry.kind === 'MOVE_IN')).toEqual({ kind: 'MOVE_IN', dueOn: '2026-11-22', scheduledOn: '2026-11-23' });
  });

  it('is not booked for a lease that may simply renew', () => {
    expect(inspectionsDue(lease({ endDate: '2026-10-31' }), TODAY).map((entry) => entry.kind)).toEqual(['MOVE_OUT']);
  });

  it('is booked for an eviction once the tenant is gone from the report', () => {
    const evicted = lease({ status: 'Eviction', endDate: '2027-06-30', isActive: false, droppedOn: '2026-09-15' });
    expect(tenantIsLeaving(evicted)).toBe(true);
    expect(leavingOn(evicted)).toBe('2026-09-15');
    expect(inspectionsDue(evicted, TODAY)).toEqual([{ kind: 'MOVE_IN', dueOn: '2026-10-07', scheduledOn: '2026-10-07' }]);
  });

  it('is not booked when the lease went off the report because it was renewed as a new one', () => {
    expect(tenantIsLeaving(lease({ isActive: false, droppedOn: '2026-09-10', renewed: true }))).toBe(false);
  });

  it('goes on the next working day when its day passed in the last two weeks', () => {
    const gone = lease({ isActive: false, endDate: '2026-08-20', droppedOn: '2026-08-25' });
    // Out 20 August; due 11 September, a week ago.
    expect(inspectionsDue(gone, TODAY)).toEqual([{ kind: 'MOVE_IN', dueOn: '2026-09-11', scheduledOn: '2026-09-21' }]);
  });

  it('is left to the office when its day passed more than two weeks ago', () => {
    expect(inspectionsDue(lease({ isActive: false, endDate: '2026-07-31', droppedOn: '2026-08-01' }), TODAY)).toEqual([]);
  });

  it('is not booked more than ninety days ahead', () => {
    expect(
      inspectionsDue(lease({ status: 'Active - Notice Given', noticeGivenDate: '2026-09-01', endDate: '2027-01-31' }), TODAY).map(
        (entry) => entry.kind,
      ),
    ).toEqual(['MOVE_OUT']);
  });
});

/** The office (2026-09-18): the overdue ones three a day, not all on one Monday. */
describe('move-outs whose day has already passed', () => {
  const overdue = (key: string, dueOn: string, latest: string | null = null, kind: 'MOVE_OUT' | 'MOVE_IN' = 'MOVE_OUT') => ({
    key,
    kind,
    dueOn,
    latest,
  });

  it('go three a working day from the next one, soonest due first', () => {
    const days = spreadOverdue(
      ['e', 'a', 'g', 'c', 'b', 'f', 'd'].map((key, index) => overdue(key, `2026-09-0${index + 1}`)),
      TODAY,
    );
    // Friday the 18th: Monday the 21st takes three, Tuesday three, Wednesday the last.
    expect(Object.fromEntries([...days].sort(([left], [right]) => left.localeCompare(right)))).toEqual({
      e: '2026-09-21',
      a: '2026-09-21',
      g: '2026-09-21',
      c: '2026-09-22',
      b: '2026-09-22',
      f: '2026-09-22',
      d: '2026-09-23',
    });
  });

  it('count each kind on its own', () => {
    const days = spreadOverdue(
      [overdue('out-1', '2026-09-01'), overdue('out-2', '2026-09-02'), overdue('out-3', '2026-09-03'), overdue('in-1', '2026-09-04', null, 'MOVE_IN')],
      TODAY,
    );
    expect(days.get('in-1')).toBe('2026-09-21');
  });

  it('go on the next working day when their turn would come after the tenant leaves', () => {
    const days = spreadOverdue(
      [overdue('a', '2026-09-01'), overdue('b', '2026-09-02'), overdue('c', '2026-09-03'), overdue('leaving-soon', '2026-09-04', '2026-09-21')],
      TODAY,
    );
    expect(days.get('leaving-soon')).toBe('2026-09-21');
  });
});
