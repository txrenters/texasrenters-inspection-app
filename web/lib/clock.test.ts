import { describe, expect, it } from 'vitest';

import { CLOCK_ZONES, msUntilNextMinute, readClock } from './clock';

const manila = CLOCK_ZONES.find((zone) => zone.id === 'manila')!;
const texas = CLOCK_ZONES.find((zone) => zone.id === 'texas')!;

describe('readClock', () => {
  it('shows each office its own wall-clock time from one instant', () => {
    // 2026-07-31 01:40 UTC. Manila is UTC+8, Texas is on CDT (UTC-5).
    const now = new Date('2026-07-30T17:40:00Z');
    expect(readClock(now, manila).time).toBe('1:40 AM');
    expect(readClock(now, texas).time).toBe('12:40 PM');
  });

  it('shows a different calendar day for each office when they straddle midnight', () => {
    // The reason two clocks exist: scheduling across this gap by eye is where
    // people get the day wrong.
    const now = new Date('2026-07-30T17:40:00Z');
    expect(readClock(now, manila).date).toBe('Fri, Jul 31');
    expect(readClock(now, texas).date).toBe('Thu, Jul 30');
  });

  it('follows Texas daylight saving instead of a fixed offset', () => {
    // Both instants are noon in Texas, but they are an hour apart in UTC —
    // which is exactly what a hardcoded offset would get wrong for half the year.
    const winter = new Date('2026-01-15T18:00:00Z'); // CST, UTC-6
    const summer = new Date('2026-07-15T17:00:00Z'); // CDT, UTC-5
    expect(readClock(winter, texas).time).toBe('12:00 PM');
    expect(readClock(summer, texas).time).toBe('12:00 PM');
    expect(readClock(winter, texas).abbreviation).toBe('CST');
    expect(readClock(summer, texas).abbreviation).toBe('CDT');
  });

  it('keeps Manila fixed across the same two instants, because it has no DST', () => {
    const winter = new Date('2026-01-15T04:00:00Z');
    const summer = new Date('2026-07-15T04:00:00Z');
    expect(readClock(winter, manila).time).toBe('12:00 PM');
    expect(readClock(summer, manila).time).toBe('12:00 PM');
  });

  it('narrows the gap to 13 hours in Texas summer and widens it to 14 in winter', () => {
    const summer = new Date('2026-07-15T00:00:00Z');
    const winter = new Date('2026-01-15T00:00:00Z');
    // Manila 8:00 AM vs Texas 7:00 PM the previous day = 13 hours.
    expect(readClock(summer, manila).time).toBe('8:00 AM');
    expect(readClock(summer, texas).time).toBe('7:00 PM');
    // Manila 8:00 AM vs Texas 6:00 PM the previous day = 14 hours.
    expect(readClock(winter, manila).time).toBe('8:00 AM');
    expect(readClock(winter, texas).time).toBe('6:00 PM');
  });

  it('builds a spoken description that names the place, not just an abbreviation', () => {
    const description = readClock(new Date('2026-07-30T17:40:00Z'), texas).description;
    expect(description).toContain('Texas, United States');
    expect(description).toContain('12:40 PM');
    expect(description).toContain('Thu, Jul 30');
  });

  it('handles midnight without rendering it as 0 or 24', () => {
    const midnightManila = new Date('2026-07-30T16:00:00Z');
    expect(readClock(midnightManila, manila).time).toBe('12:00 AM');
  });
});

describe('msUntilNextMinute', () => {
  it('waits a full minute when exactly on a boundary', () => {
    expect(msUntilNextMinute(new Date('2026-07-30T17:40:00.000Z'))).toBe(60_000);
  });

  it('waits only the remainder mid-minute', () => {
    expect(msUntilNextMinute(new Date('2026-07-30T17:40:59.500Z'))).toBe(500);
  });

  it('never returns zero, which would spin the timer', () => {
    for (const ms of [0, 1, 30_000, 59_999]) {
      const value = msUntilNextMinute(new Date(1_800_000_000_000 + ms));
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThanOrEqual(60_000);
    }
  });
});
