import { describe, expect, it } from 'vitest';

import {
  attentionOf,
  quarterOf,
  recentQuarters,
  attentionText,
  bookedInWords,
  dayClock,
  dayOutsideRules,
  formatClock,
  formatMinutes,
  formatShortDay,
  leaveHomeAt,
  limitState,
  longestLegSeconds,
  parseCsv,
  planStartOptions,
  planStartText,
  planStartValue,
  quarterChoices,
  readOfficeSheet,
} from './planning';

describe('a planned day as a clock', () => {
  it('starts at nine, and adds each drive and each visit in turn', () => {
    const clock = dayClock([
      { onSiteMinutes: 30, driveSecondsForecast: null },
      { onSiteMinutes: 45, driveSecondsForecast: 12 * 60 },
      { onSiteMinutes: 30, driveSecondsForecast: 8 * 60 + 20 },
    ]);

    expect(clock.map((stop) => [formatClock(stop.arrives), formatClock(stop.leaves), stop.driveMinutes])).toEqual([
      ['9:00 AM', '9:30 AM', 0],
      ['9:42 AM', '10:27 AM', 12],
      ['10:35 AM', '11:05 AM', 8],
    ]);
  });

  /** The clock starts at the first job at nine; the drive from home comes before it (`leaveHomeAt`). */
  it('starts the clock at the first stop, whatever the drive to it', () => {
    expect(dayClock([{ onSiteMinutes: 30, driveSecondsForecast: 3600 }])[0]).toMatchObject({ arrives: 540, driveMinutes: 0 });
  });
});

describe('writing times', () => {
  it('writes a clock time the way the office reads one', () => {
    expect(formatClock(0)).toBe('12:00 AM');
    expect(formatClock(12 * 60 + 5)).toBe('12:05 PM');
    expect(formatClock(15 * 60 + 30)).toBe('3:30 PM');
  });

  it('writes a length in hours and minutes', () => {
    expect(formatMinutes(45)).toBe('45 min');
    expect(formatMinutes(360)).toBe('6 hr');
    expect(formatMinutes(330)).toBe('5 hr 30 min');
  });

  it('writes a calendar date as its month and day, whatever the time zone', () => {
    expect(formatShortDay('2026-10-12')).toBe('Oct 12');
    expect(formatShortDay('2026-12-25')).toBe('Dec 25');
  });

  it('says when to leave home: the drive from home before the first job at nine', () => {
    expect(formatClock(leaveHomeAt(9 * 60, 35 * 60 + 20))).toBe('8:25 AM');
    expect(formatClock(leaveHomeAt(9 * 60, 0))).toBe('9:00 AM');
  });
});

describe('a day against the office’s limits', () => {
  it('is over past the limit, near in its last tenth, and within otherwise', () => {
    expect(limitState(91, 90)).toBe('over');
    expect(limitState(90, 90)).toBe('near');
    expect(limitState(81, 90)).toBe('near');
    expect(limitState(60, 90)).toBe('within');
  });

  /**
   * The office (2026-09-19): days of nine, up to twelve with the office's own
   * visits, three fewer for each move-out or move-in, and never more than twenty
   * minutes from one property to the next. A short day is the planner's answer
   * to properties too far apart, and inside the rules.
   */
  it('holds a day to twelve visits, three fewer for each move-out or move-in, and no drive over twenty minutes between properties', () => {
    const rules = { minStopsPerDay: 9, maxStopsPerDay: 12, maxOnSiteMinutes: 360, maxLegMinutes: 20 };
    const on = (stopCount: number, booked: number, legSeconds = 600) =>
      dayOutsideRules(
        {
          stopCount,
          onSiteMinutes: 300,
          stops: Array.from({ length: stopCount }, (_, index) => ({ driveSecondsForecast: index ? legSeconds : null })),
          anchors: Array.from({ length: booked }, () => ({ driveSecondsForecast: null })),
        },
        rules,
      );

    expect([on(3, 0), on(9, 0), on(12, 0), on(13, 0)]).toEqual([false, false, false, true]);
    expect([on(6, 1), on(9, 1), on(10, 1)]).toEqual([false, false, true]);
    expect([on(0, 3), on(3, 3), on(4, 3)]).toEqual([false, false, true]);
    // Twenty minutes is the limit; twenty-one is over it.
    expect([on(9, 0, 20 * 60), on(9, 0, 21 * 60)]).toEqual([false, true]);
  });

  it('finds the longest drive between a day’s stops, move-outs included, and not the drive from home', () => {
    expect(
      longestLegSeconds({
        stops: [{ driveSecondsForecast: null }, { driveSecondsForecast: 300 }],
        anchors: [{ driveSecondsForecast: 900 }],
      }),
    ).toBe(900);
    expect(longestLegSeconds({ stops: [{ driveSecondsForecast: null }] })).toBeNull();
  });

  it('names the move-outs and move-ins on a day', () => {
    const outs = (count: number) => Array.from({ length: count }, () => ({ kind: 'MOVE_OUT' as const }));
    const ins = (count: number) => Array.from({ length: count }, () => ({ kind: 'MOVE_IN' as const }));

    expect(bookedInWords(outs(1))).toBe('a move-out');
    expect(bookedInWords([...outs(2), ...ins(1)])).toBe('2 move-outs and a move-in');
    expect(bookedInWords(ins(1), 'count')).toBe('1 move-in');
    expect(bookedInWords([...outs(1), ...ins(2)], 'bare')).toBe('move-out and 2 move-ins');
  });
});

