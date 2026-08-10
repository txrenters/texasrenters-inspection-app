import { hasNeverBeenAssigned } from '../src/utils/home-state';

const counts = (overrides: Partial<Parameters<typeof hasNeverBeenAssigned>[0]> = {}) => ({
  assignedCount: 0,
  inProgressCount: 0,
  completedTotal: 0,
  inProgressTotal: 0,
  recentCount: 0,
  ...overrides,
});

describe('hasNeverBeenAssigned', () => {
  it('is true only when every count is zero', () => {
    expect(hasNeverBeenAssigned(counts())).toBe(true);
  });

  it('is false for a technician with work in any state', () => {
    expect(hasNeverBeenAssigned(counts({ assignedCount: 1 }))).toBe(false);
    expect(hasNeverBeenAssigned(counts({ inProgressCount: 1 }))).toBe(false);
    expect(hasNeverBeenAssigned(counts({ recentCount: 1 }))).toBe(false);
  });

  it('trusts the dashboard totals, not just the visible lists', () => {
    // The reason the totals are separate arguments at all. `recent` holds only
    // the last few completed inspections, so a technician with two years of
    // history and an empty queue arrives here with every list empty — and would
    // be shown the first-day welcome screen if only the lists were consulted.
    expect(hasNeverBeenAssigned(counts({ completedTotal: 312, recentCount: 0 }))).toBe(false);
    expect(hasNeverBeenAssigned(counts({ inProgressTotal: 2, inProgressCount: 0 }))).toBe(false);
  });
});
