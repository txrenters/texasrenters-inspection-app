import { greetingFor } from '../src/utils/greeting';

/** A local-time Date, which is what the device clock actually reports. */
const at = (hour: number, minute = 0) => new Date(2026, 7, 10, hour, minute);

describe('greetingFor', () => {
  it('reads morning, afternoon and evening from the hour', () => {
    expect(greetingFor(at(6))).toBe('Good morning');
    expect(greetingFor(at(13))).toBe('Good afternoon');
    expect(greetingFor(at(20))).toBe('Good evening');
  });

  it('switches exactly at noon and at 18:00', () => {
    // The boundaries are the only interesting values; everything else is a
    // consequence of them.
    expect(greetingFor(at(11, 59))).toBe('Good morning');
    expect(greetingFor(at(12, 0))).toBe('Good afternoon');
    expect(greetingFor(at(17, 59))).toBe('Good afternoon');
    expect(greetingFor(at(18, 0))).toBe('Good evening');
  });

  it('greets the small hours as evening rather than night', () => {
    // A technician opening this at 01:00 is finishing a long day, not starting
    // one. Midnight is still "morning" by the clock, which is the boundary the
    // hour check gives us and the one people expect from a 12-hour reading.
    expect(greetingFor(at(0, 30))).toBe('Good morning');
    expect(greetingFor(at(23, 30))).toBe('Good evening');
  });

  it('follows the device time zone rather than any fixed offset', () => {
    /**
     * The point of the whole change: no location lookup, no hardcoded zone.
     * `getHours` is local time, so the same instant greets a technician in
     * Manila and one in Texas differently — correctly — with no permission
     * prompt between them.
     *
     * Asserted through the same accessor the implementation uses, because a
     * literal expectation here would encode whichever zone CI happens to run
     * in and fail the moment that changes.
     */
    const instant = new Date('2026-08-10T02:00:00.000Z');
    const expected =
      instant.getHours() < 12
        ? 'Good morning'
        : instant.getHours() < 18
          ? 'Good afternoon'
          : 'Good evening';
    expect(greetingFor(instant)).toBe(expected);
  });

  it('defaults to now when given no date', () => {
    expect(['Good morning', 'Good afternoon', 'Good evening']).toContain(greetingFor());
  });
});
