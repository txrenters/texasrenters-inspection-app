import { describe, expect, it } from 'vitest';

import { businessToday } from './clock';
import { isOverdue, localToday } from './overdue';

/**
 * What day it is, for a business that works in Texas and is read from Manila.
 *
 * The console used to ask the browser. That is correct only when the reader
 * shares the field's calendar day, and the office is thirteen or fourteen hours
 * ahead — so an evening in Manila is already tomorrow in Texas. The technician
 * map showed the next day's assignments and an empty roster, and the overdue
 * flag marked a whole day of work late before anybody had started it.
 *
 * Fixed instants throughout. A test that asked what day it is now would pass or
 * fail depending on when it ran, which is the same class of bug.
 */

describe('the business day', () => {
  it('is still yesterday in Texas while Manila has moved on', () => {
    // 01:15 on the 9th in Manila is 12:15 on the *8th* in Texas. This is the
    // exact case reported: the map read "Wed, September 9" while the field was
    // still working the 8th.
    expect(businessToday(new Date('2026-09-08T17:15:00.000Z'))).toBe('2026-09-08');
  });

  it('does not roll over on a Texas evening, as UTC would', () => {
    // 19:00 Texas on the 8th is already the 9th in UTC. `toISOString` here
    // would call an evening tomorrow — the bug the previous implementation was
    // written to avoid, and which this must not reintroduce.
    expect(businessToday(new Date('2026-09-09T00:00:00.000Z'))).toBe('2026-09-08');
  });

  it('rolls over when Texas actually reaches midnight', () => {
    // 00:30 on the 9th in Texas is 05:30 UTC.
    expect(businessToday(new Date('2026-09-09T05:30:00.000Z'))).toBe('2026-09-09');
  });

  it('follows daylight saving rather than a fixed offset', () => {
    // In January, Texas is UTC-6 rather than UTC-5. 05:30 UTC is 23:30 on the
    // *previous* day — a hardcoded offset would be wrong for half the year.
    expect(businessToday(new Date('2026-01-09T05:30:00.000Z'))).toBe('2026-01-08');
  });

  it('is what the overdue check uses too', () => {
    // One definition of "today", not two that can drift. Overdue is the more
    // damaging of the two: it labels a technician's work late.
    expect(localToday).toBe(businessToday);
  });

  it('does not call today’s work overdue because Manila has turned over', () => {
    // An inspection scheduled for the 8th, read at 01:15 Manila on the 9th.
    // With the browser's day this was overdue; with the business day it is
    // simply today's work.
    const nowInManilaTomorrow = new Date('2026-09-08T17:15:00.000Z');
    expect(
      isOverdue({
        isCurrent: true,
        scheduledAt: '2026-09-08T00:00:00.000Z',
        status: 'SCHEDULED',
        today: businessToday(nowInManilaTomorrow),
      }),
    ).toBe(false);
  });

  it('still calls genuinely late work overdue', () => {
    // The guard against fixing the false positive by never flagging anything.
    expect(
      isOverdue({
        isCurrent: true,
        scheduledAt: '2026-09-01T00:00:00.000Z',
        status: 'SCHEDULED',
        today: businessToday(new Date('2026-09-08T17:15:00.000Z')),
      }),
    ).toBe(true);
  });
});
