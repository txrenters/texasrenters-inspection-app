import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { PlanDay, PlanRotation, PlanSettings } from '@/lib/planning-queries';

import {
  clampToCalendar,
  initialsOf,
  PlanCalendar,
  quarterCrew,
  quarterMonths,
  shortName,
  stepCursor,
  weekOf,
  type CalendarView,
} from './plan-calendar';

const Q4 = { year: 2026, quarter: 4 as const };

const SETTINGS: PlanSettings = {
  occupiedVisitMinutes: 20,
  hvacVisitMinutes: 20,
  maxOnSiteMinutes: 360,
  maxDriveMinutes: 90,
  minStopsPerDay: 9,
  maxStopsPerDay: 10,
  maxLegMinutes: 20,
  // The day after Thanksgiving, closed by the office on top of the US holidays.
  holidays: ['2026-11-27'],
  startsOn: null,
  crewTechnicianIds: [],
  jobberUnassigned: false,
};

const ROTATION: PlanRotation = {
  crew: [
    { technicianId: 'moses', displayName: 'Moses Rodriguez', hasHome: true },
    { technicianId: 'kevin', displayName: 'Kevin Granados', hasHome: true },
    { technicianId: 'emanuel', displayName: 'Emanuel Hall', hasHome: true },
  ],
  zones: ['1', '2', '3', '4'],
  outOfReach: ['5'],
};

const day = (id: string, date: string, technicianId: string, displayName: string, stopCount: number, zone: string) =>
  ({
    id,
    date: `${date}T00:00:00.000Z`,
    technicianId,
    technician: { id: technicianId, displayName },
    stopCount,
    onSiteMinutes: stopCount * 20,
    hvacStopCount: 2,
    totalDriveSeconds: null,
    totalDriveMeters: null,
    homeDriveSeconds: null,
    homeDriveMeters: null,
    originKind: 'HOME',
    durationSource: null,
    stops: Array.from({ length: stopCount }, (_, index) => ({
      id: `${id}-stop-${index + 1}`,
      sequence: index + 1,
      positionInDay: index + 1,
      inspectionType: index < 2 ? 'HVAC' : 'OCCUPIED',
      onSiteMinutes: 20,
      driveSecondsForecast: index ? 600 : null,
      zone,
      status: 'PLANNED',
      address: `${index + 1} ${id} St`,
      city: null,
      latitude: null,
      longitude: null,
    })),
  }) as unknown as PlanDay;

const DAYS = [
  day('kevin-oct-1', '2026-10-01', 'kevin', 'Kevin Granados', 9, '2'),
  day('moses-oct-1', '2026-10-01', 'moses', 'Moses Rodriguez', 10, '1'),
  day('emanuel-oct-2', '2026-10-02', 'emanuel', 'Emanuel Hall', 10, '3'),
  day('moses-oct-6', '2026-10-06', 'moses', 'Moses Rodriguez', 7, '2'),
];

const CREW = quarterCrew(DAYS, ROTATION);

/** A move-out a day is built around, booked on `scheduledOn` for `assignedTo`. */
const moveOut = (id: string, scheduledOn: string, assignedTo: string) => ({
  id,
  inspectionId: `move-out-${id}`,
  kind: 'MOVE_OUT',
  scheduledOn,
  cancelled: false,
  assignedTechnician: { id: assignedTo, displayName: assignedTo },
});

const calendar = (props: Partial<Parameters<typeof PlanCalendar>[0]> & { view?: CalendarView } = {}) =>
  render(<PlanCalendar crew={CREW} days={DAYS} onSelect={vi.fn()} quarter={Q4} settings={SETTINGS} {...props} />);

describe('the quarter as months of weekdays', () => {
  it('lays each month out Monday to Friday, blank where a week reaches outside it', () => {
    const months = quarterMonths(Q4);

    expect(months.map((month) => month.label)).toEqual(['October 2026', 'November 2026', 'December 2026']);
    // Thursday 1 October.
    expect(months[0]!.weeks[0]).toEqual([null, null, null, '2026-10-01', '2026-10-02']);
    // 1 November is a Sunday, so November's first week is the week after.
    expect(months[1]!.weeks[0]).toEqual(['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06']);
    expect(months[2]!.weeks.at(-1)).toEqual(['2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', null]);
  });

  /** The office (2026-09-19): "for the q4 we can start as early as september". */
  it('shows the days before the quarter of a plan that starts early, from its first day', () => {
    const months = quarterMonths(Q4, '2026-09-23');

    expect(months.map((month) => month.label)).toEqual(['September 2026', 'October 2026', 'November 2026', 'December 2026']);
    expect(months[0]!.weeks).toEqual([
      [null, null, '2026-09-23', '2026-09-24', '2026-09-25'],
      ['2026-09-28', '2026-09-29', '2026-09-30', null, null],
    ]);
    expect(quarterMonths(Q4, '2026-10-05').map((month) => month.label)).toEqual(['October 2026', 'November 2026', 'December 2026']);
  });
});

