import { describe, expect, it } from 'vitest';

import {
  MAX_CLOCK_SKEW_MS,
  MAX_USEFUL_ACCURACY_M,
  rejectLocationFix,
  usableLocationFixes,
} from '../src/contracts/technician-location.js';

const NOW = Date.parse('2026-08-26T12:00:00.000Z');
const fix = (over: Partial<Parameters<typeof rejectLocationFix>[0]> = {}) => ({
  latitude: 30.2672,
  longitude: -97.7431,
  recordedAt: '2026-08-26T11:59:00.000Z',
  ...over,
});

describe('which position reports are worth storing', () => {
  it('accepts an ordinary fix', () => {
    expect(rejectLocationFix(fix(), NOW)).toBeNull();
  });

  /**
   * Austin is -97.7431. The floor-plan markers next door are `Decimal(6,5)`,
   * which holds one integer digit — a longitude does not fit in that column at
   * all, which is why this data needed its own type rather than reusing theirs.
   */
  it('accepts a longitude that would not fit the floor-plan marker columns', () => {
    expect(rejectLocationFix(fix({ longitude: -97.7431 }), NOW)).toBeNull();
    expect(rejectLocationFix(fix({ longitude: 179.999999 }), NOW)).toBeNull();
  });

  it('refuses coordinates that are not places', () => {
    expect(rejectLocationFix(fix({ latitude: 91 }), NOW)).toBe('IMPOSSIBLE_COORDINATE');
    expect(rejectLocationFix(fix({ longitude: -181 }), NOW)).toBe('IMPOSSIBLE_COORDINATE');
    expect(rejectLocationFix(fix({ latitude: Number.NaN }), NOW)).toBe('IMPOSSIBLE_COORDINATE');
  });

  it('tolerates a little clock drift but not a wrong clock', () => {
    // Drift is ordinary. A fix minutes ahead is a misconfigured phone, and
    // storing it would put a point in the trail before the technician arrived.
    const drifting = new Date(NOW + MAX_CLOCK_SKEW_MS - 1_000).toISOString();
    const wrong = new Date(NOW + MAX_CLOCK_SKEW_MS + 60_000).toISOString();
    expect(rejectLocationFix(fix({ recordedAt: drifting }), NOW)).toBeNull();
    expect(rejectLocationFix(fix({ recordedAt: wrong }), NOW)).toBe('FUTURE_TIMESTAMP');
  });

  it('refuses a timestamp it cannot read', () => {
    expect(rejectLocationFix(fix({ recordedAt: 'yesterday' }), NOW)).toBe('UNREADABLE_TIMESTAMP');
  });

  it('drops a fix too coarse to mean anything', () => {
    // A phone with no satellites reports the cell tower. Drawing kilometres of
    // uncertainty as a position is the map claiming something nobody knows.
    expect(rejectLocationFix(fix({ accuracyMeters: MAX_USEFUL_ACCURACY_M + 1 }), NOW)).toBe(
      'TOO_IMPRECISE',
    );
    expect(rejectLocationFix(fix({ accuracyMeters: MAX_USEFUL_ACCURACY_M }), NOW)).toBeNull();
  });

  it('accepts a device that does not report accuracy at all', () => {
    // Refusing these would silently exclude whole handset models.
    expect(rejectLocationFix(fix({ accuracyMeters: null }), NOW)).toBeNull();
    expect(rejectLocationFix(fix({ accuracyMeters: undefined }), NOW)).toBeNull();
  });
});

describe('preparing a batch', () => {
  it('keeps the usable fixes and orders them by when they were taken', () => {
    // A queue drained after an outage arrives in whatever order it was stored;
    // ordering by arrival would draw the route backwards.
    const later = fix({ recordedAt: '2026-08-26T11:59:00.000Z' });
    const earlier = fix({ recordedAt: '2026-08-26T11:50:00.000Z' });
    const bad = fix({ latitude: 999 });

    expect(usableLocationFixes([later, bad, earlier], NOW).map((item) => item.recordedAt)).toEqual([
      earlier.recordedAt,
      later.recordedAt,
    ]);
  });
});
