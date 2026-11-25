import type { JobberDayComparison, JobberDayRow } from '@texasrenters/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ScheduleCalendar, type ScheduleCalendarState } from './schedule-calendar';

/**
 * The Schedule's calendar, laid out as Jobber's (the office, 2026-11-04: "we
 * want the features for familiarity"). These hold it to what Jobber's does --
 * Unassigned first on a day, weeks from Sunday, a visit's popover -- and to
 * what it must not do: change anything, or read more than it shows.
 */

const asked = vi.hoisted(() => ({ dates: [] as string[], days: {} as Record<string, unknown> }));
const lists = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock('@/lib/queries', () => ({
  jobberDayQuery: (date: string) => ({
    queryKey: ['jobber-day', date],
    queryFn: async () => {
      asked.dates.push(date);
      return asked.days[date] ?? { date, rows: [], technicians: [] };
    },
  }),
  useUnassignedCount: () => ({ data: 3 }),
  useInspections: (query: unknown) => {
    lists.calls.push(query);
    return {
      isError: false,
      isLoading: false,
      data: {
        items: [
          {
            id: 'insp-u',
            inspectionType: 'MOVE_OUT',
            scheduledAt: '2026-11-02T00:00:00.000Z',
            propertywareBuilding: { name: '5 Unassigned Way' },
            propertywareUnit: null,
          },
        ],
      },
    };
  },
}));
vi.mock('@/lib/auth', () => ({ usePermissions: () => ({ has: () => true }) }));
// The New job panel is the shell's; here only whether it is asked to open, and with what.
const openNewJob = vi.hoisted(() => vi.fn());
vi.mock('@/components/jobs/new-job-context', () => ({ useNewJob: () => openNewJob }));
vi.mock('./schedule-map', () => ({ ScheduleMap: ({ date }: { date: string }) => <div>map of {date}</div> }));

function row(over: Partial<JobberDayRow> = {}): JobberDayRow {
  return {
    key: over.inspectionId ?? `jobber:${over.jobberVisitId ?? 'v'}`,
    inspectionId: 'insp-1',
    jobberVisitId: null,
    property: '12 Elm Ct',
    inspectionType: 'OCCUPIED',
    status: 'SCHEDULED',
    technicianId: 'tech-a',
    here: { startAt: null, technician: 'Ada Lane' },
    jobber: null,
    state: 'MATCHES',
    differences: [],
    waitingToSend: false,
    importNote: null,
    ...over,
  };
}

function day(date: string, rows: JobberDayRow[]): JobberDayComparison {
  return {
    date,
    syncedAt: null,
    pushesEnabled: true,
    actionsEnabled: false,
    rows,
    technicians: [
      { technicianId: 'tech-z', name: 'Zoe Park', here: 1, inJobber: 1, done: 0, differences: 0 },
      { technicianId: null, name: 'Nobody here', here: 1, inJobber: 1, done: 0, differences: 0 },
      { technicianId: 'tech-a', name: 'Ada Lane', here: 1, inJobber: 1, done: 0, differences: 0 },
    ],
    otherWork: [],
  } as unknown as JobberDayComparison;
}

const onChange = vi.fn();

function mount(state: Partial<ScheduleCalendarState> = {}) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ScheduleCalendar
        modeSwitch={<span>mode switch</span>}
        onChange={onChange}
        state={{ anchor: '2026-11-04', view: 'day', map: false, ...state }}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  asked.dates = [];
  lists.calls = [];
  onChange.mockReset();
  asked.days = {
    '2026-11-04': day('2026-11-04', [
      row({ inspectionId: 'insp-ada', property: '12 Elm Ct' }),
      row({ inspectionId: 'insp-zoe', property: '9 Oak Ln', technicianId: 'tech-z', here: { startAt: null, technician: 'Zoe Park' } }),
      row({ inspectionId: 'insp-none', property: '3 Pine Rd', technicianId: null, here: { startAt: null, technician: null } }),
      row({
        inspectionId: null,
        jobberVisitId: 'v-9',
        key: 'jobber:v-9',
        property: '40 Jobber St',
        technicianId: 'tech-a',
        status: null,
        here: null,
        jobber: { startAt: null, technician: 'Ada Lane', title: '40 Jobber St - Zone 2', completed: false },
        state: 'ONLY_IN_JOBBER',
        differences: ['Only in Jobber'],
      }),
    ]),
  };
});