describe('moving through the quarter', () => {
  const months = quarterMonths(Q4);

  it('steps a day at a time over the weekend, a week at a time from Monday, and a month at a time from its first weekday', () => {
    expect(stepCursor('day', '2026-10-02', 1, months)).toBe('2026-10-05');
    expect(stepCursor('day', '2026-10-05', -1, months)).toBe('2026-10-02');
    expect(stepCursor('week', '2026-10-07', 1, months)).toBe('2026-10-12');
    // The quarter's first week starts on a Thursday.
    expect(stepCursor('week', '2026-10-07', -1, months)).toBe('2026-10-01');
    expect(stepCursor('month', '2026-10-21', 1, months)).toBe('2026-11-02');
  });

  it('never leaves the quarter', () => {
    expect(stepCursor('day', '2026-10-01', -1, months)).toBe('2026-10-01');
    expect(stepCursor('month', '2026-12-15', 1, months)).toBe('2026-12-15');
    expect(clampToCalendar('2026-08-03', months)).toBe('2026-10-01');
    expect(clampToCalendar('2027-01-04', months)).toBe('2026-12-31');
    // A Saturday is the Monday after.
    expect(clampToCalendar('2026-10-10', months)).toBe('2026-10-12');
  });

  it('knows the weekdays of a date’s week', () => {
    expect(weekOf('2026-10-08')).toEqual(['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09']);
  });
});

describe('who is out', () => {
  it('keeps the crew’s order, each with a colour and their totals', () => {
    expect(CREW.map(({ name, days, visits }) => ({ name, days, visits }))).toEqual([
      { name: 'Moses Rodriguez', days: 2, visits: 17 },
      { name: 'Kevin Granados', days: 1, visits: 9 },
      { name: 'Emanuel Hall', days: 1, visits: 10 },
    ]);
    expect(new Set(CREW.map((member) => member.colour)).size).toBe(3);
  });

  /** Found 2026-10-05: on a quarter sent out unassigned every chip read "Day". */
  it('names a day group by its number, not by the first word of "Day group"', () => {
    expect(shortName('Day group 2')).toBe('Group 2');
    expect(initialsOf('Day group 2')).toBe('G2');
    expect(shortName('Moses Rodriguez')).toBe('Moses');
    expect(initialsOf('Moses Rodriguez')).toBe('MR');
  });
});

