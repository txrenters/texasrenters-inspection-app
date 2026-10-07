import { haversineMeters } from '@texasrenters/shared';

/**
 * How hard the phone works at recording where it is (the office, 2026-10-06:
 * "slow it on site, and in Low Power Mode").
 *
 * A fix every three seconds was chosen to watch a technician drive, and it ran
 * all shift: through an hour inside one property filming room after room, on a
 * phone already spending its battery on the camera. Now the rate follows what
 * the technician is doing.
 *
 * - `MOVING` -- the dense rate the office map was built on.
 * - `SETTLED` -- standing still for a while, or Low Power Mode: one fix every
 *   half minute on Android; on iOS, which ignores time intervals, one per 25 m
 *   moved, which for a phone in a house is very nearly none.
 *
 * Satellite accuracy in both. The timesheet only trusts a fix to 25 m, so a
 * coarser one on site would read as the technician vanishing, and leaving would
 * be noticed late; it is the rate that saves the battery, not the precision.
 */
export type TrackingProfile = 'MOVING' | 'SETTLED';

/** Standing still this long counts as on site. Longer than any traffic light. */
export const SETTLE_AFTER_MS = 5 * 60_000;

/**
 * A fix this far from where the technician settled means they have moved on.
 *
 * Twice the timesheet's leaving radius (30 m), so a walk to the back of a lot
 * does not wake the dense rate, and a drive away does within one fix.
 */
export const SETTLED_RADIUS_M = 60;

/** A fix vaguer than this says nothing about whether anyone moved. */
export const MOTION_ACCURACY_M = 50;

export interface MotionFix {
  latitude: number;
  longitude: number;
  accuracyMeters: number | null;
  /** Epoch milliseconds, by the phone's clock. */
  at: number;
}

export interface Motion {
  /** Where the technician last arrived and stayed within `SETTLED_RADIUS_M`. */
  anchor: { latitude: number; longitude: number } | null;
  /** When they last left `SETTLED_RADIUS_M` of the anchor. */
  movedAt: number | null;
}

export const STILL_UNKNOWN: Motion = { anchor: null, movedAt: null };

/** The motion after one more fix. Vague fixes are ignored, not believed. */
export function advanceMotion(motion: Motion, fix: MotionFix): Motion {
  if (fix.accuracyMeters !== null && fix.accuracyMeters > MOTION_ACCURACY_M) return motion;
  const here = { latitude: fix.latitude, longitude: fix.longitude };
  if (!motion.anchor || haversineMeters(motion.anchor, here) > SETTLED_RADIUS_M)
    return { anchor: here, movedAt: fix.at };
  return motion;
}

/** What the phone should be recording at, now. */
export function profileFor({
  motion,
  lowPower,
  now,
}: {
  motion: Motion;
  lowPower: boolean;
  now: number;
}): TrackingProfile {
  if (lowPower) return 'SETTLED';
  if (motion.movedAt !== null && now - motion.movedAt >= SETTLE_AFTER_MS) return 'SETTLED';
  return 'MOVING';
}
