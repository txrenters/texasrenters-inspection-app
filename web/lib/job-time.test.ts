import { describe, expect, it } from 'vitest';

import { inspectionTime, jobWorked } from './job-time';

/**
 * The technician's own clock, from Start job to submitting (the office,
 * 2026-09-18). Times read in Texas, because whoever is looking at this console
 * may not be.
 */

// 9:12 AM and 10:16 AM in Texas, in September, which is central daylight time.
const STARTED = '2026-09-18T14:12:00.000Z';
const SUBMITTED = '2026-09-18T15:16:00.000Z';

describe('how long a job took', () => {
  it('is the pair of stamps, read as Texas time', () => {
    expect(jobWorked({ startedAt: STARTED, submittedAt: SUBMITTED })).toEqual({
      worked: '1 hr 4 min',
      running: false,
      window: '9:12 AM – 10:16 AM',
    });
  });

  it('counts up to now while the technician is still out on it', () => {
    const worked = jobWorked({ startedAt: STARTED }, Date.parse('2026-09-18T14:45:00.000Z'));

    expect(worked).toEqual({ worked: '33 min', running: true, window: 'from 9:12 AM' });
  });

  it('is nothing at all for a job nobody has started', () => {
    expect(jobWorked({})).toBeNull();
    expect(jobWorked({ startedAt: null, submittedAt: null })).toBeNull();
    // A submission with no start is a record to fix, not a duration to show.
    expect(jobWorked({ submittedAt: SUBMITTED })).toBeNull();
  });

  it('never reports negative time from stamps that disagree', () => {
    expect(jobWorked({ startedAt: SUBMITTED, submittedAt: STARTED })?.worked).toBe('1 min');
  });

  it('ignores a stamp that is not a time', () => {
    expect(jobWorked({ startedAt: 'yesterday' })).toBeNull();
  });
});

describe('how long the inspection itself took', () => {
  it('is the span of its evidence, in the console’s own wording', () => {
    expect(inspectionTime({ from: '2026-09-18T14:20:00.000Z', to: '2026-09-18T14:58:00.000Z' })).toBe('38 min');
    expect(inspectionTime({ from: '2026-09-18T14:20:00.000Z', to: '2026-09-18T15:32:00.000Z' })).toBe('1 hr 12 min');
  });

  it('is nothing before there is a span to read', () => {
    expect(inspectionTime(null)).toBeNull();
    expect(inspectionTime({ from: '2026-09-18T14:20:00.000Z', to: '2026-09-18T14:20:00.000Z' })).toBeNull();
    expect(inspectionTime({ from: 'yesterday', to: '2026-09-18T14:20:00.000Z' })).toBeNull();
  });
});
