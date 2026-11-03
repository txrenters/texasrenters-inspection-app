import { describe, expect, it } from 'vitest';

import { adminNavigation } from '@/lib/admin-navigation';
import { parseConsoleShell } from '@/lib/console-shell';
import {
  getJobberNavigation,
  JOBBER_CREATE_TYPES,
  JOBBER_SETTINGS_SECTIONS,
  JOBBER_SIDEBAR_SECTIONS,
} from '@/lib/jobber-navigation';

const everyPage = adminNavigation.flatMap((group) => group.items.map((item) => item.href));
const placed = [
  ...JOBBER_SIDEBAR_SECTIONS.flat(),
  ...JOBBER_SETTINGS_SECTIONS.flatMap((section) => section.hrefs),
];

describe('the Jobber-style arrangement', () => {
  /**
   * The point of the arrangement is that it is the same console. A page added
   * to the classic sidebar and not placed here would simply be missing from
   * the Jobber shell, with nothing to say so.
   */
  it('places every page of the console', () => {
    expect([...placed].sort()).toEqual([...everyPage].sort());
  });

  it('places each page once', () => {
    expect(new Set(placed).size).toBe(placed.length);
  });

  it('shows everything to an account allowed everything', () => {
    const navigation = getJobberNavigation(() => true);
    const shown = [
      ...navigation.sidebar.flat(),
      ...navigation.settings.flatMap((section) => section.items),
    ].map((item) => item.href);
    expect(shown.sort()).toEqual([...everyPage].sort());
  });

  it('keeps the classic permissions, and drops a section left empty by them', () => {
    const navigation = getJobberNavigation((permission) => permission === 'inspections:read');

    expect(navigation.sidebar.flat().map((item) => item.href)).toEqual([
      '/schedule',
      '/inspections',
      '/lease-schedule',
      '/timesheet',
    ]);
    // No grant behind the gear at all, so nothing is listed there.
    expect(navigation.settings).toEqual([]);
  });

  it('calls the dashboard Home, as Jobber does, and keeps every other name', () => {
    const titles = getJobberNavigation(() => true).sidebar.flat().map((item) => item.title);
    expect(titles[0]).toBe('Home');
    expect(titles).toContain('Inspections');
    expect(titles).toContain('Properties');
  });

  it('offers to create each sidebar type, through the ordinary create form', () => {
    expect(JOBBER_CREATE_TYPES.map((entry) => entry.href)).toEqual([
      '/inspections/new?type=MOVE_IN',
      '/inspections/new?type=OCCUPIED',
      '/inspections/new?type=BACK_TO_MARKET',
      '/inspections/new?type=MOVE_OUT',
      '/inspections/new?type=HVAC',
    ]);
  });
});

describe('parseConsoleShell', () => {
  it('reads the two shells and treats anything else as classic', () => {
    expect(parseConsoleShell('jobber')).toBe('jobber');
    expect(parseConsoleShell('classic')).toBe('classic');
    expect(parseConsoleShell(undefined)).toBe('classic');
    expect(parseConsoleShell('JOBBER')).toBe('classic');
  });
});
