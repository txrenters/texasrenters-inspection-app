import { describe, expect, it } from 'vitest';

import {
  type LeaseDates,
  inspectionsDue,
  isWorkingDay,
  leavingOn,
  moveOutDueOn,
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

/** The office (2026-09-18): every lease, the day after it ends, booked sixty days before; Moses. */
describe('a move-out', () => {
  it('is the day after the lease ends, for every lease, notice or not', () => {
    // Ends Tuesday 20 October 2026: the move-out is Wednesday the 21st.
    expect(inspectionsDue(lease({ endDate: '2026-10-20' }), TODAY)).toEqual([
      { kind: 'MOVE_OUT', dueOn: '2026-10-21', scheduledOn: '2026-10-21' },
    ]);
  });

  it('counts from the scheduled move-out where Propertyware has one', () => {
    const due = inspectionsDue(lease({ endDate: '2027-03-31', scheduledMoveOutDate: '2026-10-20' }), TODAY);
    expect(due.find((entry) => entry.kind === 'MOVE_OUT')).toMatchObject({ dueOn: '2026-10-21' });
  });

  it('goes on the next working day when its day is not one', () => {
    // Ends Friday 30 October: the day after is Saturday the 31st, so Monday 2 November.
    expect(inspectionsDue(lease({ endDate: '2026-10-30' }), TODAY)).toEqual([
      { kind: 'MOVE_OUT', dueOn: '2026-10-31', scheduledOn: '2026-11-02' },
    ]);
  });

  it('is booked sixty days before its day, not sooner', () => {
    // 17 November is sixty days from Friday 18 September.
    expect(inspectionsDue(lease({ endDate: '2026-11-16' }), TODAY).map((entry) => entry.scheduledOn)).toEqual(['2026-11-17']);
    expect(inspectionsDue(lease({ endDate: '2026-11-17' }), TODAY)).toEqual([]);
  });

  it('is the next working day for a lease ending today', () => {
    expect(inspectionsDue(lease({ endDate: '2026-09-18' }), TODAY)).toEqual([
      { kind: 'MOVE_OUT', dueOn: '2026-09-19', scheduledOn: '2026-09-21' },
    ]);
  });

  it('is not booked once the lease has ended, nor for a tenancy that has already gone month-to-month', () => {
    expect(inspectionsDue(lease({ endDate: '2026-09-10' }), TODAY)).toEqual([]);
    expect(inspectionsDue(lease({ status: 'Going MTM', endDate: '2026-06-30' }), TODAY)).toEqual([]);
    expect(moveOutDueOn(lease({ endDate: '2026-09-17' }), TODAY)).toBeNull();
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

  it('is booked up to ninety days ahead, sooner than the move-out before it', () => {
    // Out Friday 20 November: the move-in on Saturday 12 December (so Monday the 14th) is inside the
    // ninety days, the move-out on the 21st not yet inside the sixty.
    expect(
      inspectionsDue(lease({ status: 'Active - Notice Given', noticeGivenDate: '2026-09-01', endDate: '2026-11-20' }), TODAY),
    ).toEqual([{ kind: 'MOVE_IN', dueOn: '2026-12-12', scheduledOn: '2026-12-14' }]);
    expect(
      inspectionsDue(lease({ status: 'Active - Notice Given', noticeGivenDate: '2026-09-01', endDate: '2027-01-31' }), TODAY),
    ).toEqual([]);
  });
});

/** The office (2026-09-18): the overdue ones three a day, not all on one Monday. */
describe('inspections whose day has already passed', () => {
  const overdue = (key: string, dueOn: string, kind: 'MOVE_OUT' | 'MOVE_IN' = 'MOVE_IN') => ({ key, kind, dueOn });

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
      [overdue('in-1', '2026-09-01'), overdue('in-2', '2026-09-02'), overdue('in-3', '2026-09-03'), overdue('out-1', '2026-09-04', 'MOVE_OUT')],
      TODAY,
    );
    expect(days.get('out-1')).toBe('2026-09-21');
  });
});
