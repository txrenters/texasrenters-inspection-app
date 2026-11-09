import { describe, expect, it } from 'vitest';

import {
  agedBucket,
  projectedBucket,
  reportRange,
  reportRangeProblem,
  shareWords,
  taxShareCents,
} from '../src/contracts/invoice-reports';

describe('report ranges', () => {
  // Friday 2026-11-20.
  const today = '2026-11-20';

  it("cover Jobber's options, each ending today", () => {
    expect(reportRange('this_week', today)).toEqual({ from: '2026-11-15', to: today });
    expect(reportRange('this_month', today)).toEqual({ from: '2026-11-01', to: today });
    expect(reportRange('last_30_days', today)).toEqual({ from: '2026-10-22', to: today });
    expect(reportRange('last_90_days', today)).toEqual({ from: '2026-08-23', to: today });
    expect(reportRange('last_12_months', today)).toEqual({ from: '2025-11-21', to: today });
    expect(reportRange('this_year', today)).toEqual({ from: '2026-01-01', to: today });
    // A Sunday starts its own week.
    expect(reportRange('this_week', '2026-11-15')).toEqual({ from: '2026-11-15', to: '2026-11-15' });
  });

  it('refuse a span that is backwards, unfinished or longer than a year', () => {
    expect(reportRangeProblem(reportRange('last_12_months', today))).toBeNull();
    expect(reportRangeProblem({ from: '2026-11-21', to: today })).toBe('The first day comes after the last.');
    expect(reportRangeProblem({ from: '', to: today })).toBe('Choose a first and a last day.');
    expect(reportRangeProblem({ from: '2025-11-19', to: today })).toBe('Choose at most 366 days at a time.');
  });
});

describe('the buckets', () => {
  it("put an owed invoice in Jobber's due windows", () => {
    const today = '2026-11-20';
    expect(projectedBucket('2026-11-19', today)).toBe('late');
    expect(projectedBucket(today, today)).toBe('dueToday');
    expect(projectedBucket('2026-11-26', today)).toBe('dueWithin7');
    expect(projectedBucket('2026-11-27', today)).toBe('dueWithin30');
    expect(projectedBucket('2026-12-20', today)).toBe('dueWithin30');
    expect(projectedBucket('2026-12-21', today)).toBe('dueLater');
    expect(projectedBucket(null, today)).toBe('dueLater');
  });

  it('put a late invoice in its aged column', () => {
    expect([1, 29, 30, 59, 60, 89, 90, 400].map(agedBucket)).toEqual([
      'under30',
      'under30',
      'from30to60',
      'from30to60',
      'from60to90',
      'from60to90',
      'over90',
      'over90',
    ]);
  });
});

describe('shares', () => {
  it("give a payment its share of the invoice's tax", () => {
    expect(taxShareCents(10825, { taxCents: 825, totalCents: 10825 })).toBe(825);
    expect(taxShareCents(5412, { taxCents: 825, totalCents: 10825 })).toBe(412);
    expect(taxShareCents(3999, { taxCents: 0, totalCents: 3999 })).toBe(0);
    expect(taxShareCents(100, { taxCents: 10, totalCents: 0 })).toBe(0);
  });

  it('say a share in words', () => {
    expect(shareWords(2, 3)).toBe('67%');
    expect(shareWords(0, 0)).toBe('—');
  });
});
