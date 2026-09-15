import { describe, expect, it } from 'vitest';

import {
  appendSample,
  bearingDegrees,
  distanceMeters,
  drawsAsDriving,
  LIVE_WITHIN_MS,
  motionOf,
  speedKmh,
  TRACK_WINDOW_MS,
  type MotionSample,
} from './technician-motion';

/**
 * Driving, stopped, on foot or still -- and how fast, which way.
 *
 * The office asked to watch a technician drive the way Waze shows a car: an
 * arrow when they are on the road, their speed and heading. The handset's own
 * speed and course answer that when it has satellites; when it does not, the
 * trail has to, or a technician on the freeway reads as standing still.
 */

const START = Date.parse('2026-09-15T19:40:00.000Z');

/** South of Pearland, heading north-east up TX-35. */
const ORIGIN = { latitude: 29.5516, longitude: -95.2449 };

/** A point `meters` from ORIGIN along `bearing`, near enough for a few kilometres. */
function along(meters: number, bearing: number) {
  const radians = (bearing * Math.PI) / 180;
  return {
    latitude: ORIGIN.latitude + (meters * Math.cos(radians)) / 111_320,
    longitude:
      ORIGIN.longitude +
      (meters * Math.sin(radians)) / (111_320 * Math.cos((ORIGIN.latitude * Math.PI) / 180)),
  };
}

function sample(over: Partial<MotionSample> & { seconds: number }): MotionSample {
  const { seconds, ...rest } = over;
  return {
    ...ORIGIN,
    recordedAt: START + seconds * 1000,
    accuracyMeters: 8,
    headingDegrees: null,
    speedMetersPerSecond: null,
    ...rest,
  };
}

function trackOf(...samples: MotionSample[]) {
  return samples.reduce<readonly MotionSample[]>((track, each) => appendSample(track, each), []);
}

describe('the geometry', () => {
  it('measures a kilometre north as a kilometre, heading north', () => {
    const north = along(1_000, 0);
    expect(distanceMeters(ORIGIN, north)).toBeCloseTo(1_000, -1);
    expect(bearingDegrees(ORIGIN, north)).toBeCloseTo(0, 0);
    expect(bearingDegrees(ORIGIN, along(1_000, 90))).toBeCloseTo(90, 0);
    expect(bearingDegrees(ORIGIN, along(1_000, 225))).toBeCloseTo(225, 0);
  });
});

describe('what the handset says', () => {
  it('believes a satellite fix: its speed and course', () => {
    const track = trackOf(
      sample({ seconds: 0, speedMetersPerSecond: 17, headingDegrees: 42 }),
    );

    expect(motionOf(track, START)).toMatchObject({
      state: 'DRIVING',
      speedMetersPerSecond: 17,
      headingDegrees: 42,
      source: 'HANDSET',
      live: true,
    });
  });

  it('believes a satellite fix that says zero: that is a car at a light', () => {
    const track = trackOf(
      sample({ seconds: 0, ...along(0, 45), speedMetersPerSecond: 16, headingDegrees: 45 }),
      sample({ seconds: 15, ...along(240, 45), speedMetersPerSecond: 0, headingDegrees: 45 }),
    );

    const motion = motionOf(track, START + 15_000);
    expect(motion?.state).toBe('STOPPED');
    expect(motion?.speedMetersPerSecond).toBe(0);
    // Still facing the way it was going, so the arrow does not vanish at a light.
    expect(motion?.headingDegrees).toBe(45);
  });

  it('treats the platforms’ -1 as no answer rather than a speed', () => {
    const track = trackOf(sample({ seconds: 0, speedMetersPerSecond: -1, headingDegrees: -1 }));

    expect(motionOf(track, START)).toMatchObject({ state: 'STILL', headingDegrees: null });
  });
});

