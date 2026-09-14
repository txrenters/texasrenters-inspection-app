import { describe, expect, it } from 'vitest';

import {
  formatPhotoStamp,
  parseReportPhotoStamp,
  utcOffsetMinutes,
  wallClockToInstant,
} from '../src/index.js';

/**
 * Photograph times are evidence, so these are pinned to the second and to the
 * zone -- the two things that had been silently wrong.
 */

describe('the stamp drawn on a photograph', () => {
  it('prints Texas time, to the second, with the zone', () => {
    // 18:22:07 UTC in September is 1:22:07 PM in Houston.
    expect(formatPhotoStamp('2026-09-14T18:22:07.000Z', 'DEVICE_CLOCK')).toBe(
      'Sep 14, 2026, 1:22:07 PM CDT',
    );
  });

  it('uses standard time in winter', () => {
    expect(formatPhotoStamp('2026-01-15T15:05:00.000Z', 'REPORT_STAMP')).toBe(
      'Jan 15, 2026, 9:05:00 AM CST',
    );
  });

  it('says when the time is only when the server received the photo', () => {
    expect(formatPhotoStamp('2026-09-14T18:22:07.000Z', 'SERVER_RECEIPT')).toBe(
      'Received Sep 14, 2026, 1:22:07 PM CDT',
    );
  });

  it('prints nothing for a time whose provenance is unknown, rather than a guess', () => {
    expect(formatPhotoStamp('2026-09-14T18:22:07.000Z', null)).toBeNull();
    expect(formatPhotoStamp('not a date', 'DEVICE_CLOCK')).toBeNull();
  });
});

describe('reading an imported report photo stamp', () => {
  it('reads it as Texas wall-clock time, not as UTC', () => {
    // The importer's `new Date(...)` stored this as 13:15:39Z on the server,
    // five hours early; the camera meant 1:15:39 PM in Texas.
    expect(parseReportPhotoStamp('Sep 02 2026 01:15:39 PM')?.toISOString()).toBe(
      '2026-09-02T18:15:39.000Z',
    );
  });

  it('knows winter from summer', () => {
    expect(parseReportPhotoStamp('Jan 15 2026 09:05:00 AM')?.toISOString()).toBe(
      '2026-01-15T15:05:00.000Z',
    );
  });

  it('reads midnight and noon the way a 12-hour clock means them', () => {
    expect(parseReportPhotoStamp('Sep 02 2026 12:00:00 AM')?.toISOString()).toBe(
      '2026-09-02T05:00:00.000Z',
    );
    expect(parseReportPhotoStamp('Sep 02 2026 12:30:00 PM')?.toISOString()).toBe(
      '2026-09-02T17:30:00.000Z',
    );
  });

  it('takes the earlier instant in the hour the clocks go back', () => {
    // 1:30 AM happens twice on Nov 1, 2026: first in CDT.
    expect(parseReportPhotoStamp('Nov 01 2026 01:30:00 AM')?.toISOString()).toBe(
      '2026-11-01T06:30:00.000Z',
    );
  });

  it('refuses anything that is not a real time', () => {
    expect(parseReportPhotoStamp('Sep 02 2026 13:15:39 PM')).toBeNull();
    expect(parseReportPhotoStamp('Feb 30 2026 10:00:00 AM')).toBeNull();
    expect(parseReportPhotoStamp('Sept 02 2026 01:15:39 PM')).toBeNull();
    expect(parseReportPhotoStamp(null)).toBeNull();
  });
});

describe('zone arithmetic', () => {
  it('knows Texas is five hours behind UTC in summer and six in winter', () => {
    expect(utcOffsetMinutes(new Date('2026-07-01T12:00:00Z'))).toBe(-300);
    expect(utcOffsetMinutes(new Date('2026-12-01T12:00:00Z'))).toBe(-360);
  });

  it('turns a wall-clock time in another zone into its instant', () => {
    expect(
      wallClockToInstant(
        { year: 2026, month: 9, day: 2, hour: 13, minute: 15, second: 39 },
        'Asia/Manila',
      ).toISOString(),
    ).toBe('2026-09-02T05:15:39.000Z');
  });
});
