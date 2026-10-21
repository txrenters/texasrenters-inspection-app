import { describe, expect, it } from 'vitest';

import {
  chooseRouteOrigin,
  LIVE_POSITION_WITHIN_MS,
  OFFICE,
} from '../src/contracts/route-plan.js';

/**
 * Where a technician's day starts on the map.
 *
 * The previous rule was "the newest position, however old", which started
 * Monday's route from wherever a phone happened to be at four in the morning on
 * Saturday. The route should begin at the office until somebody sets off
 * (2026-10-22; it was their home), follow them once their handset is
 * reporting, and never snap back to the office just because a phone went quiet
 * inside a house.
 */

const DAY_START = new Date('2026-09-14T05:00:00.000Z'); // midnight in Texas
const NOW = Date.parse('2026-09-14T15:00:00.000Z'); // 10am in Texas
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
const fixAt = (recordedAt: string) => ({ latitude: 29.8, longitude: -95.4, recordedAt });

describe('where the route starts', () => {
  it('follows the technician while their handset is reporting', () => {
    const origin = chooseRouteOrigin(fixAt(minutesAgo(1)), DAY_START, NOW);
    expect(origin.kind).toBe('LIVE');
    expect(origin.point.latitude).toBe(29.8);
  });

  it('starts at the office before the first report of the day', () => {
    // Nothing yet today, so they have not set off.
    const origin = chooseRouteOrigin(null, DAY_START, NOW);
    expect(origin.kind).toBe('OFFICE');
    expect(origin.point).toMatchObject({ latitude: OFFICE.latitude, longitude: OFFICE.longitude });
  });

  it('does not start today from a position left over from another day', () => {
    /**
     * The bug this replaces. A fix from Saturday morning is a fact about
     * Saturday. Starting Monday's route from it would draw the day from
     * somewhere the technician has not been for two days.
     */
    const saturday = fixAt('2026-09-12T09:29:00.000Z');
    const origin = chooseRouteOrigin(saturday, DAY_START, NOW);
    expect(origin.kind).toBe('OFFICE');
    expect(origin.point.latitude).toBe(OFFICE.latitude);
  });

  it('keeps the last place they were seen when the phone goes quiet mid-day', () => {
    /**
     * The case that makes this three answers rather than two. A technician
     * inside a property with thick walls goes quiet for a while. They are not
     * at the office, and redrawing the rest of their day from there would be
     * confidently wrong.
     */
    const origin = chooseRouteOrigin(fixAt(minutesAgo(40)), DAY_START, NOW);
    expect(origin.kind).toBe('LAST_KNOWN');
    expect(origin.point.latitude).toBe(29.8);
  });

  it('draws the line between live and last known at the threshold', () => {
    const edge = LIVE_POSITION_WITHIN_MS / 60_000;
    expect(chooseRouteOrigin(fixAt(minutesAgo(edge)), DAY_START, NOW).kind).toBe('LIVE');
    expect(chooseRouteOrigin(fixAt(minutesAgo(edge + 1)), DAY_START, NOW).kind).toBe('LAST_KNOWN');
  });

  it('gives an office origin no timestamp, because it is not a moment', () => {
    expect(chooseRouteOrigin(null, DAY_START, NOW).point.recordedAt).toBeNull();
  });

  it('refuses a fix from the future rather than calling it live', () => {
    // A handset with a wrong clock. Treating a future timestamp as fresh would
    // pin the route to it until the clock caught up.
    const future = fixAt(new Date(NOW + 30 * 60_000).toISOString());
    expect(chooseRouteOrigin(future, DAY_START, NOW).kind).toBe('OFFICE');
  });

  it('survives an unreadable timestamp', () => {
    expect(chooseRouteOrigin(fixAt('not a date'), DAY_START, NOW).kind).toBe('OFFICE');
  });
});
