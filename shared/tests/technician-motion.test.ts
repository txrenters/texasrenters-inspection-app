import { describe, expect, it } from 'vitest';

import {
  isMoving,
  MOVING_SPEED_MS,
  normaliseMotion,
} from '../src/contracts/technician-location.js';

/**
 * Course and speed, and the one value that ruins both.
 *
 * iOS and Android report `-1` from `coords.heading` and `coords.speed` when a
 * fix carries neither — a phone standing still, or one whose first fix came
 * from a cell tower. Taken at face value that is a heading of minus one degree
 * and a speed of minus one metre per second: an arrow pointing very slightly
 * west of north on somebody standing in a kitchen, and a trail claiming they
 * reversed there.
 */

describe('reading course and speed off a handset', () => {
  it('treats the platforms\u2019 -1 as "no answer", not as a value', () => {
    expect(normaliseMotion({ headingDegrees: -1, speedMetersPerSecond: -1 })).toEqual({
      headingDegrees: null,
      speedMetersPerSecond: null,
    });
  });

  it('keeps a genuine zero, which is not the same claim', () => {
    // Zero degrees is due north and zero m/s is genuinely stationary. Folding
    // either into null would discard a real reading.
    expect(normaliseMotion({ headingDegrees: 0, speedMetersPerSecond: 0 })).toEqual({
      headingDegrees: 0,
      speedMetersPerSecond: 0,
    });
  });

  it('accepts 360 as north rather than rejecting it', () => {
    // Devices report both 0 and 360 for north, and a bound of `< 360` would
    // drop the heading on a fix that is otherwise perfectly good.
    expect(normaliseMotion({ headingDegrees: 360 }).headingDegrees).toBe(0);
  });

  it('says nothing when the keys are absent', () => {
    // A queue written by a build older than this feature has neither key.
    expect(normaliseMotion({})).toEqual({ headingDegrees: null, speedMetersPerSecond: null });
  });

  it.each([[Number.NaN], [Number.POSITIVE_INFINITY]])('refuses %p', (value) => {
    expect(normaliseMotion({ headingDegrees: value, speedMetersPerSecond: value })).toEqual({
      headingDegrees: null,
      speedMetersPerSecond: null,
    });
  });
});

describe('whether to draw somebody as travelling', () => {
  it('is moving at driving speed', () => {
    expect(isMoving({ headingDegrees: 90, speedMetersPerSecond: 13 })).toBe(true);
  });

  it('is not moving below the jitter floor', () => {
    /**
     * The reason the floor exists. GPS noise alone shifts a stationary phone a
     * few metres between fixes, which the device reports as a low speed in a
     * random direction — so without this the arrow on a parked marker spins.
     */
    expect(isMoving({ headingDegrees: 90, speedMetersPerSecond: MOVING_SPEED_MS - 0.01 })).toBe(
      false,
    );
    expect(isMoving({ headingDegrees: 90, speedMetersPerSecond: MOVING_SPEED_MS })).toBe(true);
  });

  it('is not moving without a heading to draw', () => {
    // Speed alone cannot orient an arrow, and one pointing at a default would
    // be inventing a direction.
    expect(isMoving({ headingDegrees: null, speedMetersPerSecond: 20 })).toBe(false);
  });

  it('is not moving when the device said -1 for both', () => {
    expect(isMoving({ headingDegrees: -1, speedMetersPerSecond: -1 })).toBe(false);
  });
});
