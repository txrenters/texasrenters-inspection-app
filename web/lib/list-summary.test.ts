import { describe, expect, it } from 'vitest';

import { dayWindow, figureOf, listHref, trendOf } from './list-summary';

describe('trendOf', () => {
  it('says how much and which way, in whole percent', () => {
    expect(trendOf(129, 100)).toEqual({ percent: 29, direction: 'up' });
    expect(trendOf(50, 100)).toEqual({ percent: 50, direction: 'down' });
    expect(trendOf(100, 100)).toEqual({ percent: 0, direction: 'flat' });
  });

  it('has nothing to say without a period to compare against', () => {
    expect(trendOf(10, 0)).toBeNull();
    expect(trendOf(undefined, 10)).toBeNull();
    expect(trendOf(10, undefined)).toBeNull();
  });
});

describe('dayWindow', () => {
  /** `scheduledAt` is a date compared by its UTC date, so each end is a UTC midnight. */
  it('runs whole days, each end its UTC midnight', () => {
    expect(dayWindow('2026-11-03', -30, -1)).toEqual({
      scheduledFrom: '2026-10-04T00:00:00.000Z',
      scheduledTo: '2026-11-02T00:00:00.000Z',
    });
    expect(dayWindow('2026-11-03', 0, 29)).toEqual({
      scheduledFrom: '2026-11-03T00:00:00.000Z',
      scheduledTo: '2026-12-02T00:00:00.000Z',
    });
  });
});

describe('listHref', () => {
  it('keeps only the filters that are set', () => {
    expect(listHref('/inspections', { status: 'FOLLOW_UP', day: 'all', type: '' })).toBe(
      '/inspections?status=FOLLOW_UP&day=all',
    );
    expect(listHref('/properties', { occupancy: undefined })).toBe('/properties');
  });
});

describe('figureOf', () => {
  it('tells a count still being read from one that could not be read', () => {
    expect(figureOf({ data: { total: 4 }, isError: false })).toBe(4);
    expect(figureOf({ isError: false })).toBeUndefined();
    expect(figureOf({ isError: true })).toBeNull();
  });
});
