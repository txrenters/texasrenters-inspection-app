import { describe, expect, it } from 'vitest';

import { isOverdue, localToday, scheduledDay } from './overdue';

/**
 * The rule that decides whether work is late.
 *
 * The timezone case is the one that matters. `scheduledAt` is a Postgres `date`
 * serialised at midnight UTC, so anywhere behind UTC -- which is every office
 * this serves -- parsing it into a `Date` and asking for the local day answers
 * the day before. That would mark a job scheduled for today as overdue every
 * morning, in Texas, permanently.
 */

describe('scheduledDay', () => {
  it('reads the date written, not the date a timezone makes of it', () => {
    // Midnight UTC on the 25th is still the 25th, even at UTC-5 where a `Date`
    // would call it the 24th at 7pm.
    expect(scheduledDay('2026-08-25T00:00:00.000Z')).toBe('2026-08-25');
  });

  it('accepts a bare date', () => {
    expect(scheduledDay('2026-08-25')).toBe('2026-08-25');
  });

  it('has no answer for a missing or malformed date', () => {
    for (const value of [null, undefined, '', 'soon', '25/08/2026'])
      expect(scheduledDay(value)).toBeNull();
  });
});

describe('localToday', () => {
  it('is the reader calendar day, not the UTC one', () => {
    // 01:30 UTC on the 28th is still the 27th in Houston. `toISOString` would
    // answer the 28th and call yesterday's work due tomorrow.
    expect(localToday(new Date('2026-08-28T01:30:00.000Z'))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('isOverdue', () => {
  const base = { isCurrent: true, status: 'SCHEDULED', today: '2026-08-28' };

  it('flags work whose day has passed and still needs visiting', () => {
    expect(isOverdue({ ...base, scheduledAt: '2026-08-25T00:00:00.000Z' })).toBe(true);
  });

  it('does not flag work scheduled for today', () => {
    // The boundary. Off by one here and every technician is permanently late.
    expect(isOverdue({ ...base, scheduledAt: '2026-08-28T00:00:00.000Z' })).toBe(false);
  });

  it('does not flag work scheduled ahead', () => {
    expect(isOverdue({ ...base, scheduledAt: '2026-09-01T00:00:00.000Z' })).toBe(false);
  });

  it('leaves finished work alone however old it is', () => {
    // Anything from TECHNICIAN_SUBMITTED onward means the technician has left
    // the property. A past date there is history, not a debt -- and marking it
    // would train people to ignore the flag.
    for (const status of [
      'TECHNICIAN_SUBMITTED',
      'PROCESSING',
      'REVIEW_REQUIRED',
      'UNDER_REVIEW',
      'COMPLETED',
      'CANCELLED',
      'TBD',
    ])
      expect(isOverdue({ ...base, status, scheduledAt: '2026-01-01T00:00:00.000Z' })).toBe(false);
  });

  it('still flags in-progress and follow-up work', () => {
    for (const status of ['IN_PROGRESS', 'FOLLOW_UP_REQUIRED'])
      expect(isOverdue({ ...base, status, scheduledAt: '2026-08-25T00:00:00.000Z' })).toBe(true);
  });

  it('does not blame a technician for an assignment taken off them', () => {
    // A superseded assignment is somebody else's now.
    expect(
      isOverdue({ ...base, isCurrent: false, scheduledAt: '2026-08-25T00:00:00.000Z' }),
    ).toBe(false);
  });

  it('says nothing when there is no date to judge', () => {
    expect(isOverdue({ ...base, scheduledAt: null })).toBe(false);
    expect(isOverdue({ ...base, status: null, scheduledAt: '2026-08-25' })).toBe(false);
  });
});
