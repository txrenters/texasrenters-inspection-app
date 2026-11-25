import type { JobberDayComparison, JobberDayRow } from '@texasrenters/shared';
import { describe, expect, it } from 'vitest';

import {
  calendarRows,
  dayColumns,
  daysToRead,
  hourWindow,
  isShown,
  monthOf,
  monthTitle,
  NO_FILTERS,
  oneCardPerJob,
  peopleOf,
  sortVisits,
  STATUS_GROUPS,
  statusGroup,
  stepAnchor,
  sundayOf,
  texasMinutes,
  visitName,
  visitStart,
  weekOf,
} from './schedule-calendar';

const row = (overrides: Partial<JobberDayRow> = {}): JobberDayRow => ({
  key: overrides.inspectionId ?? 'jobber:1',
  inspectionId: 'inspection-1',
  jobberVisitId: null,
  property: '12 Elm Ct',
  inspectionType: 'OCCUPIED',
  status: 'SCHEDULED',
  technicianId: 'tech-a',
  here: { startAt: null, technician: 'Ada' },
  jobber: null,
  state: 'MATCHES',
  differences: [],
  waitingToSend: false,
  importNote: null,
  ...overrides,
});

describe('the calendar’s days', () => {
  it('starts a week on Sunday, as Jobber does', () => {
    expect(sundayOf('2026-11-04')).toBe('2026-11-01');
    expect(sundayOf('2026-11-01')).toBe('2026-11-01');
    expect(weekOf('2026-11-07')).toEqual([
      '2026-11-01',
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
      '2026-11-05',
      '2026-11-06',
      '2026-11-07',
    ]);
  });

  it('draws a month as whole weeks, and reads only the month’s own days', () => {
    const november = monthOf('2026-11-18');
    expect(november.days).toHaveLength(30);
    expect(november.days[0]).toBe('2026-11-01');
    // November 2026 starts on a Sunday and ends on a Monday: five weeks.
    expect(november.grid[0]).toBe('2026-11-01');
    expect(november.grid.at(-1)).toBe('2026-12-05');
    expect(november.grid.length % 7).toBe(0);
    expect(daysToRead('month', '2026-11-18')).toEqual(november.days);
  });

  it('steps a day, a week or a month, keeping the day of the month where it can', () => {
    expect(stepAnchor('day', '2026-11-04', 1)).toBe('2026-11-05');
    expect(stepAnchor('week', '2026-11-04', -1)).toBe('2026-10-28');
    expect(stepAnchor('month', '2026-10-31', 1)).toBe('2026-11-30');
    expect(stepAnchor('month', '2026-01-15', -1)).toBe('2025-12-15');
  });

  it('names the month in its title', () => {
    expect(monthTitle('2026-11-04')).toBe('November 2026');
  });
});

describe('visit times', () => {
  /**
   * The test runner on this machine is in Manila, 14 hours ahead of Texas in
   * November, so this proves the zone rather than assuming it.
   */
  it('reads the clock in Texas, wherever the reader is', () => {
    // 19:30 UTC is 1:30 PM in Texas (CST, UTC-6) on 4 November 2026.
    expect(texasMinutes('2026-11-04T19:30:00.000Z')).toBe(13 * 60 + 30);
  });

  it('takes our time before Jobber’s, and calls neither Anytime', () => {
    expect(visitStart(row({ here: { startAt: '2026-11-04T15:00:00.000Z', technician: 'Ada' } }))).toBe(
      '2026-11-04T15:00:00.000Z',
    );
    expect(
      visitStart(
        row({ jobber: { startAt: '2026-11-04T16:00:00.000Z', technician: 'Ada', title: null, completed: false } }),
      ),
    ).toBe('2026-11-04T16:00:00.000Z');
    expect(visitStart(row())).toBeNull();
  });

  it('draws the working day, widened for a visit outside it, and no grid with nothing timed', () => {
    expect(hourWindow([])).toBeNull();
    expect(hourWindow([10 * 60])).toEqual({ from: 8, to: 17 });
    expect(hourWindow([6 * 60 + 30, 19 * 60 + 15])).toEqual({ from: 6, to: 20 });
  });
});

