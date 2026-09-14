import { describe, expect, it } from 'vitest';

import {
  chooseRouteOrigin,
  LIVE_POSITION_WITHIN_MS,
} from '../src/contracts/route-plan.js';

/**
 * Where a technician's day starts on the map.
 *
 * The previous rule was "the newest position, however old", which started
 * Monday's route from wherever a phone happened to be at four in the morning on
 * Saturday. The route should begin at home until somebody sets off, follow them
 * once their handset is reporting, and never snap back to their front door just
 * because a phone went quiet inside a house.
 */

const DAY_START = new Date('2026-09-14T05:00:00.000Z'); // midnight in Texas
const NOW = Date.parse('2026-09-14T15:00:00.000Z'); // 10am in Texas
const HOME = { latitude: 29.95, longitude: -95.55 };
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
const fixAt = (recordedAt: string) => ({ latitude: 29.8, longitude: -95.4, recordedAt });

describe('where the route starts', () => {
  it('follows the technician while their handset is reporting', () => {
    const origin = chooseRouteOrigin(fixAt(minutesAgo(1)), HOME, DAY_START, NOW);
    expect(origin?.kind).toBe('LIVE');
    expect(origin?.point.latitude).toBe(29.8);
  });

  it('starts from home before the first report of the day', () => {
    // Nothing yet today, so they have not set off.
    expect(chooseRouteOrigin(null, HOME, DAY_START, NOW)?.kind).toBe('HOME');
  });

  it('does not start today from a position left over from another day', () => {
    /**
     * The bug this replaces. A fix from Saturday morning is a fact about
     * Saturday. Starting Monday's route from it would draw the day from
     * somewhere the technician has not been for two days.
     */
    const saturday = fixAt('2026-09-12T09:29:00.000Z');
    const origin = chooseRouteOrigin(saturday, HOME, DAY_START, NOW);
    expect(origin?.kind).toBe('HOME');
    expect(origin?.point.latitude).toBe(HOME.latitude);
  });

  it('keeps the last place they were seen when the phone goes quiet mid-day', () => {
    /**
     * The case that makes this three answers rather than two. A technician
     * inside a property with thick walls goes quiet for a while. They are not
     * at home, and redrawing the rest of their day from their front door would
     * be confidently wrong.
     */
    const origin = chooseRouteOrigin(fixAt(minutesAgo(40)), HOME, DAY_START, NOW);
    expect(origin?.kind).toBe('LAST_KNOWN');
    expect(origin?.point.latitude).toBe(29.8);
  });

  it('draws the line between live and last known at the threshold', () => {
    const edge = LIVE_POSITION_WITHIN_MS / 60_000;
    expect(chooseRouteOrigin(fixAt(minutesAgo(edge)), HOME, DAY_START, NOW)?.kind).toBe('LIVE');
    expect(chooseRouteOrigin(fixAt(minutesAgo(edge + 1)), HOME, DAY_START, NOW)?.kind).toBe(
      'LAST_KNOWN',
    );
  });

  it('gives a home origin no timestamp, because it is not a moment', () => {
    expect(chooseRouteOrigin(null, HOME, DAY_START, NOW)?.point.recordedAt).toBeNull();
  });

  it('has nowhere to start without a position today or a home', () => {
    // Said plainly rather than guessed: the panel explains, the map draws no
    // line that starts from nowhere.
    expect(chooseRouteOrigin(null, null, DAY_START, NOW)).toBeNull();
    expect(chooseRouteOrigin(fixAt('2026-09-12T09:29:00.000Z'), null, DAY_START, NOW)).toBeNull();
  });

  it('refuses a fix from the future rather than calling it live', () => {
    // A handset with a wrong clock. Treating a future timestamp as fresh would
    // pin the route to it until the clock caught up.
    const future = fixAt(new Date(NOW + 30 * 60_000).toISOString());
    expect(chooseRouteOrigin(future, HOME, DAY_START, NOW)?.kind).toBe('HOME');
  });

  it('survives an unreadable timestamp', () => {
    expect(chooseRouteOrigin(fixAt('not a date'), HOME, DAY_START, NOW)?.kind).toBe('HOME');
  });
});
