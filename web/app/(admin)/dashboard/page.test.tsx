import type { JobberDayComparison, JobberDayRow } from '@texasrenters/shared';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ConsoleShellProvider } from '@/components/console-shell-context';
import { businessToday } from '@/lib/clock';
import { overdueCutoff } from '@/lib/home-workflow';

import DashboardPage from './page';

/**
 * The dashboard, two ways: the classic figures and panels, and Jobber's Home in
 * the Jobber-style shell (the office, 2026-11-04: "we want the features for
 * familiarity"). Home must keep every panel the dashboard had, and ask for
 * nothing an account may not read.
 */

const granted = vi.hoisted(() => ({ keys: new Set<string>() }));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ profile: { displayName: 'Ada Lane', email: 'ada@example.test', memberships: [] } }),
  usePermissions: () => ({ has: (key: string) => granted.keys.has(key) }),
}));

const calls = vi.hoisted(() => ({
  inspections: [] as [unknown, boolean][],
  reschedules: [] as [string, boolean][],
  reschedulesFail: false,
}));

function row(over: Partial<JobberDayRow>): JobberDayRow {
  return {
    key: over.inspectionId ?? 'jobber:1',
    inspectionId: 'insp-1',
    jobberVisitId: null,
    property: '1 Elm Ct',
    inspectionType: 'OCCUPIED',
    status: 'SCHEDULED',
    technicianId: 'tech-a',
    here: { startAt: null, technician: null },
    jobber: null,
    state: 'MATCHES',
    differences: [],
    waitingToSend: false,
    importNote: null,
    ...over,
  };
}

const day = {
  date: '2026-11-03',
  syncedAt: null,
  pushesEnabled: true,
  actionsEnabled: false,
  otherWork: [],
  technicians: [
    { technicianId: 'tech-a', name: 'Moses Ruiz', here: 2, inJobber: 2, done: 1, differences: 0 },
    { technicianId: null, name: 'Nobody here', here: 1, inJobber: 1, done: 0, differences: 0 },
  ],
  rows: [
    row({ inspectionId: 'insp-active', property: '10 Busy St', status: 'IN_PROGRESS' }),
    row({ inspectionId: 'insp-left', property: '20 Later Rd' }),
    row({ inspectionId: 'insp-done', property: '30 Done Ln', status: 'COMPLETED' }),
    row({ inspectionId: 'insp-gone', property: '40 Gone Way', status: 'CANCELLED' }),
  ],
} as unknown as JobberDayComparison;

vi.mock('@/lib/queries', () => ({
  useDashboard: () => ({
    isError: false,
    isLoading: false,
    data: {
      metrics: {
        portfolios: 1,
        properties: 2,
        units: 3,
        leases: 4,
        unassigned: 5,
        assigned: 7,
        inProgress: 1,
        completed: 99,
        technicians: 6,
      },
      lastSync: null,
      recentErrors: [],
      providerReadiness: [],
    },
  }),
  useJobberDay: () => ({ data: day, isLoading: false }),
  useInspections: (query: { status?: string }, enabled = true) => {
    calls.inspections.push([query, enabled]);
    if (query.status === 'FOLLOW_UP') return { data: { total: 3, items: [] } };
    return {
      data: {
        total: 12,
        items: [
          {
            id: 'insp-late',
            inspectionType: 'MOVE_OUT',
            scheduledAt: '2026-10-30T00:00:00.000Z',
            propertywareBuilding: { name: '9 Late Ave' },
            propertywareUnit: null,
            assignments: [{ isCurrent: true, technician: { displayName: 'Moses Ruiz' } }],
          },
        ],
      },
    };
  },
}));
vi.mock('@/lib/reschedule-queries', () => ({
  useRescheduleRequests: (filter: string, enabled = true) => {
    calls.reschedules.push([filter, enabled]);
    if (calls.reschedulesFail) return { isError: true, data: undefined };
    return {
      data: {
        items: [{ kind: 'NO_ACCESS' }, { kind: 'NO_ACCESS' }, { kind: 'BEFORE_VISIT' }],
        counts: { open: 3, sending: 0 },
      },
    };
  },
}));
// The comparison panel has its own tests; here it only has to be present.
vi.mock('@/components/jobber-day-panel', () => ({ JobberDayPanel: () => <section>Today against Jobber</section> }));

const mount = (shell: 'classic' | 'jobber') =>
  render(
    <ConsoleShellProvider shell={shell}>
      <DashboardPage />
    </ConsoleShellProvider>,
  );

const card = (title: string) => screen.getByRole('link', { name: new RegExp(`^${title}`) });

