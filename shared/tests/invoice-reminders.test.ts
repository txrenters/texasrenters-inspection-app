import { describe, expect, it } from 'vitest';

import {
  DEFAULT_INVOICE_EMAIL_SETTINGS,
  daysBetween,
  followUpDaysProblem,
  followUpDueToday,
  followUpWhen,
  overdueWords,
  sortedFollowUpDays,
} from '../src/contracts/invoice-reminders';

describe('invoice follow-ups', () => {
  it("start where Jobber's were: on the due date and four days after, receipts by hand", () => {
    expect(DEFAULT_INVOICE_EMAIL_SETTINGS).toEqual({ followUpsEnabled: true, followUpDays: [0, 4], receiptsAutomatic: false });
  });

  it('refuses days it cannot keep', () => {
    expect(followUpDaysProblem([0, 4])).toBeNull();
    expect(followUpDaysProblem([])).toBeNull();
    expect(followUpDaysProblem([0, 4, 0])).toBe('Each follow-up needs its own day.');
    expect(followUpDaysProblem([-1])).toMatch(/due date or up to 60 days/);
    expect(followUpDaysProblem([61])).toMatch(/due date or up to 60 days/);
    expect(followUpDaysProblem([1.5])).toMatch(/due date or up to 60 days/);
    expect(followUpDaysProblem([0, 1, 2, 3, 4])).toBe('Choose at most 4 follow-ups.');
  });

  it('sorts the days, each once', () => {
    expect(sortedFollowUpDays([14, 0, 4, 4])).toEqual([0, 4, 14]);
  });

  it('says when each goes, and what the email calls it', () => {
    expect(followUpWhen(0)).toBe('On the due date');
    expect(followUpWhen(1)).toBe('1 day after it is due');
    expect(followUpWhen(4)).toBe('4 days after it is due');
    expect(overdueWords(0)).toBe('due today');
    expect(overdueWords(1)).toBe('1 day overdue');
    expect(overdueWords(4)).toBe('4 days overdue');
  });

  it('counts whole Texas days, across a month and a clock change', () => {
    expect(daysBetween('2026-10-30', '2026-11-03')).toBe(4);
    expect(daysBetween('2026-11-03', '2026-11-03')).toBe(0);
    expect(daysBetween('2026-11-04', '2026-11-03')).toBe(-1);
  });

  it('owes a follow-up only on one of the days, and only while the client still owes', () => {
    const owed = { status: 'AWAITING_PAYMENT', balanceCents: 3999, dueOn: '2026-11-16' };
    expect(followUpDueToday(owed, '2026-11-16', [0, 4])).toBe(0);
    expect(followUpDueToday(owed, '2026-11-20', [0, 4])).toBe(4);
    expect(followUpDueToday(owed, '2026-11-18', [0, 4])).toBeNull();
    expect(followUpDueToday(owed, '2026-11-15', [0, 4])).toBeNull();
    expect(followUpDueToday({ ...owed, balanceCents: 0 }, '2026-11-16', [0, 4])).toBeNull();
    expect(followUpDueToday({ ...owed, status: 'PAID' }, '2026-11-16', [0, 4])).toBeNull();
    expect(followUpDueToday({ ...owed, status: 'DRAFT' }, '2026-11-16', [0, 4])).toBeNull();
    expect(followUpDueToday({ ...owed, dueOn: null }, '2026-11-16', [0, 4])).toBeNull();
  });
});