/** The office (2026-09-19): "for the q4 we can start as early as september by asking that +-15 days". */
/**
 * The office (2026-09-20), beside Jobber's unscheduled appointments: "kaning
 * naka needs attention pwede nato ni ma latag tanan sa map para makita ni sila
 * asa dapita?" -- so what each one is waiting for has to be named.
 */
describe('what a visit is waiting for', () => {
  const stop = (extra: Partial<Parameters<typeof attentionOf>[0]> = {}) => ({
    status: 'PLANNED',
    unitResolution: 'NO_UNITS',
    scheduledOn: '2026-10-01T00:00:00.000Z',
    assignedTechnicianId: 'tech-1',
    inspectionTypeNeedsReview: false,
    ...extra,
  });

  it('names the day before the technician, and nothing for a visit that has both', () => {
    expect(attentionOf(stop())).toBeNull();
    expect(attentionOf(stop({ scheduledOn: null, assignedTechnicianId: null }))).toBe('NO_DAY');
    expect(attentionOf(stop({ assignedTechnicianId: null }))).toBe('NO_TECHNICIAN');
    expect(attentionOf(stop({ unitResolution: 'UNRESOLVED' }))).toBe('NEEDS_UNIT');
    expect(attentionOf(stop({ inspectionTypeNeedsReview: true }))).toBe('KIND_TO_CHECK');
    expect(attentionOf(stop({ status: 'FAILED' }))).toBe('FAILED');
  });

  it('leaves a published or excluded visit alone', () => {
    expect(attentionOf(stop({ status: 'PUBLISHED' }))).toBeNull();
    expect(attentionOf(stop({ status: 'EXCLUDED', scheduledOn: null, assignedTechnicianId: null }))).toBeNull();
  });

  it('says what each one is waiting for in the words the map uses', () => {
    expect(attentionText('NO_DAY')).toBe('No day yet');
    expect(attentionText('NO_TECHNICIAN')).toBe('No technician yet');
  });
});

describe('the first day of a plan', () => {
  const Q4 = { year: 2026, quarter: 4 as const };

  it('is fifteen days early, on time, or fifteen days late', () => {
    expect(planStartOptions(Q4, null, '2026-09-10').map((option) => [option.label, option.date, option.past])).toEqual([
      ['15 days early', '2026-09-16', false],
      ['On time', '2026-10-01', false],
      ['15 days late', '2026-10-16', false],
    ]);
  });

  /** A start already gone is still offered: the plan begins from it and the days gone are not planned. */
  it('says which of them are past', () => {
    expect(planStartOptions(Q4, null, '2026-09-20').map((option) => option.past)).toEqual([true, false, false]);
  });

  it('keeps a plan’s own first day as a fourth choice, so a rebuild never moves it by accident', () => {
    const options = planStartOptions(Q4, '2026-09-21T00:00:00.000Z', '2026-09-20');

    expect(options.map((option) => option.value)).toEqual(['EARLY', 'ON_TIME', 'LATE', 'KEPT']);
    expect(options.at(-1)).toMatchObject({ date: '2026-09-21', label: 'As built' });
    expect(planStartValue(options, '2026-09-21T00:00:00.000Z')).toBe('KEPT');
  });

  it('starts a plan that has none on time', () => {
    const options = planStartOptions(Q4, null, '2026-09-20');

    expect(planStartValue(options, null)).toBe('ON_TIME');
    expect(planStartValue(options, '2026-09-16')).toBe('EARLY');
  });

  it('says the first day in words', () => {
    expect(planStartText(Q4, null)).toBe("Oct 1, the quarter's first day");
    expect(planStartText(Q4, '2026-09-21T00:00:00.000Z')).toBe("Sep 21, 10 days before the quarter's first");
    expect(planStartText(Q4, '2026-10-02')).toBe("Oct 2, 1 day after the quarter's first");
  });
});

