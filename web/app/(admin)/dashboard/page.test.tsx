import type { AdminDashboardOutlook, JobberDayComparison, JobberDayRow } from '@texasrenters/shared';
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
  outlook: [] as boolean[],
  outlookFails: false,
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

// Tuesday, November 17: six weeks from the Monday before it. Invented counts.
const outlookDays = Array.from({ length: 42 }, (_, index) => {
  const date = new Date(Date.UTC(2026, 10, 16 + index)).toISOString().slice(0, 10);
  const weekend = [5, 6].includes(index % 7);
  return {
    date,
    booked: { OCCUPIED: weekend ? 0 : 14, MOVE_OUT: weekend ? 0 : 6, MOVE_IN: 0, HVAC: 0, OTHER: 0 },
    done: 0,
    planned: date === '2026-12-01' ? 3 : 0,
  };
});
const outlook: AdminDashboardOutlook = {
  today: '2026-11-17',
  days: outlookDays,
  todayCounts: { total: 20, done: 9, inProgress: 4 },
  next7: 208,
  previous7: 196,
  earliestUnassignedOn: '2026-11-19',
  loadDays: ['2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-23'],
  technicianLoad: [
    { technicianId: 'tech-a', name: 'Moses Ruiz', visits: 34 },
    { technicianId: null, name: 'Unassigned', visits: 5 },
  ],
  quarters: [
    {
      planId: 'plan-q4',
      label: 'Q4 2026',
      phase: 'CURRENT',
      planStatus: 'PUBLISHED',
      startsOn: '2026-10-01',
      endsOn: '2026-12-31',
      total: 600,
      done: 300,
      booked: 200,
      planned: 80,
      notScheduled: 20,
      dueByToday: 280,
      plan: [{ date: '2026-12-18', count: 580 }],
      progress: [
        { date: '2026-10-27', count: 120 },
        { date: '2026-11-17', count: 300 },
      ],
    },
    {
      planId: 'plan-q1',
      label: 'Q1 2027',
      phase: 'NEXT',
      planStatus: 'DRAFT',
      startsOn: '2027-01-01',
      endsOn: '2027-03-31',
      total: 610,
      done: 0,
      booked: 0,
      planned: 540,
      notScheduled: 70,
      dueByToday: 0,
      plan: [],
      progress: [],
    },
  ],
};

