/**
 * How much of a billed provider this browser may spend in one day.
 *
 * The server's Mapbox calls have had a ceiling a day since October's $764
 * invoice (`DailyAllowance` in the backend). The console asks Mapbox too, from
 * the browser, with the public token: road routes for the Groups map
 * (Directions) and the fastest order of a group's stops (Matrix). Those never
 * pass the server, so its ceiling never saw them. This is the same rule, here:
 * past the day's amount, the caller answers without Mapbox -- straight lines, a
 * straight-line order -- rather than paying for more.
 *
 * Kept per browser, per UTC day (the day Mapbox counts in), in this browser's
 * storage so a reload does not reset it. It bounds a runaway, it is not a
 * meter: another browser, or cleared storage, starts again from nothing.
 */

export interface Allowance {
  /** Whether `amount` more stays within today's ceiling. */
  fits(amount: number): boolean;
  spend(amount: number): void;
}

type Store = Pick<Storage, 'getItem' | 'setItem'> | null;

const KEY_PREFIX = 'texasrenters:daily-allowance:';

/** This browser's storage, or none where it is blocked (a private window, a test). */
function browserStorage(): Store {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function createAllowance(
  name: string,
  ceiling: number,
  options: { storage?: Store; now?: () => Date } = {},
): Allowance {
  const storage = options.storage === undefined ? browserStorage() : options.storage;
  const now = options.now ?? (() => new Date());
  const key = KEY_PREFIX + name;
  // When there is no storage, the count lives as long as the page does.
  let memory = { day: '', spent: 0 };

  const read = (): { day: string; spent: number } => {
    const today = now().toISOString().slice(0, 10);
    let saved = memory;
    try {
      const raw = storage?.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw) as { day?: unknown; spent?: unknown };
        if (typeof parsed.day === 'string' && typeof parsed.spent === 'number') saved = { day: parsed.day, spent: parsed.spent };
      }
    } catch {
      // A count that cannot be read starts the day again.
    }
    return saved.day === today ? saved : { day: today, spent: 0 };
  };

  return {
    fits: (amount) => read().spent + amount <= ceiling,
    spend: (amount) => {
      const current = read();
      memory = { day: current.day, spent: current.spent + amount };
      try {
        storage?.setItem(key, JSON.stringify(memory));
      } catch {
        // Storage full or blocked: the in-memory count still holds for this page.
      }
    },
  };
}

/**
 * Matrix elements (one per pair of stops) one browser may ask for in a day.
 *
 * Building a 13-stop day costs about 170 elements now that only new pairs are
 * asked for, so this is some sixty groups a day from one browser -- a whole
 * quarter drawn from nothing. Mapbox's free tier is 100,000 a month.
 */
export const BROWSER_MATRIX_ELEMENTS_A_DAY = 10_000;

/**
 * Directions requests (one road route, up to 25 stops) one browser may make in
 * a day. A group is asked for once per change of its stops, and kept; a file
 * of forty groups opened fresh is forty. Mapbox's free tier is 100,000 a month.
 */
export const BROWSER_DIRECTIONS_A_DAY = 1_500;