const precedes = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe('the Day view', () => {
  it('has a column per technician, Unassigned first, then by name', async () => {
    mount();
    const ada = await screen.findByText('Ada Lane');
    const zoe = screen.getByText('Zoe Park');
    const unassigned = screen.getAllByText('Unassigned').find((element) => element.tagName === 'SPAN')!;
    expect(precedes(unassigned, ada)).toBe(true);
    expect(precedes(ada, zoe)).toBe(true);
  });

  it('opens a visit as Jobber’s popover does, with the way to its inspection and nothing that changes it', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /12 Elm Ct/ }));

    const popover = await screen.findByRole('dialog');
    expect(within(popover).getByText('Occupied · To do')).toBeTruthy();
    expect(within(popover).getByText('Anytime', { exact: false })).toBeTruthy();
    expect(within(popover).getByRole('link', { name: 'Open inspection' }).getAttribute('href')).toBe('/inspections/insp-ada');
    // Jobber's popover has a Completed box; this one changes nothing.
    expect(within(popover).queryByRole('checkbox')).toBeNull();
  });

  it('sends a visit only Jobber has to the comparison, where it can become an inspection', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /40 Jobber St/ }));

    const popover = await screen.findByRole('dialog');
    expect(within(popover).getAllByText('Only in Jobber').length).toBeGreaterThan(0);
    expect(within(popover).getByRole('link', { name: 'See it against Jobber' }).getAttribute('href')).toBe(
      '/schedule?mode=compare&view=day&date=2026-11-04',
    );
  });

  it('drops a technician’s column when the Team pill unticks them', async () => {
    mount();
    await screen.findByText('Zoe Park');
    fireEvent.click(screen.getByRole('button', { name: 'Team: All' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Zoe Park' }));

    expect(screen.queryByRole('button', { name: /9 Oak Ln/ })).toBeNull();
    expect(screen.getByRole('button', { name: /12 Elm Ct/ })).toBeTruthy();
  });
});

describe('Jobber work that is not an inspection (2026-11-25)', () => {
  const omega = {
    jobberVisitId: 'v-omega',
    title: '3301 Omega B - Zone 1 - General Maintenance - WO#44805',
    property: '3301 Omega B',
    technician: 'Ada Lane',
    technicianId: 'tech-a',
    startAt: null,
    completed: false,
    reason: 'Not named as an inspection',
  };

  beforeEach(() => {
    asked.days['2026-11-04'] = { ...day('2026-11-04', [row({ inspectionId: 'insp-ada', property: '12 Elm Ct' })]), otherWork: [omega] };
  });

  it("is on the calendar under its technician, named as Jobber names it, and counted in the day's visits", async () => {
    mount({ view: 'week' });

    const card = await screen.findByRole('button', { name: /General Maintenance - WO#44805/ });
    expect(card).toBeTruthy();
    expect(screen.getByText('2 visits')).toBeTruthy();
  });

  it("shows what Jobber's popup does: the job, its Details, the whole address and the team (2026-11-25)", async () => {
    asked.days['2026-11-04'] = {
      ...day('2026-11-04', []),
      otherWork: [{ ...omega, jobNumber: '20907', details: 'Hose bib on the left side of house needs to be replaced.', address: '74 San Simeon Dr, Manvel, TX 77578-3287' }],
    };
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /General Maintenance - WO#44805/ }));

    const popover = await screen.findByRole('dialog');
    expect(within(popover).getByText('Job #20907')).toBeTruthy();
    expect(within(popover).getByText('Hose bib on the left side of house needs to be replaced.')).toBeTruthy();
    expect(within(popover).getByText('74 San Simeon Dr, Manvel, TX 77578-3287')).toBeTruthy();
    expect(within(popover).getByText('Ada Lane')).toBeTruthy();
  });

  it('opens as Jobber work, with nothing to open here and nothing that changes it', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /General Maintenance - WO#44805/ }));

    const popover = await screen.findByRole('dialog');
    // Laid out as Jobber's own popup: Visit, its Completed box, Start.
    expect(within(popover).getByText('Visit')).toBeTruthy();
    expect(within(popover).getByText('Not completed')).toBeTruthy();
    expect(within(popover).getByText('Start')).toBeTruthy();
    expect(within(popover).queryByRole('link', { name: 'Open inspection' })).toBeNull();
    expect(within(popover).queryByRole('checkbox')).toBeNull();
  });
});

describe("an inspection's name on the calendar (2026-11-25)", () => {
  it("is Jobber's title for its visit, word for word, with the property under it in the popup", async () => {
    asked.days['2026-11-04'] = day('2026-11-04', [
      row({
        inspectionId: 'insp-elm',
        property: '12 Elm Ct',
        jobberVisitId: 'v-elm',
        jobber: { startAt: null, technician: 'Ada Lane', title: '12 Elm Ct - Zone 3 - Occupied Inspection', completed: false },
      }),
      row({ inspectionId: 'insp-oak', property: '9 Oak Ln' }),
    ]);
    mount();

    fireEvent.click(await screen.findByRole('button', { name: /12 Elm Ct - Zone 3 - Occupied Inspection/ }));
    const popover = await screen.findByRole('dialog');
    expect(within(popover).getByText('12 Elm Ct')).toBeTruthy();
    // No Jobber visit to name it: the property, as before.
    expect(screen.getByRole('button', { name: /9 Oak Ln/ })).toBeTruthy();
  });
});

describe('a visit with two people on it (2026-11-25)', () => {
  it("is in both their columns on the Day view, as on Jobber's calendar", async () => {
    asked.days['2026-11-04'] = day('2026-11-04', [
      row({ inspectionId: 'insp-pair', property: '5826 Wilkins Ln', technicianId: 'tech-a', technicianIds: ['tech-a', 'tech-z'] }),
    ]);
    mount();

    expect(await screen.findAllByRole('button', { name: /5826 Wilkins Ln/ })).toHaveLength(2);
  });
});

describe('the Week view', () => {
  it('runs Sunday to Saturday, and a day’s head opens its Day view', async () => {
    mount({ view: 'week' });
    const heads = await screen.findAllByRole('button', { name: /^Open .* as a day$/ });
    expect(heads.map((head) => head.textContent)).toEqual(['1 Sun', '2 Mon', '3 Tue', '4 Wed', '5 Thu', '6 Fri', '7 Sat']);

    fireEvent.click(heads[3]);
    expect(onChange).toHaveBeenCalledWith({ view: 'day', anchor: '2026-11-04' });
  });

  it('reads the seven days it shows', async () => {
    mount({ view: 'week' });
    await screen.findAllByRole('button', { name: /^Open .* as a day$/ });
    expect([...new Set(asked.dates)].sort()).toEqual([
      '2026-11-01',
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
      '2026-11-05',
      '2026-11-06',
      '2026-11-07',
    ]);
  });
});

describe('the Month view', () => {
  it('reads only the month’s own days, not the grey ones either side', async () => {
    mount({ anchor: '2026-11-18', view: 'month' });
    await screen.findAllByRole('button', { name: /^Open .* as a day$/ });
    const dates = [...new Set(asked.dates)];
    expect(dates).toHaveLength(30);
    expect(dates.every((date) => date.startsWith('2026-11-'))).toBe(true);
  });
});

describe('the toolbar', () => {
  it('names the month, and steps by the view', async () => {
    mount({ view: 'week' });
    expect(screen.getByRole('button', { name: 'November 2026, choose a day' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next week' }));
    expect(onChange).toHaveBeenCalledWith({ anchor: '2026-11-11' });
  });

  it('turns the map on and off', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Map' }));
    expect(onChange).toHaveBeenCalledWith({ map: true });
  });

  it('shows the map of the day beside the calendar while it is on', () => {
    mount({ map: true });
    expect(screen.getByText('map of 2026-11-04')).toBeTruthy();
  });
});

/**
 * With the map on, a day is picked for the map and the calendar stays (the
 * office, 2026-11-05: "if we click november 2 it won't click it and it can't be
 * shown in the map cause we can't click it").
 */
describe('a day picked for the map', () => {
  it("shows the week's day on the map from its head, keeping the week", async () => {
    mount({ view: 'week', map: true });
    const heads = await screen.findAllByRole('button', { name: /^Show .* on the map$/ });
    expect(heads.map((head) => head.textContent)).toEqual(['1 Sun', '2 Mon', '3 Tue', '4 Wed', '5 Thu', '6 Fri', '7 Sat']);
    // The day on the map is the one marked.
    expect(heads.map((head) => head.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'false', 'true', 'false', 'false', 'false']);

    fireEvent.click(heads[1]);
    expect(onChange).toHaveBeenCalledWith({ anchor: '2026-11-02' });
    expect(onChange).not.toHaveBeenCalledWith(expect.objectContaining({ view: 'day' }));
  });

  it("picks a day from anywhere on its column, but a visit still opens the visit", async () => {
    mount({ view: 'week', map: true });
    await screen.findAllByRole('button', { name: /^Show .* on the map$/ });
    // The Anytime row: its label, then Sunday to Saturday.
    const anytime = screen.getByText('Anytime').parentElement!;
    fireEvent.click(anytime.children[2]!);
    expect(onChange).toHaveBeenCalledWith({ anchor: '2026-11-02' });

    onChange.mockReset();
    fireEvent.click(await screen.findByRole('button', { name: /12 Elm Ct/ }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("picks the month's day for the map, while +more still opens the whole day", async () => {
    asked.days['2026-11-18'] = day(
      '2026-11-18',
      ['a', 'b', 'c', 'd', 'e'].map((id) => row({ inspectionId: `insp-${id}`, property: `${id} Example Rd` })),
    );
    mount({ anchor: '2026-11-04', view: 'month', map: true });

    fireEvent.click(await screen.findByRole('button', { name: 'Show Wed 18 on the map' }));
    expect(onChange).toHaveBeenLastCalledWith({ anchor: '2026-11-18' });

    fireEvent.click(await screen.findByRole('button', { name: '+2 more' }));
    expect(onChange).toHaveBeenLastCalledWith({ view: 'day', anchor: '2026-11-18' });
  });

  it('opens the Day view from a head while the map is off, as Jobber does', async () => {
    mount({ view: 'week', map: false });
    fireEvent.click((await screen.findAllByRole('button', { name: /^Open .* as a day$/ }))[1]!);
    expect(onChange).toHaveBeenCalledWith({ view: 'day', anchor: '2026-11-02' });
  });
});

describe('the Unassigned drawer', () => {
  it('reads the list only once it is opened, oldest first', async () => {
    mount();
    expect(lists.calls).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: /Unassigned\s*3/ }));
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByRole('link', { name: /5 Unassigned Way/ }).getAttribute('href')).toBe('/inspections/insp-u');
    expect(lists.calls[0]).toEqual({ unassignedOnly: true, page: 1, pageSize: 50, scheduledOrder: 'asc' });
  });
});

describe('who and when', () => {
  it('names a visit’s technician from the day, when the row itself carries no names', async () => {
    asked.days['2026-11-04'] = day('2026-11-04', [
      row({ inspectionId: 'insp-quiet', property: '7 Quiet Way', technicianId: 'tech-a', here: { startAt: null, technician: null } }),
    ]);
    mount({ view: 'week' });
    fireEvent.click(await screen.findByRole('button', { name: /7 Quiet Way/ }));

    const popover = await screen.findByRole('dialog');
    expect(within(popover).getByText('Ada Lane')).toBeTruthy();
    expect(within(popover).queryByText('Unassigned')).toBeNull();
  });

  it('puts a visit with a time on the hours, at its Texas time', async () => {
    asked.days['2026-11-04'] = day('2026-11-04', [
      // 14:00 UTC is 8:00 AM in Texas on 4 November (CST, UTC-6).
      row({ inspectionId: 'insp-timed', property: '8 Clock St', here: { startAt: '2026-11-04T14:00:00.000Z', technician: 'Ada Lane' } }),
    ]);
    mount();
    const visit = await screen.findByRole('button', { name: /8 Clock St/ });
    expect(visit.textContent).toContain('8:00AM');
    // On the grid, which starts at 8 AM: the top of the first hour, plus its inset.
    expect(visit.style.top).toBe('2px');
    expect(screen.getByText('8 AM')).toBeTruthy();
  });
});

describe('making a job from the Schedule (2026-11-20)', () => {
  beforeEach(() => openNewJob.mockClear());

  it('opens the New job panel on the day shown from the toolbar', async () => {
    mount({ view: 'day' });
    await screen.findByText('12 Elm Ct');
    fireEvent.click(screen.getByRole('button', { name: 'New job' }));

    expect(openNewJob).toHaveBeenCalledWith({ date: '2026-11-04', from: 'from the Schedule' });
  });

  it('offers a new job for the technician whose column is right-clicked on the Day view', async () => {
    mount({ view: 'day' });
    fireEvent.contextMenu(await screen.findByText('Ada Lane', { selector: 'span.truncate' }));

    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText('Wednesday, November 4')).toBeTruthy();
    // The Day view is the day already, so it does not offer to open it.
    expect(within(menu).queryByRole('menuitem', { name: 'Open the day' })).toBeNull();
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'New job for Ada Lane' }));
    expect(openNewJob).toHaveBeenCalledWith({ date: '2026-11-04', technicianId: 'tech-a', from: 'from the Schedule' });
  });

  it('offers a new job on a day of the month, and the day itself', async () => {
    mount({ view: 'month' });
    fireEvent.contextMenu(await screen.findByRole('button', { name: 'Open Wed 4 as a day' }));

    const menu = await screen.findByRole('menu');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'New job on this day' }));
    expect(openNewJob).toHaveBeenCalledWith({ date: '2026-11-04', from: 'from the Schedule' });
  });

  it('opens the day, or shows it on the map, from the week', async () => {
    mount({ view: 'week' });
    fireEvent.contextMenu(await screen.findByRole('button', { name: 'Open Wed 4 as a day' }));
    fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Open the day' }));
    expect(onChange).toHaveBeenCalledWith({ view: 'day', anchor: '2026-11-04' });

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Open Thu 5 as a day' }));
    fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Show the day on the map' }));
    expect(onChange).toHaveBeenCalledWith({ map: true, anchor: '2026-11-05' });
  });

  it("draws a job's inspections as one card, with the other kinds counted and named", async () => {
    const job = { id: 'job-1', number: 'J-00042', title: 'Occupied + HVAC', kinds: ['HVAC', 'OCCUPIED'] };
    asked.days['2026-11-04'] = day('2026-11-04', [
      row({ inspectionId: 'insp-occ', inspectionType: 'OCCUPIED', property: '12 Elm Ct', job }),
      row({ inspectionId: 'insp-hvac', inspectionType: 'HVAC', property: '12 Elm Ct', job }),
    ]);
    mount({ view: 'day' });

    const cards = await screen.findAllByRole('button', { name: /12 Elm Ct/ });
    expect(cards).toHaveLength(1);
    expect(within(cards[0]!).getByText('+1')).toBeTruthy();
    fireEvent.click(cards[0]!);
    expect(await screen.findByText('Job J-00042 · To do')).toBeTruthy();
    expect(screen.getByText('HVAC, Occupied')).toBeTruthy();
    // The lead's inspection opens.
    expect(screen.getByRole('link', { name: 'Open inspection' }).getAttribute('href')).toBe('/inspections/insp-hvac');
    expect(screen.getByRole('link', { name: 'Open job' }).getAttribute('href')).toBe('/jobs/job-1');
  });
});