describe('the month', () => {
  it('puts each technician-day on its date in the crew’s order, and picks the one clicked', () => {
    const onSelect = vi.fn();
    calendar({ onSelect, cursor: '2026-10-01' });

    const october = screen.getByRole('region', { name: 'October 2026' });
    const kevin = within(october).getByRole('button', {
      name: 'Thursday, October 1: Kevin Granados, 9 visits (2 HVAC), zone 2, 3 hr inspecting',
    });
    const moses = within(october).getByRole('button', { name: /^Thursday, October 1: Moses Rodriguez, 10 visits/ });
    // Moses is first on the crew, so first on the day.
    expect(moses.compareDocumentPosition(kevin) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Each date counts its visits, as Jobber does.
    expect(within(october).getByText('19 visits')).toBeTruthy();

    fireEvent.click(kevin);
    expect(onSelect).toHaveBeenCalledWith('kevin-oct-1');
  });

  it('shows one month at a time: the one the date in view is in', () => {
    calendar({ cursor: '2026-11-10' });

    expect(screen.getByRole('region', { name: 'November 2026' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'October 2026' })).toBeNull();
  });

  it('marks US holidays, days the office closed, and the Mondays kept free', () => {
    const { unmount } = calendar({ cursor: '2026-10-01' });

    const october = screen.getByRole('region', { name: 'October 2026' });
    // Oct 12 is a US holiday; Oct 5, 19 and 26 are kept for rescheduled visits.
    expect(within(october).getAllByText('US holiday')).toHaveLength(1);
    expect(within(october).getAllByText('Kept free')).toHaveLength(3);
    unmount();

    calendar({ cursor: '2026-11-02' });
    const november = screen.getByRole('region', { name: 'November 2026' });
    expect(within(november).getAllByText('US holiday')).toHaveLength(2);
    expect(within(november).getByText('Closed')).toBeTruthy();
  });

  it('says which days are outside the office’s rules', () => {
    const long = day('kevin-oct-7', '2026-10-07', 'kevin', 'Kevin Granados', 9, '2');
    long.stops[4]!.driveSecondsForecast = 25 * 60;
    calendar({ days: [...DAYS, long], cursor: '2026-10-01' });

    // A drive of twenty-five minutes between two of its properties.
    expect(screen.getByRole('button', { name: /^Wednesday, October 7: Kevin Granados, 9 visits.*, outside the rules$/ })).toBeTruthy();
    // Seven visits is a short day, not one against the rules; ten is the most a day holds.
    expect(screen.getByRole('button', { name: /^Tuesday, October 6: Moses Rodriguez, 7 visits.*inspecting$/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Friday, October 2: Emanuel Hall, 10 visits.*inspecting$/ })).toBeTruthy();
  });

  it('shows a plan’s days before the quarter, with the Mondays kept free from its own second week', () => {
    const early = [day('moses-sep-23', '2026-09-23', 'moses', 'Moses Rodriguez', 9, '1')];
    calendar({ days: early, startsOn: '2026-09-23', cursor: '2026-09-23' });

    const september = screen.getByRole('region', { name: 'September 2026' });
    expect(within(september).getByRole('button', { name: /^Wednesday, September 23: Moses Rodriguez, 9 visits/ })).toBeTruthy();
    // Monday 28 September is the plan's second week.
    expect(within(september).getAllByText('Kept free')).toHaveLength(1);
  });

  it('marks a day built around a move-out', () => {
    const anchored = {
      ...day('moses-oct-14', '2026-10-14', 'moses', 'Moses Rodriguez', 10, '3'),
      anchors: [moveOut('anchor-1', '2026-10-14', 'moses')],
    } as unknown as PlanDay;
    calendar({ days: [anchored], cursor: '2026-10-14' });

    expect(screen.getByRole('button', { name: /^Wednesday, October 14: Moses Rodriguez, 10 visits.*, built around a move-out, / })).toBeTruthy();
  });

  /** Console-development: a move-out is what a day is built around, not a warning -- amber only once it needs a rebuild. */
  it('draws a move-out’s diamond neutral, and amber only once its day needs a rebuild', () => {
    const kept = {
      ...day('moses-oct-14', '2026-10-14', 'moses', 'Moses Rodriguez', 6, '3'),
      anchors: [moveOut('anchor-1', '2026-10-14', 'moses')],
    } as unknown as PlanDay;
    const reassigned = {
      ...day('moses-oct-15', '2026-10-15', 'moses', 'Moses Rodriguez', 6, '3'),
      anchors: [moveOut('anchor-2', '2026-10-15', 'kevin')],
    } as unknown as PlanDay;
    calendar({ days: [kept, reassigned], cursor: '2026-10-14' });

    const diamondOf = (name: RegExp) => screen.getByRole('button', { name }).querySelector('.rotate-45')!;
    expect(diamondOf(/^Wednesday, October 14:/).className).toContain('bg-muted-foreground');
    expect(diamondOf(/^Thursday, October 15:/).className).toContain('bg-warning');
  });

  /** The office (2026-09-18): three visits fewer for each move-out or move-in on the day. */
  it('names the move-outs and move-ins a day is built around, and holds it to three visits fewer for each', () => {
    const anchored = {
      ...day('moses-oct-14', '2026-10-14', 'moses', 'Moses Rodriguez', 4, '3'),
      anchors: [moveOut('anchor-1', '2026-10-14', 'moses'), moveOut('anchor-2', '2026-10-14', 'moses')],
    } as unknown as PlanDay;
    calendar({ days: [anchored], cursor: '2026-10-14' });

    // Two of them leave room for up to four visits: inside the rules.
    const button = screen.getByRole('button', { name: /built around 2 move-outs, / });
    expect(button.getAttribute('aria-label')).not.toContain('outside the rules');
  });

  it('opens a day from its date', () => {
    const onOpenDate = vi.fn();
    calendar({ cursor: '2026-10-01', onOpenDate });

    fireEvent.click(screen.getByRole('button', { name: 'Open Tuesday, October 6' }));
    expect(onOpenDate).toHaveBeenCalledWith('2026-10-06');
  });

  it('counts only the visits the filters let through', () => {
    calendar({ cursor: '2026-10-01', filter: { visit: (stop) => stop.inspectionType === 'HVAC', bookings: true } });

    // Two HVAC visits on each of Moses's and Kevin's days.
    expect(within(screen.getByRole('region', { name: 'October 2026' })).getByText('4 visits')).toBeTruthy();
  });
});

describe('the week', () => {
  it('lists each date’s visits under whose day they are, and picks the day of the visit clicked', () => {
    const onSelect = vi.fn();
    calendar({ view: 'week', cursor: '2026-10-06', onSelect });

    const tuesday = screen.getByRole('group', { name: 'Tuesday, October 6' });
    expect(within(tuesday).getByText('7 visits')).toBeTruthy();
    expect(within(tuesday).getByRole('button', { name: /^Tuesday, October 6: Moses Rodriguez, 7 visits/ })).toBeTruthy();
    // Monday the 5th is kept free, and nothing is on it.
    expect(within(screen.getByRole('group', { name: 'Monday, October 5' })).getByText('Kept free')).toBeTruthy();

    fireEvent.click(within(tuesday).getByRole('button', { name: /^3 moses-oct-6 St, occupied, on Moses Rodriguez’s day$/ }));
    expect(onSelect).toHaveBeenCalledWith('moses-oct-6');
  });

  /** The office (2026-10-06): a property clicked on the calendar is shown on the map. */
  it('hands a visit clicked to the map, and outlines the one the map is on', () => {
    const onFocusStop = vi.fn();
    const onSelect = vi.fn();
    calendar({ view: 'week', cursor: '2026-10-06', onSelect, onFocusStop, focusedStopId: 'moses-oct-6-stop-2' });

    const tuesday = screen.getByRole('group', { name: 'Tuesday, October 6' });
    fireEvent.click(within(tuesday).getByRole('button', { name: /^3 moses-oct-6 St,/ }));
    expect(onFocusStop).toHaveBeenCalledWith('moses-oct-6', 'moses-oct-6-stop-3');
    expect(onSelect).not.toHaveBeenCalled();
    expect(within(tuesday).getByRole('button', { name: /^2 moses-oct-6 St,/ }).getAttribute('aria-current')).toBe('true');
  });

  it('greys the days of the quarter’s first week that are before it', () => {
    calendar({ view: 'week', cursor: '2026-10-01', onOpenDate: vi.fn() });

    // Monday 28 September is not in the quarter: no way to open it.
    expect(screen.getByRole('group', { name: 'Monday, September 28' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open Monday, September 28' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Open Thursday, October 1' })).toBeTruthy();
  });
});

describe('the day', () => {
  it('gives each technician out that date a column, with the visits in driving order and when each is reached', () => {
    const onSelect = vi.fn();
    calendar({ view: 'day', cursor: '2026-10-01', onSelect, selectedDayId: 'moses-oct-1' });

    const day = screen.getByRole('region', { name: 'Thursday, October 1' });
    const columns = within(day).getAllByRole('button', { name: /^Thursday, October 1: / });
    expect(columns.map((button) => button.getAttribute('aria-label')?.split(',')[1]?.split(':')[1]?.trim())).toEqual([
      'Moses Rodriguez',
      'Kevin Granados',
    ]);
    expect(columns[0]!.getAttribute('aria-current')).toBe('true');
    // Nine o'clock, twenty minutes there, ten minutes' drive to the next.
    expect(within(day).getByRole('button', { name: /^1 moses-oct-1 St,/ }).textContent).toContain('9:00 AM');
    expect(within(day).getByRole('button', { name: /^2 moses-oct-1 St,/ }).textContent).toContain('9:30 AM');

    fireEvent.click(columns[1]!);
    expect(onSelect).toHaveBeenCalledWith('kevin-oct-1');
  });

  it('says so when nothing is planned on the date', () => {
    calendar({ view: 'day', cursor: '2026-10-05' });

    expect(screen.getByText('Nothing planned on this day.')).toBeTruthy();
    expect(screen.getByText('Kept free')).toBeTruthy();
  });
});
