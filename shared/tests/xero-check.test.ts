import { describe, expect, it } from 'vitest';

import { checkMonthLabel, checkMonthProblem, checkMonths } from '../src/contracts/xero-check';

describe('the months a company’s invoices can be checked against Xero', () => {
  it('are this one and the eleven before, newest first, across the new year', () => {
    const months = checkMonths('2026-02-14');
    expect(months).toHaveLength(12);
    expect(months.slice(0, 3)).toEqual(['2026-02', '2026-01', '2025-12']);
    expect(months.at(-1)).toBe('2025-03');
  });

  it('are never one still to come, or not a month', () => {
    expect(checkMonthProblem('2026-11', '2026-11-10')).toBeNull();
    expect(checkMonthProblem('2026-12', '2026-11-10')).toBe('A month still to come has nothing to check.');
    expect(checkMonthProblem('2026-13', '2026-11-10')).toBe('Choose a month.');
  });

  it('are named as people say them', () => {
    expect(checkMonthLabel('2026-11')).toBe('November 2026');
  });
});
