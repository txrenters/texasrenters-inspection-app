import type { Inspection } from '../src/domain/models';
import {
  addDays,
  addMonths,
  dayCell,
  dayHeading,
  dayRange,
  jobDayOf,
  monthGrid,
  texasToday,
} from '../src/utils/job-day';
import { historySections, scheduleSections, searchSections } from '../src/utils/job-sections';
import { formatVisitDay } from '../src/utils/visit-window';

/**
 * The Jobs tab as a calendar (the office, 2026-10-07): one Texas day at a time,
 * the jobs still open from earlier days on top of today, History newest first,
 * and a search across every job.
 */

describe('the Texas day', () => {
  it('is still yesterday in Texas after midnight UTC', () => {
    // 03:00 UTC on Oct 8 is 10 p.m. on Oct 7 in Texas.
    expect(texasToday(new Date('2026-10-08T03:00:00.000Z'))).toBe('2026-10-07');
    expect(texasToday(new Date('2026-10-08T06:00:00.000Z'))).toBe('2026-10-08');
  });

  it('is the date a visit is booked for, never a day early', () => {
    // A `@db.Date` arrives as midnight UTC; read in Texas it used to print the
    // day before -- "Oct 6" for a visit on Oct 7.
    expect(jobDayOf('2026-10-07T00:00:00.000Z')).toBe('2026-10-07');
    expect(formatVisitDay('2026-10-07T00:00:00.000Z')).toBe('Oct 7');
  });

  it('steps across months, years and the clock change without slipping', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-11-01', 1)).toBe('2026-11-02'); // DST ends that morning
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31');
    expect(dayRange('2026-10-30', '2026-11-02')).toEqual([
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
    ]);
    expect(addMonths('2026-12', 1)).toBe('2027-01');
  });

  it('names days the way a technician says them', () => {
    expect(dayHeading('2026-10-07', '2026-10-07')).toBe('Today');
    expect(dayHeading('2026-10-08', '2026-10-07')).toBe('Tomorrow');
    expect(dayHeading('2026-10-06', '2026-10-07')).toBe('Yesterday');
    expect(dayHeading('2026-10-09', '2026-10-07')).toBe('Fri, Oct 9');
    expect(dayHeading('2027-01-04', '2026-10-07')).toBe('Mon, Jan 4, 2027');
    expect(dayCell('2026-10-07')).toEqual({ weekday: 'Wed', date: '7' });
  });

  it('lays a month out Sunday first, blanks around it', () => {
    // October 2026 starts on a Thursday and has 31 days.
    const grid = monthGrid('2026-10');
    expect(grid[0]).toEqual([null, null, null, null, '2026-10-01', '2026-10-02', '2026-10-03']);
    expect(grid.every((week) => week.length === 7)).toBe(true);
    expect(grid.flat().filter(Boolean)).toHaveLength(31);
    expect(grid.at(-1)).toEqual(['2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31']);
  });
});

const job = (id: string, day: string): Inspection =>
  ({ id, scheduledAt: `${day}T00:00:00.000Z` }) as Inspection;

describe('the schedule for a day', () => {
  it('puts the jobs still open from earlier days above today’s', () => {
    const sections = scheduleSections({
      day: '2026-10-07',
      today: '2026-10-07',
      rows: [job('a', '2026-10-07')],
      stillOpen: [job('old', '2026-10-02')],
    });
    expect(sections.map((section) => [section.title, section.showDay])).toEqual([
      ['Still open from earlier days', true],
      ['Today', false],
    ]);
  });

  it('keeps them to today: another day is only that day', () => {
    const sections = scheduleSections({
      day: '2026-10-09',
      today: '2026-10-07',
      rows: [job('a', '2026-10-09')],
      stillOpen: [job('old', '2026-10-02')],
    });
    expect(sections.map((section) => section.key)).toEqual(['2026-10-09']);
  });

  it('is empty when the day holds nothing, so the screen can say so', () => {
    expect(scheduleSections({ day: '2026-10-09', today: '2026-10-07', rows: [], stillOpen: [] })).toEqual([]);
  });
});

describe('History', () => {
  it('cuts the newest-first rows into one heading per day', () => {
    const sections = historySections(
      [job('a', '2026-10-07'), job('b', '2026-10-07'), job('c', '2026-10-05')],
      '2026-10-07',
    );
    expect(sections.map((section) => [section.title, section.data.length])).toEqual([
      ['Today', 2],
      ['Mon, Oct 5', 1],
    ]);
  });
});

describe('search results', () => {
  it('group as Today, Upcoming soonest first, then History', () => {
    // The server answers newest first, which put next month above tomorrow.
    const sections = searchSections(
      [job('next-month', '2026-11-03'), job('tomorrow', '2026-10-08'), job('today', '2026-10-07'), job('past', '2026-09-30')],
      '2026-10-07',
    );
    expect(sections.map((section) => [section.title, section.data.map((row) => row.id)])).toEqual([
      ['Today', ['today']],
      ['Upcoming', ['tomorrow', 'next-month']],
      ['History', ['past']],
    ]);
  });
});