vi.mock('@/lib/queries', () => ({
  useDashboardOutlook: (enabled = true) => {
    calls.outlook.push(enabled);
    if (!enabled) return { data: undefined, isError: false };
    return calls.outlookFails
      ? { data: undefined, isError: true, error: new Error('The outlook could not be read.'), refetch: vi.fn() }
      : { data: outlook, isError: false };
  },
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
// The New job panel is the shell's; here only whether it is asked to open, and with what.
const openNewJob = vi.hoisted(() => vi.fn());
vi.mock('@/components/jobs/new-job-context', () => ({ useNewJob: () => openNewJob }));
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
  calls.outlook = [];
  calls.outlookFails = false;
  calls.inspections = [];
  calls.reschedules = [];
  calls.reschedulesFail = false;
});

describe('the classic dashboard', () => {
  it('opens on four figures: today, the queue, the week ahead and the quarter', () => {
    mount('classic');
    expect(screen.getByRole('heading', { level: 1, name: 'Operations' })).toBeTruthy();
    expect(screen.getByText('9 done · 4 in the field · 7 to go')).toBeTruthy();
    expect(screen.getByText('Earliest is Thursday, November 19')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Assign technicians' }).getAttribute('href')).toBe(
      '/inspections?tech=unassigned&day=all',
    );
    expect(screen.getByText('12 more than the last 7 days')).toBeTruthy();
    expect(screen.getByText('TBP · Q4 2026')).toBeTruthy();
    expect(screen.getByText('20 ahead of the plan · 44 days left')).toBeTruthy();
    // Home's extra reads are Home's alone.
    expect(calls.inspections).toHaveLength(0);
    expect(calls.reschedules).toHaveLength(0);
  });

  it('has one filled button, which opens the New job panel', () => {
    mount('classic');
    openNewJob.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'New job' }));
    expect(openNewJob).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('link', { name: "Today's inspections" }).getAttribute('href')).toBe('/inspections');
  });

  it('draws the schedule ahead, each day a link to that day', () => {
    mount('classic');
    const chart = screen.getByRole('region', { name: 'Schedule ahead' });
    // Six weeks of Monday to Friday: nothing is booked on a weekend.
    expect(within(chart).getAllByRole('link', { name: /visits|Nothing booked/ })).toHaveLength(30);
    const today = within(chart).getByRole('link', { name: /^Tuesday, November 17 \(today\)/ });
    expect(today.getAttribute('href')).toBe('/schedule?date=2026-11-17');
    expect(today.getAttribute('aria-label')).toContain('20 visits: 14 occupied (TBP), 6 move-out');
    expect(within(chart).getByText('Planned, not booked')).toBeTruthy();

    fireEvent.click(within(chart).getByRole('button', { name: '2 weeks' }));
    expect(within(chart).getAllByRole('link', { name: /visits|Nothing booked/ })).toHaveLength(10);
  });

  it('reads a day out when its column is pointed at', () => {
    mount('classic');
    const chart = screen.getByRole('region', { name: 'Schedule ahead' });
    fireEvent.mouseEnter(within(chart).getByRole('link', { name: /^Tuesday, December 1:/ }));
    expect(within(chart).getByText('Tue, Dec 1')).toBeTruthy();
    expect(within(chart).getByText(/23 visits: 14 occupied \(TBP\), 6 move-out, 3 planned, not booked/)).toBeTruthy();
  });

  it('shows each quarter’s plan and this quarter’s pace', () => {
    mount('classic');
    const quarters = screen.getByRole('region', { name: 'TBP by quarter' });
    expect(within(quarters).getByText('300 done · 200 booked · 80 planned, not booked · 20 not scheduled')).toBeTruthy();
    expect(within(quarters).getByText('Draft plan')).toBeTruthy();
    expect(within(quarters).getByText(/on course to finish Tuesday, December 22/)).toBeTruthy();
    expect(
      within(quarters).getByRole('img', { name: /^Q4 2026: 300 of 600 done, 20 ahead of the plan/ }),
    ).toBeTruthy();
  });

  it('shows who holds the next five working days, with nobody apart', () => {
    mount('classic');
    const load = screen.getByRole('region', { name: 'Technician load' });
    expect(within(load).getByText('Visits booked, Tue, Nov 17 to Mon, Nov 23')).toBeTruthy();
    const rows = within(load).getAllByRole('listitem').map((item) => item.textContent);
    expect(rows).toEqual(['Moses Ruiz34', 'Unassigned5']);
  });

  it('keeps what needs a person, and says the systems in one line', () => {
    mount('classic');
    expect(screen.getByText('Needs a person')).toBeTruthy();
    expect(screen.getByText('5 inspections have no technician')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'All 0 systems ready' }).getAttribute('href')).toBe('/integrations/providers');
    expect(screen.getByText('Today against Jobber')).toBeTruthy();
    expect(screen.getByText('Portfolio · Propertyware')).toBeTruthy();
  });

  it('keeps the figures and the queue when the charts cannot be read', () => {
    calls.outlookFails = true;
    mount('classic');
    expect(screen.getByText('The outlook could not be read.')).toBeTruthy();
    expect(screen.getByText('5 inspections have no technician')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'TBP by quarter' })).toBeNull();
  });
});

describe('Home in the Jobber-style shell', () => {
  it('draws the same charts as the classic dashboard, the schedule ahead of today’s visits', () => {
    mount('jobber');
    expect(calls.outlook.every((enabled) => enabled !== false)).toBe(true);
    const chart = screen.getByRole('region', { name: 'Schedule ahead' });
    expect(within(chart).getAllByRole('link', { name: /visits|Nothing booked/ })).toHaveLength(30);
    expect(screen.getByRole('region', { name: 'TBP by quarter' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Technician load' })).toBeTruthy();
    // Seen without scrolling past a long day: the chart comes before the visits.
    const visits = screen.getByRole('region', { name: "Today's visits" });
    expect(chart.compareDocumentPosition(visits) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Jobber's Home keeps its own opening: no classic title, no four figures.
    expect(screen.queryByRole('heading', { level: 1, name: 'Operations' })).toBeNull();
    expect(screen.queryByText('TBP · Q4 2026')).toBeNull();
  });

  it('keeps the Workflow cards and the visits when the charts cannot be read', () => {
    calls.outlookFails = true;
    mount('jobber');
    expect(screen.getByText('The outlook could not be read.')).toBeTruthy();
    expect(card('Upcoming')).toBeTruthy();
    expect(screen.getByRole('region', { name: "Today's visits" })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'TBP by quarter' })).toBeNull();
  });

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
    expect(screen.getByRole('link', { name: 'All 0 systems ready' }).getAttribute('href')).toBe('/integrations/providers');
    expect(screen.getByText('Portfolio · Propertyware')).toBeTruthy();
  });
});
