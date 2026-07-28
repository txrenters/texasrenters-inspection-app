import { useCallback, useEffect, useRef, useState } from 'react';
import { DeviceMotion } from 'expo-sensors';

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
  const [authorized, setAuthorized] = useState(false);

  const reset = useCallback(() => {
    trackerRef.current = createRotationTracker();
    setTracker(trackerRef.current);
  }, []);

  const requestAccess = useCallback(async () => {
    try {
      const sensorAvailable = await DeviceMotion.isAvailableAsync();
      setAvailable(sensorAvailable);
      if (!sensorAvailable) return false;
      const permission = await DeviceMotion.requestPermissionsAsync();
      const granted = permission.granted;
      setAuthorized(granted);
      return granted;
    } catch {
      setAvailable(false);
      setAuthorized(false);
      return false;
    }
  }, []);

  useEffect(() => {
    if (!active || !authorized || available === false) return;
    DeviceMotion.setUpdateInterval(50);
    let lastRender = 0;
    const subscription = DeviceMotion.addListener((measurement) => {
      const heading = radiansOrDegreesToDegrees(measurement.rotation.alpha);
      trackerRef.current = updateRotationTracker(trackerRef.current, heading);
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
  }, [active, authorized, available]);

  return {
    tracker,
    trackerRef,
    available,
    authorized,
    requestAccess,
    reset,
  };
}
