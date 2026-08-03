import { useCallback, useEffect, useRef, useState } from 'react';
import { DeviceMotion } from 'expo-sensors';
import { Platform } from 'react-native';

import {
  createRotationTracker,
  radiansOrDegreesToDegrees,
  type RotationTracker,
  updateRotationTracker,
  verticalTurnRate,
  type Vector3,
} from './guided-capture';

/**
 * The gyroscope reading as a vector in the device's own axes.
 *
 * expo-sensors labels the three rates differently on each platform: iOS follows
 * the web naming, where alpha is the rate about z, while Android hands back the
 * raw sensor triple in axis order as alpha, beta, gamma. Projecting onto
 * gravity requires the actual axes, so the labels have to be undone here.
 */
function angularVelocity(rate: { alpha: number; beta: number; gamma: number }): Vector3 {
  return Platform.OS === 'ios'
    ? { x: rate.gamma, y: rate.beta, z: rate.alpha }
    : { x: rate.alpha, y: rate.beta, z: rate.gamma };
}

/** Longest gap still treated as continuous, so a stall cannot bank a huge turn. */
const MAXIMUM_INTEGRATION_STEP_SECONDS = 0.5;

/**
 * How long to wait for a first orientation sample before declaring the device
 * incapable of motion guidance.
 *
 * Long enough for a cold sensor to spin up at the Android sampling rate, short
 * enough that a technician on a phone with no rotation vector is told to fall
 * back to the manual guide within the first few seconds of the walkthrough.
 */
const FIRST_SAMPLE_GRACE_MS = 2_500;

export function useGuidedCaptureSensor(active: boolean) {
  const trackerRef = useRef<RotationTracker>(createRotationTracker());
  const [tracker, setTracker] = useState<RotationTracker>(trackerRef.current);
  const receivedSampleRef = useRef(false);
  // Optimistic until proven otherwise: assume guidance works, and only report
  // it unavailable once the device has had its grace period and delivered
  // nothing.
  const [supported, setSupported] = useState(true);

  const reset = useCallback(() => {
    trackerRef.current = createRotationTracker();
    receivedSampleRef.current = false;
    setSupported(true);
    setTracker(trackerRef.current);
  }, []);

  const requestAccess = useCallback(async () => {
    // Asked for, never depended on.
    //
    // On Android 10+ this prompts for ACTIVITY_RECOGNITION ("Physical
    // activity") and on iOS for Motion & Fitness. Neither is required to read
    // device attitude — the rotation-vector sensor needs no permission at all.
    // Refusing to subscribe unless it was granted meant one "Deny" on a prompt
    // about step counting silently removed the 360° guide for every walkthrough
    // afterwards, with nothing on screen explaining why.
    await DeviceMotion.requestPermissionsAsync().catch(() => undefined);
    return true;
  }, []);

  useEffect(() => {
    if (!active) return;
    // Android throttles motion sensors unless a high-sampling permission is
    // present. A slow room walkthrough does not need that permission or its
    // battery cost, so 5 Hz is the portable baseline; iOS remains smoother.
    DeviceMotion.setUpdateInterval(Platform.OS === 'android' ? 200 : 75);
    let lastRender = 0;

    let integratedHeading = 0;
    let integratedAtMs = 0;
    // Chosen once and kept. The two sources are different scales of the same
    // name, so swapping mid-capture would read as one enormous jump and bank a
    // turn nobody made.
    let source: 'gyroscope' | 'attitude' | null = null;

    const subscription = DeviceMotion.addListener((measurement) => {
      const now = Date.now();
      let heading: number | null = null;

      // Preferred source: the gyroscope, projected onto gravity.
      //
      // `rotation.alpha` is Euler yaw on both platforms, and Euler yaw is
      // degenerate when the device is pitched to ±90° — the attitude a phone is
      // in whenever it is held up to film a wall. It drifts and jumps there
      // whether or not the technician turned, which is why the ring could both
      // fill on a stationary phone and refuse to move during a real lap.
      const rate = measurement.rotationRate;
      const gravity = measurement.accelerationIncludingGravity;
      if (source !== 'attitude' && rate && gravity) {
        const vertical = verticalTurnRate(angularVelocity(rate), gravity);
        if (vertical !== null) {
          const elapsedSeconds = integratedAtMs
            ? Math.min(MAXIMUM_INTEGRATION_STEP_SECONDS, (now - integratedAtMs) / 1000)
            : 0;
          integratedAtMs = now;
          // Negated so clockwise counts down, matching the heading convention
          // the tracker already reads deltas in.
          integratedHeading -= vertical * elapsedSeconds;
          heading = integratedHeading;
          source = 'gyroscope';
        } else if (source === 'gyroscope') {
          // A jolt too violent to read gravity through. Skip the sample and
          // resume from here rather than integrating across the gap.
          integratedAtMs = now;
          return;
        }
      }

      // Fallback for a device that reports attitude but no usable gyroscope or
      // gravity. Degenerate when held upright, but better than no guide at all.
      if (heading === null && source !== 'gyroscope' && measurement.rotation) {
        heading = radiansOrDegreesToDegrees(measurement.rotation.alpha);
        source = 'attitude';
      }
      if (heading === null) return;

      if (!receivedSampleRef.current) {
        receivedSampleRef.current = true;
        setSupported(true);
      }
      trackerRef.current = updateRotationTracker(trackerRef.current, heading, now);
      if (now - lastRender >= 180) {
        lastRender = now;
        setTracker(trackerRef.current);
      }
    });

    // Decided by what the sensor actually delivers, not by a capability check.
    //
    // `DeviceMotion.isAvailableAsync()` used to gate this subscription, and on
    // Android it returns false unless the device exposes all five of
    // TYPE_GYROSCOPE, TYPE_ACCELEROMETER, TYPE_LINEAR_ACCELERATION,
    // TYPE_ROTATION_VECTOR and TYPE_GRAVITY. The last two are composite sensors
    // that plenty of Android hardware does not publish, so a phone with a
    // perfectly good rotation vector reported "unavailable" and never
    // subscribed — while iOS, which has no equivalent check, worked fine. Only
    // `rotation` is used here, and expo emits it from TYPE_ROTATION_VECTOR
    // alone regardless of the other four.
    const grace = setTimeout(() => {
      if (!receivedSampleRef.current) setSupported(false);
    }, FIRST_SAMPLE_GRACE_MS);

    return () => {
      clearTimeout(grace);
      subscription.remove();
      setTracker(trackerRef.current);
    };
  }, [active]);

  return {
    tracker,
    trackerRef,
    /** False only once the device has had its grace period and sent nothing. */
    supported,
    receivedSampleRef,
    requestAccess,
    reset,
  };
}
