import { describe, expect, it } from 'vitest';

import {
  LEASE_EXPIRING_SOON_DAYS,
  daysUntilLeaseEnd,
  leaseExpiryLabel,
  leaseExpiryStatus,
} from '../src/index.js';

const NOW = new Date('2026-07-28T18:30:00.000Z');

describe('lease expiry', () => {
  it('counts whole days regardless of time of day', () => {
    // Late in the day "now" against a midnight lease date must still be 1 day,
    // not 0 — both sides are floored to UTC midnight.
    expect(daysUntilLeaseEnd('2026-07-29', NOW)).toBe(1);
    expect(daysUntilLeaseEnd('2026-07-28', NOW)).toBe(0);
    expect(daysUntilLeaseEnd('2026-07-27', NOW)).toBe(-1);
  });

  it('treats the horizon boundary as still expiring soon', () => {
    const onBoundary = new Date(NOW);
    onBoundary.setUTCDate(onBoundary.getUTCDate() + LEASE_EXPIRING_SOON_DAYS);
    const justOutside = new Date(NOW);
    justOutside.setUTCDate(justOutside.getUTCDate() + LEASE_EXPIRING_SOON_DAYS + 1);

    expect(leaseExpiryStatus(onBoundary, NOW)).toBe('EXPIRING_SOON');
    expect(leaseExpiryStatus(justOutside, NOW)).toBe('ACTIVE');
  });

  it('separates expired, expiring, active, and unknown', () => {
    expect(leaseExpiryStatus('2026-07-27', NOW)).toBe('EXPIRED');
    expect(leaseExpiryStatus('2026-08-15', NOW)).toBe('EXPIRING_SOON');
    expect(leaseExpiryStatus('2027-07-28', NOW)).toBe('ACTIVE');
    expect(leaseExpiryStatus(null, NOW)).toBe('UNKNOWN');
    expect(leaseExpiryStatus('not-a-date', NOW)).toBe('UNKNOWN');
  });

  it('phrases the label for a reader rather than echoing a number', () => {
    expect(leaseExpiryLabel('2026-07-28', NOW)).toBe('Ends today');
    expect(leaseExpiryLabel('2026-07-29', NOW)).toBe('Ends in 1 day');
    expect(leaseExpiryLabel('2026-08-07', NOW)).toBe('Ends in 10 days');
    expect(leaseExpiryLabel('2026-07-27', NOW)).toBe('Ended 1 day ago');
    expect(leaseExpiryLabel(null, NOW)).toBe('No end date');
  });
});
