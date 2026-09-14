import { businessDate, businessDayBounds, businessDayFromQuery } from '../src/common/business-day';

/**
 * Which day it is, for people who are not where the server is.
 *
 * The work is in Texas. The office is often in Manila, thirteen or fourteen
 * hours ahead, and the server keeps UTC — three clocks, and only one of them is
 * the day a technician is driving around in.
 *
 * This was computed from UTC midnight, which is 6 or 7 p.m. Texas the *previous*
 * evening, so a technician's "today" already held tomorrow's work from dinner
 * time onwards.
 */

describe('the business day', () => {
  it('is still yesterday in Texas when it is already tomorrow in UTC', () => {
    /**
     * The bug, exactly. 03:00 UTC on 12 September is 10 p.m. on the 11th in
     * Texas — a technician's evening, not the next morning.
     */
    const lateEvening = new Date('2026-09-12T03:00:00.000Z');

    expect(businessDate(lateEvening)).toBe('2026-09-11');
  });

  it('bounds the day a technician would recognise', () => {
    const during = new Date('2026-09-11T18:00:00.000Z'); // 1 p.m. in Texas
    const { start, end } = businessDayBounds(during);

    // September is CDT, UTC−5, so the day runs 05:00 to 05:00.
    expect(start.toISOString()).toBe('2026-09-11T05:00:00.000Z');
    expect(end.toISOString()).toBe('2026-09-12T05:00:00.000Z');
    expect(start.getTime()).toBeLessThanOrEqual(during.getTime());
    expect(end.getTime()).toBeGreaterThan(during.getTime());
  });

  it('follows the offset into winter rather than assuming one', () => {
    // January is CST, UTC−6. A hard-coded −5 puts every winter query an hour
    // out, and a hard-coded −6 does the same all summer.
    const winter = new Date('2026-01-15T18:00:00.000Z');
    const { start } = businessDayBounds(winter);

    expect(start.toISOString()).toBe('2026-01-15T06:00:00.000Z');
  });

  it.each([
    ['spring forward', '2026-03-08T18:00:00.000Z', '2026-03-08T06:00:00.000Z'],
    ['fall back', '2026-11-01T18:00:00.000Z', '2026-11-01T05:00:00.000Z'],
  ])('gets midnight right on the %s day', (_label, at, expected) => {
    // The two days a year the offset changes. Midnight itself is never inside
    // the discontinuity in this zone — the clocks move at 2 a.m. — so the day
    // still starts where a technician would say it does.
    expect(businessDayBounds(new Date(at)).start.toISOString()).toBe(expected);
  });

  it('covers exactly twenty-four hours on an ordinary day', () => {
    const { start, end } = businessDayBounds(new Date('2026-06-15T12:00:00.000Z'));

    expect(end.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000);
  });
});

describe('a date asked for in a query', () => {
  it('is the Texas day it names, not the evening before', () => {
    /**
     * The bug. The console sends `?date=2026-09-14`, and `new Date()` reads a
     * bare date as UTC midnight -- 7 p.m. on the 13th in Texas -- so the
     * timeline opened on the 14th showed the 13th.
     */
    expect(businessDate(new Date('2026-09-14'))).toBe('2026-09-13');
    expect(businessDate(businessDayFromQuery('2026-09-14'))).toBe('2026-09-14');
  });

  it.each(['2026-01-15', '2026-03-08', '2026-11-01'])(
    'names the same day in winter and across the clock changes (%s)',
    (date) => {
      expect(businessDate(businessDayFromQuery(date))).toBe(date);
    },
  );

  it('takes a full timestamp as the instant it names', () => {
    const lateEvening = '2026-09-12T03:00:00.000Z';
    expect(businessDayFromQuery(lateEvening).toISOString()).toBe(lateEvening);
  });

  it('means now when there is no date, or nothing that reads as one', () => {
    const now = new Date('2026-09-14T17:00:00.000Z');
    expect(businessDayFromQuery(undefined, now)).toBe(now);
    expect(businessDayFromQuery('', now)).toBe(now);
    expect(businessDayFromQuery('not-a-date', now)).toBe(now);
  });
});
