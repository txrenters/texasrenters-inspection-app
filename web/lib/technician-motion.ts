import {
  MOVING_SPEED_MS,
  normaliseMotion,
  type TechnicianPosition,
} from '@texasrenters/shared';

/**
 * How a technician is moving, from the fixes this console has seen arrive.
 *
 * The handset's own speed and course are the best answer when it has them, and
 * it often does not. A fix positioned from Wi-Fi or cell towers carries neither
 * -- Android reports both as zero, iOS as nothing -- so a technician doing
 * sixty on the freeway would read as standing still. For those the trail
 * answers instead: how far the marker moved between two fixes, and in which
 * direction, as long as that is further than the two fixes' own uncertainty.
 *
 * Kept on the client rather than the API because the console already holds
 * every fix pushed over the socket, and a trail of the last few minutes is all
 * this needs.
 */

/** One reported fix, reduced to what motion is worked out from. */
export interface MotionSample {
  latitude: number;
  longitude: number;
  /** Epoch milliseconds, by the handset's clock. */
  recordedAt: number;
  accuracyMeters: number | null;
  headingDegrees: number | null;
  speedMetersPerSecond: number | null;
}

/**
 * - `DRIVING` -- travelling at road speed, or crawling in traffic mid-drive.
 * - `STOPPED` -- was driving moments ago and is not moving now: a light, a
 *   jam, a turn into a driveway. Still a drive, so the map keeps the arrow.
 * - `ON_FOOT` -- moving, at walking pace, with no drive behind it.
 * - `STILL` -- not moving, or no evidence either way.
 */
export type MotionState = 'DRIVING' | 'STOPPED' | 'ON_FOOT' | 'STILL';

export interface Motion {
  state: MotionState;
  /** Metres per second, or null when nothing says. */
  speedMetersPerSecond: number | null;
  /** Direction of travel, degrees clockwise from north. Null when still. */
  headingDegrees: number | null;
  /** Whether the numbers came from the handset or were read off the trail. */
  source: 'HANDSET' | 'TRAIL' | null;
  /** Whether the newest fix is recent enough to describe the present. */
  live: boolean;
  /** The newest fix, epoch milliseconds. */
  recordedAt: number;
}

/**
 * Faster than anybody walks: 2.5 m/s is 9 km/h.
 *
 * A brisk walk is 1.5 m/s and GPS on a moving phone adds a little, so the gap
 * between this and `MOVING_SPEED_MS` is "on foot".
 */
export const DRIVING_SPEED_MS = 2.5;

/**
 * How long a stop still counts as part of a drive.
 *
 * Long enough for a red light or a stretch of jammed freeway, short enough
 * that somebody who parked and walked inside is not shown as driving.
 */
export const DRIVE_HOLDS_THROUGH_STOP_MS = 2 * 60_000;

/**
 * Past this, a fix is where they were rather than what they are doing.
 *
 * A moving handset sends every ten to fifteen seconds, so three quiet minutes
 * is several missed sends -- a dead zone at best. Speed read off a fix that old
 * would be the map asserting a present fact from stale evidence.
 */
export const LIVE_WITHIN_MS = 3 * 60_000;

/** How much trail is kept per technician. */
export const TRACK_WINDOW_MS = 10 * 60_000;
const TRACK_MAX_SAMPLES = 60;

/**
 * Satellite-grade. Below this the handset's own speed is believed even when it
 * says zero; above it, a zero is more likely "no satellites, no answer".
 */
const SATELLITE_ACCURACY_M = 30;

/**
 * The window two fixes must fall within to say anything about speed.
 *
 * Closer than three seconds and the positions' own jitter dominates; further
 * apart than three minutes and a straight line between them says nothing about
 * the roads in between, or the stop somebody made halfway.
 */
const MIN_GAP_MS = 3_000;
const MAX_GAP_MS = 3 * 60_000;

/** Movement smaller than this is never evidence of travel, however accurate. */
const MIN_DISPLACEMENT_M = 20;

const EARTH_RADIUS_M = 6_371_008.8;
const radians = (degrees: number) => (degrees * Math.PI) / 180;