describe('what the trail says, when the handset cannot', () => {
  it('reads a freeway drive off Wi-Fi fixes that report a speed of zero', () => {
    // Android, no satellites: speed and course both come back as 0.0, and the
    // fixes are tens of metres wide. 250m in fifteen seconds is 60 km/h.
    const track = trackOf(
      sample({ seconds: 0, ...along(0, 60), accuracyMeters: 60, speedMetersPerSecond: 0, headingDegrees: 0 }),
      sample({ seconds: 15, ...along(250, 60), accuracyMeters: 60, speedMetersPerSecond: 0, headingDegrees: 0 }),
    );

    const motion = motionOf(track, START + 15_000);
    expect(motion?.state).toBe('DRIVING');
    expect(motion?.source).toBe('TRAIL');
    expect(motion?.speedMetersPerSecond).toBeCloseTo(250 / 15, 0);
    expect(motion?.headingDegrees).toBeCloseTo(60, 0);
  });

  it('does not mistake a phone on a counter wandering inside its accuracy for travel', () => {
    const track = trackOf(
      sample({ seconds: 0, ...along(0, 0), accuracyMeters: 65, speedMetersPerSecond: 0 }),
      sample({ seconds: 15, ...along(70, 200), accuracyMeters: 65, speedMetersPerSecond: 0 }),
    );

    expect(motionOf(track, START + 15_000)).toMatchObject({ state: 'STILL', headingDegrees: null });
  });

  it('takes the trail’s direction over a course of exactly zero', () => {
    // Zero is what Android reports for "no course", and it is due north.
    const track = trackOf(
      sample({ seconds: 0, ...along(0, 120) }),
      sample({ seconds: 10, ...along(200, 120), speedMetersPerSecond: 20, headingDegrees: 0 }),
    );

    expect(motionOf(track, START + 10_000)?.headingDegrees).toBeCloseTo(120, 0);
  });

  it('says nothing about speed across a gap too long to mean anything', () => {
    // Twenty minutes and ten kilometres apart: a straight line says nothing
    // about the roads, or the stop halfway.
    const track = trackOf(
      sample({ seconds: 0, ...along(0, 0), accuracyMeters: 60, speedMetersPerSecond: 0 }),
      sample({ seconds: 1_200, ...along(10_000, 0), accuracyMeters: 60, speedMetersPerSecond: 0 }),
    );

    expect(motionOf(track, START + 1_200_000)?.state).toBe('STILL');
  });
});

describe('telling a stop from the end of a drive', () => {
  const drive = [
    sample({ seconds: 0, ...along(0, 30), speedMetersPerSecond: 15, headingDegrees: 30 }),
    sample({ seconds: 15, ...along(225, 30), speedMetersPerSecond: 15, headingDegrees: 30 }),
  ];

  it('is on foot at walking pace with no drive behind it', () => {
    const track = trackOf(
      sample({ seconds: 0, ...along(0, 90) }),
      sample({ seconds: 15, ...along(20, 90), speedMetersPerSecond: 1.3, headingDegrees: 90 }),
    );

    expect(motionOf(track, START + 15_000)?.state).toBe('ON_FOOT');
  });

  it('is still driving when crawling in traffic mid-drive', () => {
    const track = trackOf(
      ...drive,
      sample({ seconds: 30, ...along(240, 30), speedMetersPerSecond: 1.2, headingDegrees: 30 }),
    );

    expect(motionOf(track, START + 30_000)?.state).toBe('DRIVING');
  });

  it('is no longer driving two minutes after parking', () => {
    const track = trackOf(
      ...drive,
      sample({ seconds: 60, ...along(260, 30), speedMetersPerSecond: 0 }),
      sample({ seconds: 200, ...along(262, 30), speedMetersPerSecond: 0 }),
    );

    expect(motionOf(track, START + 200_000)).toMatchObject({ state: 'STILL', headingDegrees: null });
  });
});

describe('an old fix', () => {
  it('is not live, so nothing presents it as happening now', () => {
    const track = trackOf(sample({ seconds: 0, speedMetersPerSecond: 17, headingDegrees: 42 }));

    const motion = motionOf(track, START + LIVE_WITHIN_MS + 1);
    expect(motion?.live).toBe(false);
    expect(drawsAsDriving(motion)).toBe(false);
  });

  it('draws the arrow only while live, moving on the road, and facing somewhere', () => {
    const track = trackOf(sample({ seconds: 0, speedMetersPerSecond: 17, headingDegrees: 42 }));
    expect(drawsAsDriving(motionOf(track, START))).toBe(true);
    expect(drawsAsDriving(motionOf(trackOf(sample({ seconds: 0, speedMetersPerSecond: 0 })), START))).toBe(false);
  });
});

describe('keeping the trail', () => {
  it('ignores a fix it already has, returning the same array', () => {
    const first = sample({ seconds: 0 });
    const track = trackOf(first);

    expect(appendSample(track, { ...first })).toBe(track);
  });

  it('never inserts an older fix, which would read as a U-turn', () => {
    const track = trackOf(sample({ seconds: 30 }));

    expect(appendSample(track, sample({ seconds: 10 }))).toBe(track);
  });

  it('forgets fixes older than its window', () => {
    const track = trackOf(sample({ seconds: 0 }), sample({ seconds: TRACK_WINDOW_MS / 1000 + 1 }));

    expect(track).toHaveLength(1);
  });
});

describe('the speed readout', () => {
  it('gives whole kilometres per hour', () => {
    expect(speedKmh(26.8224)).toBe(97);
  });

  it('reads GPS drift under walking pace as zero', () => {
    expect(speedKmh(0.3)).toBe(0);
  });

  it('has nothing to say without a speed', () => {
    expect(speedKmh(null)).toBeNull();
  });
});
