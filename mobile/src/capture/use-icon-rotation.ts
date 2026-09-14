import { Accelerometer } from 'expo-sensors';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Platform } from 'react-native';

import { iconRotationFor, type IconRotation } from './icon-rotation';

/**
 * A rotation style for the camera's icons that follows how the phone is held.
 *
 * The accelerometer, not DeviceMotion: the walkthrough guide already drives
 * DeviceMotion at its own rate, and the update interval is shared by everything
 * subscribed to a sensor. Nothing else reads the accelerometer, so this one can
 * run slowly -- five readings a second is plenty to notice a phone turned
 * sideways -- without disturbing the guide.
 *
 * No permission is asked for. Neither platform needs one to read it, and the
 * guide once died for good behind a motion prompt a technician declined.
 */
export function useIconRotation(active: boolean) {
  const [rotation, setRotation] = useState<IconRotation>(0);
  const animated = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!active) return;
    let subscription: { remove(): void } | undefined;
    let cancelled = false;
    void Accelerometer.isAvailableAsync()
      .then((available) => {
        if (!available || cancelled) return;
        Accelerometer.setUpdateInterval(200);
        subscription = Accelerometer.addListener((sample) => {
          setRotation((current) => iconRotationFor(sample, Platform.OS, current));
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      subscription?.remove();
    };
  }, [active]);

  useEffect(() => {
    Animated.timing(animated, {
      toValue: rotation,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [animated, rotation]);

  const style = useMemo(
    () => ({
      transform: [
        {
          rotate: animated.interpolate({
            inputRange: [-90, 90],
            outputRange: ['-90deg', '90deg'],
          }),
        },
      ],
    }),
    [animated],
  );

  return { rotation, style };
}