describe('the filters', () => {
  it('groups a visit by where it stands', () => {
    expect(statusGroup(row())).toBe('upcoming');
    expect(statusGroup(row({ status: 'IN_PROGRESS' }))).toBe('active');
    expect(statusGroup(row({ status: 'COMPLETED' }))).toBe('done');
    expect(statusGroup(row({ status: 'CANCELLED' }))).toBe('cancelled');
    expect(statusGroup(row({ inspectionId: null, status: null }))).toBe('jobber');
  });

  it('shows everything until something is unticked', () => {
    expect(isShown(row(), NO_FILTERS)).toBe(true);
    expect(isShown(row(), { ...NO_FILTERS, types: new Set(['OCCUPIED']) })).toBe(false);
    expect(isShown(row({ technicianId: null }), { ...NO_FILTERS, technicians: new Set(['nobody']) })).toBe(false);
    expect(isShown(row(), { ...NO_FILTERS, statuses: new Set(['done']) })).toBe(true);
  });
});

describe('the Day view’s columns', () => {
  it('puts Unassigned first, always, then the technicians by name', () => {
    const day = {
      technicians: [
        { technicianId: 'tech-z', name: 'Zoe', here: 2, inJobber: 2, done: 0, differences: 0 },
        { technicianId: null, name: 'Nobody here', here: 1, inJobber: 1, done: 0, differences: 0 },
        { technicianId: 'tech-a', name: 'Ada', here: 3, inJobber: 3, done: 1, differences: 0 },
      ],
    } as unknown as JobberDayComparison;
    expect(dayColumns(day).map((column) => column.name)).toEqual(['Unassigned', 'Ada', 'Zoe']);
    expect(dayColumns(undefined).map((column) => column.name)).toEqual(['Unassigned']);
  });

  it('orders a day by the clock first, then Anytime by person and property', () => {
    const anytime = row({ inspectionId: 'b', property: 'B St' });
    const early = row({ inspectionId: 'c', here: { startAt: '2026-11-04T14:00:00.000Z', technician: 'Ada' } });
    const late = row({ inspectionId: 'd', here: { startAt: '2026-11-04T20:00:00.000Z', technician: 'Ada' } });
    const anytimeFirst = row({ inspectionId: 'a', property: 'A St' });
    expect(sortVisits([anytime, late, anytimeFirst, early], () => 'Ada').map((entry) => entry.inspectionId)).toEqual([
      'c',
      'd',
      'a',
      'b',
    ]);
  });

  it("lists Anytime visits in the order the office dragged them into in Jobber -- Emanuel Hall's Nov 24 (2026-11-25)", () => {
    const visit = (id: string, title: string, order: number | null, technician = 'Emanuel Hall') =>
      row({ inspectionId: id, property: title, jobber: { startAt: null, technician, title, completed: false, order } });
    const aspen = visit('aspen', '2939 Aspen Park Ln - Zone 2 - General Maintenance - #44767', 20);
    const lavaca = visit('lavaca', '5814 Lavaca Lane - Zone 4 - General maintenance - 44718', 19);
    const simeon39 = visit('44239', '74 San Simeon Dr - 74 San Simeon - Zone 3 - General Maintenance - #44239', 18);
    const simeon24 = visit('44524', '74 San Simeon Dr - 74 San Simeon - Zone 3 - General Maintenance - #44524', 16);
    const wilkins = visit('wilkins', '5826 Wilkins lane - 5826 Wilkins lane - Zone 3 - HVAC - #44779', 0);
    const noPlace = visit('none', '1 Any St', null);
    const timed = row({ inspectionId: 'timed', here: { startAt: '2026-11-24T14:00:00.000Z', technician: 'Emanuel Hall' } });
    const ids = (rows: JobberDayRow[]) => rows.map((entry) => entry.inspectionId);

    expect(ids(sortVisits([aspen, noPlace, lavaca, simeon39, timed, simeon24, wilkins], visitName))).toEqual([
      'timed',
      'wilkins',
      '44524',
      '44239',
      'lavaca',
      'aspen',
      'none',
    ]);

    // Week and Month keep each person together, each in their own dragged order.
    const kevin = visit('kevin', '3301 Omega B - Zone 1 - General Maintenance - WO#44805', 5, 'kevin granados');
    const person = (entry: JobberDayRow) => entry.jobber?.technician ?? '';
    expect(ids(sortVisits([lavaca, kevin, wilkins], visitName, person))).toEqual(['wilkins', 'lavaca', 'kevin']);
  });
});