/** Great-circle distance between two points, in metres. */
export function distanceMeters(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
) {
  const dLat = radians(to.latitude - from.latitude);
  const dLng = radians(to.longitude - from.longitude);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(from.latitude)) * Math.cos(radians(to.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** The initial bearing from one point to another, degrees clockwise from north. */
export function bearingDegrees(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
) {
  const lat1 = radians(from.latitude);
  const lat2 = radians(to.latitude);
  const dLng = radians(to.longitude - from.longitude);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export function sampleFrom(position: TechnicianPosition): MotionSample {
  return {
    latitude: position.latitude,
    longitude: position.longitude,
    recordedAt: Date.parse(position.recordedAt),
    accuracyMeters: position.accuracyMeters,
    ...normaliseMotion(position),
  };
}

/**
 * A technician's trail with one more fix on the end.
 *
 * Returns the same array when the fix is not newer than the last one kept --
 * the positions list is re-delivered on every refetch and every socket frame,
 * and most of those carry a fix already seen. An older fix is never inserted:
 * a late batch walking the trail backwards would read as a U-turn.
 */
export function appendSample(track: readonly MotionSample[], sample: MotionSample) {
  const last = track.at(-1);
  if (!Number.isFinite(sample.recordedAt)) return track;
  if (last && sample.recordedAt <= last.recordedAt) return track;
  const kept = track.filter((each) => sample.recordedAt - each.recordedAt <= TRACK_WINDOW_MS);
  return [...kept.slice(-(TRACK_MAX_SAMPLES - 1)), sample];
}

interface Velocity {
  speedMetersPerSecond: number | null;
  headingDegrees: number | null;
  source: Motion['source'];
}

/** Speed and direction read off the trail, arriving at `track[index]`. */
function velocityFromTrail(track: readonly MotionSample[], index: number): Velocity | null {
  const sample = track[index];
  if (!sample) return null;
  for (let earlier = index - 1; earlier >= 0; earlier -= 1) {
    const previous = track[earlier];
    if (!previous) continue;
    const gap = sample.recordedAt - previous.recordedAt;
    if (gap < MIN_GAP_MS) continue;
    if (gap > MAX_GAP_MS) return null;
    const moved = distanceMeters(previous, sample);
    // The two positions' combined uncertainty. Movement inside it is noise: a
    // phone on a kitchen counter wanders by its accuracy radius between fixes.
    const noise = Math.max(
      MIN_DISPLACEMENT_M,
      Math.hypot(previous.accuracyMeters ?? 0, sample.accuracyMeters ?? 0),
    );
    if (moved <= noise) return { speedMetersPerSecond: 0, headingDegrees: null, source: 'TRAIL' };
    return {
      speedMetersPerSecond: moved / (gap / 1000),
      headingDegrees: bearingDegrees(previous, sample),
      source: 'TRAIL',
    };
  }
  return null;
}

/** The best answer for one fix: the handset's when it can be believed, else the trail's. */
function velocityAt(track: readonly MotionSample[], index: number): Velocity {
  const sample = track[index];
  if (!sample) return { speedMetersPerSecond: null, headingDegrees: null, source: null };
  const reported = normaliseMotion(sample);
  const trail = velocityFromTrail(track, index);

  const speed = reported.speedMetersPerSecond;
  const believed =
    speed !== null &&
    (speed >= MOVING_SPEED_MS ||
      (sample.accuracyMeters !== null && sample.accuracyMeters <= SATELLITE_ACCURACY_M));

  if (believed)
    return {
      speedMetersPerSecond: speed,
      // Android reports a course of exactly zero when it has none, which is
      // indistinguishable from due north. The trail's direction, when there is
      // one, is the better reading of a zero.
      headingDegrees:
        reported.headingDegrees === 0 && trail?.headingDegrees != null
          ? trail.headingDegrees
          : reported.headingDegrees,
      source: 'HANDSET',
    };
  if (trail) return trail;
  return { ...reported, source: speed === null ? null : 'HANDSET' };
}

/**
 * What a technician is doing, as of `now`.
 *
 * Null for a technician with no fixes at all.
 */
export function motionOf(track: readonly MotionSample[], now = Date.now()): Motion | null {
  const latest = track.at(-1);
  if (!latest) return null;

  const current = velocityAt(track, track.length - 1);
  const speed = current.speedMetersPerSecond;

  // The most recent fix at road speed, for telling a stop in traffic from the
  // end of a drive.
  let lastDriving: { recordedAt: number; headingDegrees: number | null } | null = null;
  for (let index = track.length - 1; index >= 0; index -= 1) {
    const sample = track[index];
    const velocity = velocityAt(track, index);
    if (sample && velocity.speedMetersPerSecond !== null && velocity.speedMetersPerSecond >= DRIVING_SPEED_MS) {
      lastDriving = { recordedAt: sample.recordedAt, headingDegrees: velocity.headingDegrees };
      break;
    }
  }
  const midDrive =
    lastDriving !== null && latest.recordedAt - lastDriving.recordedAt <= DRIVE_HOLDS_THROUGH_STOP_MS;

  const moving = speed !== null && speed >= MOVING_SPEED_MS;
  const state: MotionState =
    speed !== null && speed >= DRIVING_SPEED_MS
      ? 'DRIVING'
      : midDrive
        ? moving
          ? 'DRIVING'
          : 'STOPPED'
        : moving
          ? 'ON_FOOT'
          : 'STILL';

  return {
    state,
    speedMetersPerSecond: speed,
    // A stopped car still faces the way it was going, which is what the arrow
    // should keep showing. Somebody standing still faces no particular way.
    headingDegrees:
      state === 'STILL' ? null : (current.headingDegrees ?? lastDriving?.headingDegrees ?? null),
    source: current.source,
    live: now - latest.recordedAt <= LIVE_WITHIN_MS,
    recordedAt: latest.recordedAt,
  };
}

/** Whether the marker should be the driving arrow. */
export function drawsAsDriving(motion: Motion | null | undefined): motion is Motion {
  return Boolean(
    motion?.live &&
      (motion.state === 'DRIVING' || motion.state === 'STOPPED') &&
      motion.headingDegrees !== null,
  );
}

/**
 * Whole kilometres per hour, or null for a speed nobody reported.
 *
 * Kilometres, like every distance on this console: the office reading it works
 * in metric (see `formatDistance`).
 */
export function speedKmh(metersPerSecond: number | null) {
  if (metersPerSecond === null || !Number.isFinite(metersPerSecond)) return null;
  // Under walking pace reads as a flat zero: a parked van's GPS drift of 1 km/h
  // is noise, and printing it suggests the van is creeping.
  return metersPerSecond < MOVING_SPEED_MS ? 0 : Math.round(metersPerSecond * 3.6);
}
