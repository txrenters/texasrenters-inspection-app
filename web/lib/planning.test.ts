import { describe, expect, it } from 'vitest';

import {
  dayClock,
  formatClock,
  formatMinutes,
  limitState,
  parseCsv,
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

  /** The day starts at the first job, so whatever reached the first stop is not on the clock. */
  it('never counts a drive to the first stop', () => {
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
});

describe('a day against the office’s limits', () => {
  it('is over past the limit, near in its last tenth, and within otherwise', () => {
    expect(limitState(91, 90)).toBe('over');
    expect(limitState(90, 90)).toBe('near');
    expect(limitState(81, 90)).toBe('near');
    expect(limitState(60, 90)).toBe('within');
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
