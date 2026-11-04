import { describe, expect, it } from 'vitest';

import { createAllowance } from './daily-allowance';

/**
 * A browser's day of a billed provider: the same ceiling the server keeps on
 * Mapbox since October's invoice, for the calls the console makes itself.
 */

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

describe('a browser’s daily allowance', () => {
  it('lets through what fits, and nothing past the ceiling', () => {
    const allowance = createAllowance('matrix', 100, { storage: null });

    expect(allowance.fits(100)).toBe(true);
    allowance.spend(60);
    expect(allowance.fits(40)).toBe(true);
    expect(allowance.fits(41)).toBe(false);
  });

  /** A reload is not a new day: the count is kept in this browser's storage. */
  it('remembers what was spent across a reload', () => {
    const storage = memoryStorage();
    createAllowance('matrix', 100, { storage }).spend(90);

    expect(createAllowance('matrix', 100, { storage }).fits(20)).toBe(false);
  });

  it('starts again the next day, by the UTC day Mapbox counts in', () => {
    const storage = memoryStorage();
    let now = new Date('2026-11-04T23:59:00.000Z');
    const allowance = createAllowance('matrix', 100, { storage, now: () => now });
    allowance.spend(100);
    expect(allowance.fits(1)).toBe(false);

    now = new Date('2026-11-05T00:01:00.000Z');
    expect(allowance.fits(100)).toBe(true);
  });

  it('keeps counting for the page when storage is blocked or full', () => {
    const allowance = createAllowance('matrix', 10, {
      storage: {
        getItem: () => {
          throw new Error('blocked');
        },
        setItem: () => {
          throw new Error('full');
        },
      },
    });
    allowance.spend(10);

    expect(allowance.fits(1)).toBe(false);
  });

  it('keeps each provider’s count apart', () => {
    const storage = memoryStorage();
    createAllowance('matrix', 10, { storage }).spend(10);

    expect(createAllowance('directions', 10, { storage }).fits(10)).toBe(true);
  });
});