describe('one card a job (2026-11-20)', () => {
  const job = { id: 'job-1', number: 'J-00042', title: 'Occupied + HVAC', kinds: ['HVAC', 'OCCUPIED'] };

  it("keeps the job's lead, wherever it sits, and drops the job's other rows", () => {
    const occupied = row({ inspectionId: 'occ', inspectionType: 'OCCUPIED', job });
    const hvac = row({ inspectionId: 'hvac', inspectionType: 'HVAC', job });
    const other = row({ inspectionId: 'other' });
    expect(oneCardPerJob([occupied, other, hvac]).map((kept) => kept.inspectionId)).toEqual(['other', 'hvac']);
  });

  it("keeps a job's rows apart when they are with different technicians", () => {
    const rows = [
      row({ inspectionId: 'occ', inspectionType: 'OCCUPIED', job }),
      row({ inspectionId: 'hvac', inspectionType: 'HVAC', technicianId: 'tech-b', job }),
    ];
    expect(oneCardPerJob(rows)).toHaveLength(2);
  });

  it('leaves rows with no job as they are', () => {
    const rows = [row({ inspectionId: 'a' }), row({ inspectionId: 'b', job: null })];
    expect(oneCardPerJob(rows)).toEqual(rows);
  });
});

describe('Jobber work on the calendar (2026-11-25)', () => {
  const work = {
    jobberVisitId: 'v-7',
    title: '3301 Omega B - Zone 1 - General Maintenance - WO#44805',
    property: '3301 Omega B',
    technician: 'Kevin Granados',
    technicianId: 'tech-k',
    startAt: null,
    completed: false,
    reason: 'Not named as an inspection',
  };
  const withWork = {
    date: '2026-11-24',
    rows: [row({ inspectionId: 'inspection-1' })],
    technicians: [{ technicianId: 'tech-a', name: 'Ada', here: 1, inJobber: 1, done: 0, differences: 0 }],
    otherWork: [work, { ...work, jobberVisitId: 'v-8', title: 'Key information', technician: null, technicianId: null, completed: true }],
  } as unknown as JobberDayComparison;

  it("draws every Jobber visit that is not an inspection beside the day's inspections, as Jobber's calendar does", () => {
    const rows = calendarRows(withWork);

    expect(rows).toHaveLength(3);
    expect(rows[1]).toMatchObject({
      key: 'work:v-7',
      jobberWork: true,
      inspectionId: null,
      jobberVisitId: 'v-7',
      property: '3301 Omega B',
      technicianId: 'tech-k',
      state: 'MATCHES',
      jobber: { title: '3301 Omega B - Zone 1 - General Maintenance - WO#44805', technician: 'Kevin Granados', completed: false, startAt: null },
    });
    expect(rows[2]).toMatchObject({ jobberWork: true, technicianId: null, jobber: { completed: true } });
  });

  it('reads a day with nothing extra, or none at all', () => {
    expect(calendarRows({ ...withWork, otherWork: undefined } as unknown as JobberDayComparison)).toHaveLength(1);
    expect(calendarRows(undefined)).toEqual([]);
  });

  it('gives Jobber work its own Status group, so it can be hidden', () => {
    const [, jobberWork] = calendarRows(withWork);
    expect(statusGroup(jobberWork)).toBe('work');
    expect(STATUS_GROUPS.map((group) => group.value)).toContain('work');
    expect(isShown(jobberWork, { ...NO_FILTERS, statuses: new Set(['work']) })).toBe(false);
  });

  it("gives a technician who only has Jobber work that day a column on the Day view", () => {
    expect(dayColumns(withWork).map((column) => column.name)).toEqual(['Unassigned', 'Ada', 'Kevin Granados']);
  });
});

describe('a visit with two people on it (2026-11-25)', () => {
  const shared = row({ technicianId: 'tech-a', technicianIds: ['tech-a', 'tech-b'] });

  it("is with everyone on it, and with the row's own person on a day read before that was known", () => {
    expect(peopleOf(shared)).toEqual(['tech-a', 'tech-b']);
    expect(peopleOf(row({ technicianId: 'tech-a' }))).toEqual(['tech-a']);
    expect(peopleOf(row({ technicianId: null, technicianIds: [] }))).toEqual([null]);
  });

  it('stays on the calendar while anyone on it is shown', () => {
    expect(isShown(shared, { ...NO_FILTERS, technicians: new Set(['tech-a']) })).toBe(true);
    expect(isShown(shared, { ...NO_FILTERS, technicians: new Set(['tech-a', 'tech-b']) })).toBe(false);
  });

  it('carries everyone on Jobber work into its card', () => {
    const [card] = calendarRows({
      rows: [],
      technicians: [],
      otherWork: [{ jobberVisitId: 'v', title: 'Key information', property: '1 A St', technician: 'A, B', technicianId: 'tech-a', technicianIds: ['tech-a', 'tech-b'], startAt: null, completed: false, reason: 'x' }],
    } as unknown as JobberDayComparison);
    expect(peopleOf(card)).toEqual(['tech-a', 'tech-b']);
  });
});
