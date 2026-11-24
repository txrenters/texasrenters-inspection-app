/**
 * Location is recorded and sent only in office hours (Monday to Friday, 7 AM to
 * 6 PM Texas time), so a test that reads the real clock passes at a desk in
 * Texas during the day and fails on CI at night or at the weekend.
 *
 * Call at the top of a test file that reaches the location code. `Date.now()`
 * then reads from a fixed weekday morning, shifted rather than frozen, so
 * anything measuring a gap between two readings still sees time pass.
 */

/** Tuesday 24 November 2026, 10 AM in Texas. */
export const OFFICE_HOURS_NOW = Date.parse('2026-11-24T16:00:00.000Z');

/** Sunday 22 November 2026, noon in Texas. */
export const WEEKEND_NOW = Date.parse('2026-11-22T18:00:00.000Z');

const realNow = Date.now.bind(Date);
let shift = 0;

/** Moves the clock to `at` for the rest of the current test, still running. */
export function setClock(at: number) {
  shift = at - realNow();
}

export function runClockInOfficeHours() {
  let spy: jest.SpyInstance<number, []> | null = null;
  beforeEach(() => {
    setClock(OFFICE_HOURS_NOW);
    spy = jest.spyOn(Date, 'now').mockImplementation(() => realNow() + shift);
  });
  afterEach(() => {
    spy?.mockRestore();
    spy = null;
  });
}
