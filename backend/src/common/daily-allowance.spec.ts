import type { Logger } from '@nestjs/common';

import { ceilingFrom, DailyAllowance, spendFrom } from './daily-allowance';

/**
 * The ceiling on what one day may ask a billed provider for.
 *
 * The invoice that asked for it: Mapbox, $764 for October 2026, nearly all of
 * it 384,009 matrix elements on 15 October, from the Group maker's suggestions.
 * Every other day of the month fitted in the free allowance.
 */
describe('a day of a billed provider, counted', () => {
  it('spends up to the ceiling and refuses past it', () => {
    const today = new DailyAllowance('matrix', 250, () => new Date('2026-10-15T12:00:00Z'));

    expect(today.fits(121)).toBe(true);
    today.spend(121);
    expect(today.fits(121)).toBe(true);
    today.spend(121);
    // 242 spent: a third matrix of 121 would be 363.
    expect(today.fits(121)).toBe(false);
    expect(today.fits(8)).toBe(true);
  });

  /** UTC, the day Mapbox's own statistics page counts in, not Texas's. */
  it('starts again at midnight UTC', () => {
    let now = new Date('2026-10-15T23:59:00Z');
    const today = new DailyAllowance('matrix', 100, () => now);
    today.spend(100);
    expect(today.fits(1)).toBe(false);

    now = new Date('2026-10-16T00:00:00Z');
    expect(today.fits(100)).toBe(true);
  });

  it('says only the first refusal of a day is the first', () => {
    let now = new Date('2026-10-15T09:00:00Z');
    const today = new DailyAllowance('matrix', 0, () => now);

    expect(today.refuse()).toBe(true);
    expect(today.refuse()).toBe(false);
    now = new Date('2026-10-16T09:00:00Z');
    expect(today.refuse()).toBe(true);
  });
});

describe('spending from more than one allowance', () => {
  const logger = { warn: jest.fn() } as unknown as Logger;
  const at = () => new Date('2026-10-15T12:00:00Z');

  it('spends from all of them, or from none when one is short', () => {
    const all = new DailyAllowance('mapbox-matrix', 300, at);
    const share = new DailyAllowance('mapbox-optional-matrix', 100, at);

    expect(spendFrom(100, [all, share], logger)).toBe(true);
    expect(spendFrom(100, [all, share], logger)).toBe(false);
    // The refused hundred came out of neither: the whole day's allowance still has 200.
    expect(all.fits(200)).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith({ event: 'daily_allowance_reached', allowance: 'mapbox-optional-matrix', ceiling: 100 });
  });
});

describe('a ceiling from the environment', () => {
  const saved = process.env.TEST_DAILY_CEILING;
  afterEach(() => {
    if (saved === undefined) delete process.env.TEST_DAILY_CEILING;
    else process.env.TEST_DAILY_CEILING = saved;
  });

  it('reads a whole number, including zero', () => {
    process.env.TEST_DAILY_CEILING = ' 0 ';
    expect(ceilingFrom('TEST_DAILY_CEILING', 30)).toBe(0);
    process.env.TEST_DAILY_CEILING = '12000';
    expect(ceilingFrom('TEST_DAILY_CEILING', 30)).toBe(12_000);
  });

  /** An empty line in the env file is not a ceiling of zero, which would switch the provider off. */
  it('keeps the default for a missing, empty or unreadable value', () => {
    delete process.env.TEST_DAILY_CEILING;
    expect(ceilingFrom('TEST_DAILY_CEILING', 30)).toBe(30);
    for (const value of ['', '   ', 'lots', '-5', '1.5']) {
      process.env.TEST_DAILY_CEILING = value;
      expect(ceilingFrom('TEST_DAILY_CEILING', 30)).toBe(30);
    }
  });
});
