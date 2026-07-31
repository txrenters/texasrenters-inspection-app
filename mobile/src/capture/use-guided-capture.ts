import { useCallback, useEffect, useRef, useState } from 'react';
import { DeviceMotion } from 'expo-sensors';
import { Platform } from 'react-native';

import {
  createRotationTracker,
  radiansOrDegreesToDegrees,
  type RotationTracker,
  updateRotationTracker,
} from './guided-capture';

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

    const subscription = DeviceMotion.addListener((measurement) => {
      // Whether `rotation` arrives is the only question that matters. A device
      // that cannot report attitude simply never sends it.
      if (!measurement.rotation) return;
      if (!receivedSampleRef.current) {
        receivedSampleRef.current = true;
        setSupported(true);
      }
      const heading = radiansOrDegreesToDegrees(measurement.rotation.alpha);
      trackerRef.current = updateRotationTracker(trackerRef.current, heading, Date.now());
      const now = Date.now();
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
