import {
  buildOutlook,
  mondayOf,
  outlookQuarters,
  outlookWindow,
  workingDaysFrom,
  type OutlookInput,
  type OutlookStopRow,
} from '../src/admin/dashboard-outlook';

/**
 * The dashboard's forward view (2026-11-17): six weeks of visits per day, the
 * next five working days by technician, and each quarter's plan against what
 * is done. Invented people and counts throughout.
 */

// A Tuesday.
const TODAY = '2026-11-17';
const DONE = ['TECHNICIAN_SUBMITTED', 'COMPLETED'];
const day = (value: string) => new Date(`${value}T00:00:00.000Z`);

function input(over: Partial<OutlookInput> = {}): OutlookInput {
  return {
    today: TODAY,
    inspections: [],
    doneStatuses: DONE,
    inProgressStatus: 'IN_PROGRESS',
    plans: [],
    stops: [],
    load: [],
    earliestUnassignedOn: null,
    ...over,
  };
}

const visit = (scheduledAt: string, inspectionType: string, status: string, count: number) => ({
  scheduledAt: day(scheduledAt),
  inspectionType,
  status,
  count,
});

const Q4 = {
  id: 'plan-q4',
  quarterYear: 2026,
  quarterNumber: 4,
  status: 'PUBLISHED',
  quarterStartsOn: day('2026-10-01'),
  startsOn: day('2026-09-21'),
};

function stop(over: Partial<OutlookStopRow> = {}): OutlookStopRow {
  return { planId: 'plan-q4', status: 'PLANNED', scheduledOn: null, inspection: null, ...over };
}

const booked = (scheduledAt: string, status = 'SCHEDULED', submittedAt: string | null = null) => ({
  status,
  scheduledAt: day(scheduledAt),
  submittedAt: submittedAt ? new Date(submittedAt) : null,
  completedAt: null,
});

describe('the days the outlook covers', () => {
  it('starts on the Monday of this week and runs six weeks', () => {
    expect(mondayOf(TODAY)).toBe('2026-11-16');
    expect(mondayOf('2026-11-22')).toBe('2026-11-16'); // a Sunday belongs to the week before it
    const window = outlookWindow(TODAY);
    expect(window.from).toBe('2026-11-16');
    expect(window.to).toBe('2026-12-27');
    expect(window.readFrom).toBe('2026-11-10'); // the seven days before today
    expect(buildOutlook(input()).days).toHaveLength(42);
  });

  it('counts five working days from today, over the weekend', () => {
    expect(workingDaysFrom('2026-11-19', 5)).toEqual([
      '2026-11-19',
      '2026-11-20',
      '2026-11-23',
      '2026-11-24',
      '2026-11-25',
    ]);
    expect(workingDaysFrom('2026-11-21', 1)).toEqual(['2026-11-23']); // from a Saturday
  });

  it('looks at last quarter, this one and the next, across the new year', () => {
    expect(outlookQuarters(TODAY).map(({ year, quarter, phase }) => `${phase} Q${quarter} ${year}`)).toEqual([
      'PAST Q3 2026',
      'CURRENT Q4 2026',
      'NEXT Q1 2027',
    ]);
  });
});

describe('visits per day', () => {
  const outlook = buildOutlook(
    input({
      inspections: [
        visit(TODAY, 'OCCUPIED', 'SCHEDULED', 10),
        visit(TODAY, 'OCCUPIED', 'TECHNICIAN_SUBMITTED', 4),
        visit(TODAY, 'MOVE_OUT', 'IN_PROGRESS', 2),
        visit(TODAY, 'ROOF', 'SCHEDULED', 1),
        visit(TODAY, 'HVAC', 'CANCELLED', 9),
        visit('2026-11-23', 'MOVE_IN', 'SCHEDULED', 3),
        visit('2026-11-24', 'HVAC', 'SCHEDULED', 5),
        visit('2026-11-16', 'OCCUPIED', 'COMPLETED', 6),
        visit('2026-11-10', 'OCCUPIED', 'COMPLETED', 7),
        visit('2026-11-09', 'OCCUPIED', 'COMPLETED', 50), // eight days back: outside the week before
      ],
    }),
  );
  const on = (date: string) => outlook.days.find((item) => item.date === date)!;

  it('splits a day by kind, files the rest under OTHER and leaves cancelled visits out', () => {
    expect(on(TODAY).booked).toEqual({ OCCUPIED: 14, MOVE_OUT: 2, MOVE_IN: 0, HVAC: 0, OTHER: 1 });
    expect(on(TODAY).done).toBe(4);
  });

  it('counts today, the next seven days and the seven before', () => {
    expect(outlook.todayCounts).toEqual({ total: 17, done: 4, inProgress: 2 });
    expect(outlook.next7).toBe(20); // today's 17 and the 23rd's 3; the 24th is the eighth day
    expect(outlook.previous7).toBe(13); // the 16th and the 10th
  });
});

