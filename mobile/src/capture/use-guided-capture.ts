import { useCallback, useEffect, useRef, useState } from 'react';
import { DeviceMotion } from 'expo-sensors';
import { Platform } from 'react-native';

import {
  createRotationTracker,
  radiansOrDegreesToDegrees,
  type RotationTracker,
  updateRotationTracker,
} from './guided-capture';

export function useGuidedCaptureSensor(active: boolean) {
  const trackerRef = useRef<RotationTracker>(createRotationTracker());
  const [tracker, setTracker] = useState<RotationTracker>(trackerRef.current);
  const [available, setAvailable] = useState<boolean | null>(null);
  const receivedSampleRef = useRef(false);

  const reset = useCallback(() => {
    trackerRef.current = createRotationTracker();
    receivedSampleRef.current = false;
    setTracker(trackerRef.current);
  }, []);

  const requestAccess = useCallback(async () => {
    try {
      const sensorAvailable = await DeviceMotion.isAvailableAsync();
      setAvailable(sensorAvailable);
      if (!sensorAvailable) return false;
      // Asked for, but deliberately not depended on.
      //
      // On Android 10+ this prompts for ACTIVITY_RECOGNITION ("Physical
      // activity") and on iOS for Motion & Fitness. Neither is required to read
      // device attitude — the rotation-vector sensor needs no permission at
      // all. Refusing to subscribe unless it was granted meant one "Deny" on a
      // prompt about step counting silently removed the 360° guide for every
      // walkthrough afterwards, with nothing on screen explaining why.
      await DeviceMotion.requestPermissionsAsync().catch(() => undefined);
      return true;
    } catch {
      setAvailable(false);
      return false;
    }
  }, []);

  useEffect(() => {
    if (!active || available === false) return;
    // Android throttles motion sensors unless a high-sampling permission is
    // present. A slow room walkthrough does not need that permission or its
    // battery cost, so 5 Hz is the portable baseline; iOS remains smoother.
    DeviceMotion.setUpdateInterval(Platform.OS === 'android' ? 200 : 75);
    let lastRender = 0;
    const subscription = DeviceMotion.addListener((measurement) => {
      // A device with no rotation-vector sensor delivers measurements without
      // `rotation`. That is the honest signal for "no motion guidance here" —
      // not the permission answer.
      if (!measurement.rotation) return;
      receivedSampleRef.current = true;
      const heading = radiansOrDegreesToDegrees(measurement.rotation.alpha);
      trackerRef.current = updateRotationTracker(trackerRef.current, heading, Date.now());
      const now = Date.now();
      if (now - lastRender >= 180) {
        lastRender = now;
        setTracker(trackerRef.current);
      }
    });
    return () => {
      subscription.remove();
      setTracker(trackerRef.current);
    };
  }, [active, available]);

  return {
    tracker,
    trackerRef,
    available,
    /** True once the sensor has actually delivered an orientation sample. */
    receivedSampleRef,
    requestAccess,
    reset,
  };
}
