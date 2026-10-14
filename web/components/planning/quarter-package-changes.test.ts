import { describe, expect, it } from 'vitest';

import { eventSource, eventText, placeText, quarterChangesSummary, stillVisitedThisQuarter } from './quarter-package-changes';

/** The words for the benefit package's changes as a quarter sees them (2026-10-15). */

const place = (extra: Partial<Parameters<typeof placeText>[0]> = {}) => ({
  status: 'PLANNED',
  scheduledOn: '2026-11-04',
  technician: 'Sam Tech',
  group: null,
  ...extra,
});

describe('where a visit sits in a quarter', () => {
  it('gives its day and technician', () => {
    expect(placeText(place())).toBe('Nov 4 · Sam Tech');
    expect(placeText(place({ technician: null }))).toBe('Nov 4');
  });

  it('says a visit was taken out, or has no day yet', () => {
    expect(placeText(place({ status: 'EXCLUDED', scheduledOn: null }))).toBe('taken out of the plan');
    expect(placeText(place({ status: 'UNSCHEDULED', scheduledOn: null }))).toBe('in Jobber with no day');
    expect(placeText(place({ status: 'BLOCKED', scheduledOn: null }))).toBe('no day yet');
  });

  it('counts any visit not taken out as still going ahead', () => {
    expect(stillVisitedThisQuarter(place({ status: 'PUBLISHED' }))).toBe(true);
    expect(stillVisitedThisQuarter(place({ status: 'EXCLUDED' }))).toBe(false);
    expect(stillVisitedThisQuarter(null)).toBe(false);
  });
});

describe('the summary line', () => {
  it('counts who left and who is new since the quarter compared with', () => {
    const one = {} as never;
    expect(quarterChangesSummary({ left: [one, one], joined: [one] }, 'Q3 2026')).toBe('2 left the package · 1 new since Q3 2026');
    expect(quarterChangesSummary({ left: [one], joined: [] }, null)).toBe('1 left the package');
    expect(quarterChangesSummary({ left: [], joined: [] }, 'Q3 2026')).toBeNull();
  });
});

describe('a line of the history', () => {
  it('says what happened, and why for a leave', () => {
    expect(eventText({ kind: 'JOINED', reason: null, detail: null })).toBe('Joined');
    expect(eventText({ kind: 'LEFT', reason: 'NOT_ENROLLED', detail: 'No' })).toBe('Left: not enrolled on the tenant report: it says No');
    expect(eventText({ kind: 'LEFT', reason: null, detail: null })).toBe('Left: no tenancy is placed there any more');
  });

  it('says where it came from, and who for the office', () => {
    expect(eventSource({ source: 'TENANT_REPORT', by: null })).toBe('Tenant report');
    expect(eventSource({ source: 'OFFICE', by: 'Erika' })).toBe('Office, Erika');
    expect(eventSource({ source: 'OFFICE', by: null })).toBe('Office');
  });
});
