import type { JobberDayRow, RescheduleRequestView } from '@texasrenters/shared';
import { describe, expect, it } from 'vitest';

import {
  firstName,
  greetingFor,
  overdueCutoff,
  overdueQuery,
  rescheduleBreakdown,
  todayBuckets,
} from './home-workflow';

const row = (over: Partial<JobberDayRow>): JobberDayRow =>
  ({
    key: over.inspectionId ?? 'jobber:1',
    inspectionId: 'insp-1',
    status: 'SCHEDULED',
    property: '1 Elm',
    state: 'MATCHES',
    ...over,
  }) as JobberDayRow;

describe('the greeting', () => {
  it('follows the reader’s clock', () => {
    expect(greetingFor(8)).toBe('Good morning');
    expect(greetingFor(13)).toBe('Good afternoon');
    expect(greetingFor(19)).toBe('Good evening');
  });

  it('uses the first name, and nothing for no name', () => {
    expect(firstName('  Ada Lane ')).toBe('Ada');
    expect(firstName('')).toBeNull();
    expect(firstName(undefined)).toBeNull();
  });
});

describe('today’s visits', () => {
  it('groups them as Jobber’s Home does, leaving cancelled ones out', () => {
    const buckets = todayBuckets([
      row({ inspectionId: 'a', status: 'IN_PROGRESS' }),
      row({ inspectionId: 'b', status: 'SCHEDULED' }),
      row({ inspectionId: 'c', status: 'COMPLETED' }),
      row({ inspectionId: 'd', status: 'CANCELLED' }),
      row({ inspectionId: null, key: 'jobber:9', status: null, state: 'ONLY_IN_JOBBER' }),
    ]);
    expect(buckets.active.map((entry) => entry.key)).toEqual(['a']);
    // A visit only Jobber has is still work on the day.
    expect(buckets.remaining.map((entry) => entry.key)).toEqual(['b', 'jobber:9']);
    expect(buckets.done.map((entry) => entry.key)).toEqual(['c']);
  });
});

describe('overdue', () => {
  /**
   * `scheduledAt` is a date compared by its UTC date. Yesterday's UTC midnight
   * is yesterday; a Texas end-of-day instant would be today and file the
   * whole day as overdue.
   */
  it('stops at yesterday, sent as yesterday’s UTC midnight', () => {
    expect(overdueCutoff('2026-11-03')).toBe('2026-11-02T00:00:00.000Z');
    expect(overdueCutoff('2026-11-01')).toBe('2026-10-31T00:00:00.000Z');
  });

  it('asks for booked-and-never-started visits, the most recent first', () => {
    expect(overdueQuery('2026-11-03')).toEqual({
      status: 'SCHEDULED',
      scheduledTo: '2026-11-02T00:00:00.000Z',
      scheduledOrder: 'desc',
      page: 1,
      pageSize: 8,
    });
  });
});

describe('the reschedule card', () => {
  it('counts the open requests by why they were asked', () => {
    const asked = (kind: RescheduleRequestView['kind']) => ({ kind }) as RescheduleRequestView;
    expect(rescheduleBreakdown([asked('NO_ACCESS'), asked('NO_ACCESS'), asked('BEFORE_VISIT')])).toEqual({
      BEFORE_VISIT: 1,
      NO_ACCESS: 2,
      SERVICES_NOT_DONE: 0,
    });
  });
});
