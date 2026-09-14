import { describe, expect, it } from 'vitest';

import { describeOrigin } from './route-plan';

/**
 * A route from somebody's house and a route from where they are standing are
 * different claims, and the roster says which it is drawing.
 */

const route = (over: Record<string, unknown>) =>
  ({
    technicianId: 't',
    origin: { latitude: 29.9, longitude: -95.5, recordedAt: null },
    originKind: null,
    stops: [],
    legs: [],
    ...over,
  }) as never;

describe('where a route starts, in words', () => {
  it('says a live position is live', () => {
    expect(describeOrigin(route({ originKind: 'LIVE' }))).toBe('from their live position');
  });

  it('says a home start is home', () => {
    expect(describeOrigin(route({ originKind: 'HOME' }))).toBe('from home');
  });

  it('gives the last-seen time in Texas, not wherever the reader is', () => {
    // 19:14 UTC is 2:14pm in Texas in September (CDT). The office reading this
    // is often in Manila, where the same instant is 3:14am the next day.
    const text = describeOrigin(
      route({
        originKind: 'LAST_KNOWN',
        origin: { latitude: 29.9, longitude: -95.5, recordedAt: '2026-09-14T19:14:00.000Z' },
      }),
    );
    expect(text).toBe('from where they were last seen at 2:14 PM');
  });

  it('still says last seen when the time is unreadable', () => {
    const text = describeOrigin(
      route({
        originKind: 'LAST_KNOWN',
        origin: { latitude: 29.9, longitude: -95.5, recordedAt: 'not a date' },
      }),
    );
    expect(text).toBe('from where they were last seen');
  });

  it('says nothing when there is no origin to describe', () => {
    expect(describeOrigin(route({ originKind: null }))).toBeNull();
  });
});