/**
 * The office (2026-09-21), looking for Q3's visits among 1,533 inspections:
 * "add a TBP filter add also the quarter tag and add a filter to it".
 */
describe('the quarter a visit belongs to', () => {
  it('reads a day in UTC, so a quarter boundary does not move with the reader', () => {
    expect(quarterOf('2026-09-30T23:00:00.000Z')).toBe('Q3 2026');
    expect(quarterOf('2026-10-01T00:00:00.000Z')).toBe('Q4 2026');
    expect(quarterOf(null)).toBe('');
  });

  /**
   * The office (2026-09-21): "Q4 2026 is not there". It was not, and 55 of its
   * visits were already booked -- a plan starts up to fifteen days before its
   * quarter, so the next one is real long before the calendar reaches it.
   */
  it('offers the quarter after this one, so a plan published early can be found', () => {
    const quarters = recentQuarters(new Date('2026-09-21T00:00:00.000Z'));

    expect(quarters[0]).toBe('Q4 2026');
    expect(quarters[1]).toBe('Q3 2026');
    expect(quarters.at(-1)).toBe('Q1 2025');
  });

  it('rolls into the next year from Q4', () => {
    expect(recentQuarters(new Date('2026-11-02T00:00:00.000Z'))[0]).toBe('Q1 2027');
  });
});

describe('the quarters a coordinator can open', () => {
  it('offers the coming quarter first, then this one, then every plan there is', () => {
    const choices = quarterChoices([{ quarterYear: 2026, quarterNumber: 2 }], new Date('2026-09-16T12:00:00Z'));

    expect(choices.map((choice) => choice.label)).toEqual(['Q4 2026', 'Q3 2026', 'Q2 2026']);
  });

  it('rolls into next year from Q4', () => {
    expect(quarterChoices([], new Date('2026-11-02T12:00:00Z'))[0]).toMatchObject({ key: '2027-1', label: 'Q1 2027' });
  });
});

describe('reading the office’s sheet', () => {
  it('keeps a quoted cell whole, commas, quotes and line breaks included', () => {
    expect(parseCsv('a,"b, c","say ""hi""","two\nlines"\r\nd,e,f,g')).toEqual([
      ['a', 'b, c', 'say "hi"', 'two\nlines'],
      ['d', 'e', 'f', 'g'],
    ]);
  });

  it('ignores the byte-order mark a spreadsheet saves', () => {
    expect(parseCsv(`${String.fromCharCode(0xfeff)}Job Title,Instruction`)[0]).toEqual(['Job Title', 'Instruction']);
  });

  /** The office's own Jobber import sheet, as it was handed over on 2026-09-16 (made-up rows). */
  it('reads the address, city, ZIP and Details from the office’s Jobber import sheet', () => {
    const sheet = [
      'Job Title,Instruction,Job Number,Client Name,Client Contact #,Client Email,Property Address,Street1,Street2,City,State,Zip',
      'Zone 1 - Q4 2026 Tenant Benefit Package,Filter Change: 20x25x1 + Pest Control + Occupied Inspection,,1 Any St,,,1 Any St,1 Any St,,Katy,Texas,77494-1234',
      '"Zone 2 - Q4 2026 Tenant Benefit Package","Filter Change: 16x25x1; 14x20x1 + Pest Control + Occupied Inspection (Basic Plan - Opted Out HVAC Plan)",,2 Elm St,,,2 Elm St,2 Elm St,,Cypress,Texas,77429',
      ',,,3 Oak St,,,3 Oak St,3 Oak St,,Cypress,Texas,',
    ].join('\r\n');

    const read = readOfficeSheet(sheet);

    expect(read.missing).toEqual([]);
    expect(read.skipped).toBe(1);
    expect(read.rows).toEqual([
      {
        address: '1 Any St',
        city: 'Katy',
        postalCode: '77494-1234',
        details: 'Filter Change: 20x25x1 + Pest Control + Occupied Inspection',
      },
      {
        address: '2 Elm St',
        city: 'Cypress',
        postalCode: '77429',
        details: 'Filter Change: 16x25x1; 14x20x1 + Pest Control + Occupied Inspection (Basic Plan - Opted Out HVAC Plan)',
      },
    ]);
  });

  it('says which columns a sheet is missing instead of importing nothing quietly', () => {
    expect(readOfficeSheet('Name,Notes\nA,B').missing).toEqual([
      'an address column (Street1)',
      'a Details column (Instruction)',
    ]);
  });
});
