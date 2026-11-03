import type { Logger } from '@nestjs/common';

/**
 * How much of a billed provider one day may spend.
 *
 * The invoice that asked for it: Mapbox, $764 for October 2026, nearly all of
 * it one day -- 384,009 matrix elements on 15 October, from a panel the Group
 * maker read again after every edit. Nothing said so until the bill came. So
 * every client a request can spend money through keeps a ceiling per day:
 * Mapbox (matrix elements, directions), Google Routes (matrix elements, day
 * routes, navigation legs) and Google Geocoding. Past one, the client answers
 * as if the provider were unavailable, and each caller already falls back to
 * something free -- a straight line, OSRM, the Census geocoder -- rather than
 * to the next provider that bills.
 *
 * Counted in UTC, the day Mapbox's and Google's own usage pages count in. The
 * count is this process's and starts again when it restarts: it bounds a
 * runaway, it is not a meter.
 */
export class DailyAllowance {
  private day = '';
  private spent = 0;
  private refused = false;

  constructor(
    readonly name: string,
    readonly ceiling: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Whether `amount` more stays within today's ceiling. */
  fits(amount: number): boolean {
    this.roll();
    return this.spent + amount <= this.ceiling;
  }

  spend(amount: number): void {
    this.roll();
    this.spent += amount;
  }

  /** Notes a refusal. True only for the day's first, which is the one worth a log line. */
  refuse(): boolean {
    this.roll();
    const first = !this.refused;
    this.refused = true;
    return first;
  }

  private roll() {
    const day = this.now().toISOString().slice(0, 10);
    if (day === this.day) return;
    this.day = day;
    this.spent = 0;
    this.refused = false;
  }
}

/** A whole number from the environment, else the default: an empty value is not zero. */
export function ceilingFrom(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

/**
 * Spends `amount` from every allowance given, or from none when any of them is
 * short, saying so once a day per allowance. Counted when asked rather than
 * when answered: a provider bills the request.
 */
export function spendFrom(amount: number, allowances: readonly DailyAllowance[], logger: Logger): boolean {
  const short = allowances.find((allowance) => !allowance.fits(amount));
  if (short) {
    if (short.refuse())
      logger.warn({ event: 'daily_allowance_reached', allowance: short.name, ceiling: short.ceiling });
    return false;
  }
  for (const allowance of allowances) allowance.spend(amount);
  return true;
}