describe('a quarter plan', () => {
  const outlook = buildOutlook(
    input({
      plans: [Q4],
      stops: [
        stop({ status: 'PUBLISHED', inspection: booked('2026-11-10', 'TECHNICIAN_SUBMITTED', '2026-11-11T02:30:00Z') }),
        stop({ status: 'PUBLISHED', inspection: booked('2026-11-12', 'COMPLETED') }),
        stop({ status: 'PUBLISHED', inspection: booked('2026-11-13') }), // its day has passed, not done
        stop({ status: 'PUBLISHED', inspection: booked('2026-11-19') }),
        stop({ status: 'PLANNED', scheduledOn: day('2026-12-01') }),
        stop({ status: 'PLANNED', scheduledOn: day('2026-12-01') }),
        stop({ status: 'PLANNED' }), // no day
        stop({ status: 'BLOCKED' }),
        stop({ status: 'UNSCHEDULED' }),
        stop({ status: 'PUBLISHED', scheduledOn: day('2026-11-20'), inspection: booked('2026-11-20', 'CANCELLED') }),
        stop({ status: 'EXCLUDED' }),
        stop({ planId: 'another-plan', status: 'PLANNED', scheduledOn: day('2026-12-01') }),
      ],
    }),
  );
  const [quarter] = outlook.quarters;

  it('sorts every stop into done, booked, planned or not scheduled', () => {
    expect(outlook.quarters).toHaveLength(1);
    expect(quarter).toMatchObject({
      label: 'Q4 2026',
      phase: 'CURRENT',
      startsOn: '2026-09-21',
      endsOn: '2026-12-31',
      done: 2,
      // The live visits, and the published stop whose visit was cancelled: it
      // still holds its day in the plan.
      booked: 3,
      planned: 2,
      notScheduled: 3,
      total: 10,
    });
    expect(quarter.done + quarter.booked + quarter.planned + quarter.notScheduled).toBe(quarter.total);
  });

  it('says where the plan should be by today, and where the work is', () => {
    expect(quarter.dueByToday).toBe(3); // the 10th, 12th and 13th
    // Sent in at 8:30 p.m. Texas on the 10th, which is the 11th in UTC.
    expect(quarter.progress).toEqual([
      { date: '2026-11-10', count: 1 },
      { date: '2026-11-12', count: 2 },
    ]);
    expect(quarter.plan.at(-1)).toEqual({ date: '2026-12-01', count: 7 });
  });

  it('puts planned stops that are not booked on their day of the schedule', () => {
    expect(outlook.days.find((item) => item.date === '2026-12-01')!.planned).toBe(3); // another plan's too
  });
});

describe('who holds the next five working days', () => {
  it('counts visits per technician, busiest first, with nobody last', () => {
    const amy = { technicianId: 't-amy', name: 'Amy W.' };
    const moses = { technicianId: 't-moses', name: 'Moses R.' };
    const outlook = buildOutlook(input({ load: [null, null, null, amy, moses, moses], earliestUnassignedOn: '2026-11-19' }));
    expect(outlook.technicianLoad).toEqual([
      { technicianId: 't-moses', name: 'Moses R.', visits: 2 },
      { technicianId: 't-amy', name: 'Amy W.', visits: 1 },
      { technicianId: null, name: 'Unassigned', visits: 3 },
    ]);
    expect(outlook.loadDays[0]).toBe(TODAY);
    expect(outlook.earliestUnassignedOn).toBe('2026-11-19');
  });
});