beforeEach(() => {
  granted.keys = new Set(['dashboard:read', 'inspections:read', 'inspections:manage']);
  calls.inspections = [];
  calls.reschedules = [];
  calls.reschedulesFail = false;
});

describe('the classic dashboard', () => {
  it('keeps its figures and panels', () => {
    mount('classic');
    expect(screen.getByRole('heading', { name: "Today's operations" })).toBeTruthy();
    expect(screen.getByText('Reach nobody until assigned')).toBeTruthy();
    expect(screen.getByText('Needs a person')).toBeTruthy();
    // Home's extra reads are Home's alone.
    expect(calls.inspections).toHaveLength(0);
    expect(calls.reschedules).toHaveLength(0);
  });
});

describe('Home in the Jobber-style shell', () => {
  it('greets the reader by name', () => {
    mount('jobber');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/^Good (morning|afternoon|evening), Ada$/);
  });

  it('lays the work out as Jobber’s Workflow cards, each a link to its list', () => {
    mount('jobber');

    expect(card('Reschedules').getAttribute('href')).toBe('/reschedules');
    expect(within(card('Reschedules')).getByText('To answer')).toBeTruthy();
    expect(within(card('Reschedules')).getByText('Could not get in').nextSibling?.textContent).toBe('2');

    expect(card('Upcoming').getAttribute('href')).toBe('/inspections?tech=unassigned&day=all');
    expect(within(card('Upcoming')).getByText('5')).toBeTruthy();
    // Booked today leaves the cancelled visit out.
    expect(within(card('Upcoming')).getByText('Booked today').nextSibling?.textContent).toBe('3');

    expect(card('Today').getAttribute('href')).toBe('/schedule?view=day');
    expect(within(card('Today')).getByText('Done today').nextSibling?.textContent).toBe('1');

    expect(card('Follow-up').getAttribute('href')).toBe('/inspections?status=FOLLOW_UP&day=all');
    expect(within(card('Follow-up')).getByText('3')).toBeTruthy();
  });

  it('shows a dash, not a figure loading for ever, when a card cannot be read', () => {
    calls.reschedulesFail = true;
    mount('jobber');
    expect(within(card('Reschedules')).getAllByText('—').length).toBeGreaterThan(1);
  });

  it('does not ask about reschedules for an account that may not answer them', () => {
    granted.keys = new Set(['dashboard:read', 'inspections:read']);
    mount('jobber');
    expect(screen.queryByRole('link', { name: /^Reschedules/ })).toBeNull();
    expect(calls.reschedules.every(([, enabled]) => enabled === false)).toBe(true);
  });

  it('asks for overdue visits up to yesterday, sent as yesterday’s UTC midnight', () => {
    mount('jobber');
    const overdue = calls.inspections.find(([query]) => (query as { status?: string }).status === 'SCHEDULED');
    expect(overdue?.[0]).toMatchObject({ scheduledTo: overdueCutoff(businessToday()), scheduledOrder: 'desc' });
  });

  it('groups today’s visits as Jobber does, overdue first', () => {
    mount('jobber');
    const today = screen.getByRole('region', { name: "Today's visits" });

    const headings = within(today).getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent);
    expect(headings).toEqual(['12 Overdue', '1 In progress', '1 Remaining', '1 Done']);
    expect(within(today).getByRole('link', { name: /9 Late Ave/ }).getAttribute('href')).toBe('/inspections/insp-late');
    expect(within(today).getByRole('link', { name: /11 more overdue/ }).getAttribute('href')).toBe(
      '/inspections?status=SCHEDULED&day=all',
    );
    expect(within(today).queryByText('40 Gone Way')).toBeNull();
  });

  it('shows the same day by technician, Unassigned first', () => {
    mount('jobber');
    const today = screen.getByRole('region', { name: "Today's visits" });
    fireEvent.click(within(today).getByRole('button', { name: 'Employee' }));

    const people = within(today).getAllByRole('listitem').map((item) => item.textContent);
    expect(people[0]).toContain('Unassigned');
    expect(people[1]).toContain('Moses Ruiz');
    expect(people[1]).toContain('1 of 2 done');
  });

  it('keeps every panel the classic dashboard has', () => {
    mount('jobber');
    expect(screen.getByText('Today against Jobber')).toBeTruthy();
    expect(screen.getByText('Needs a person')).toBeTruthy();
    expect(screen.getByText('Systems')).toBeTruthy();
    expect(screen.getByText('Portfolio · Propertyware')).toBeTruthy();
  });
});
