import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';

import { useReducedMotion } from '../lib/reduced-motion';

/**
 * The white blink that says a snapshot was taken.
 *
 * Before this the only visual confirmation was a spinner inside the shutter
 * button and a tally that ticked up — both small, both easy to miss while
 * walking a room and watching the frame rather than the controls. On Android
 * mid-recording there was nothing at all, because that path never reaches the
 * spinner.
 *
 * Full-screen because the CameraView is itself absolute-fill: flashing the
 * frame is what every phone camera does, and it is legible from the corner of
 * an eye in a way that no control-sized indicator is.
 *
 * White rather than black. Inspection interiors are dim — empty units with the
 * power off, closets, crawl spaces — and a dark blink over a dark room is
 * nearly invisible. The hardcoded colour is the same exception
 * GuidedCaptureOverlay documents: this paints over live video, not over a
 * themed surface, so a token would be the wrong answer in either scheme.
 */

/** Peak of the blink. Full white reads as a fault; this reads as a shutter. */
const PEAK_OPACITY = 0.85;
/** Up fast, down slow — the asymmetry is what makes it read as a shutter. */
const RISE_MS = 45;
const FALL_MS = 200;
/** Reduced motion: long enough to notice, short enough not to obscure the frame. */
const STATIC_HOLD_MS = 180;
const STATIC_OPACITY = 0.5;

export function ShutterFlash({ trigger }: { trigger: number }) {
  const opacity = useRef(new Animated.Value(0)).current;
  const reducedMotion = useReducedMotion();
  const [held, setHeld] = useState(false);

  useEffect(() => {
    // 0 is the initial count: nothing has been captured, so nothing should
    // flash on mount.
    if (!trigger) return;

    if (reducedMotion) {
      // No timing at all, per the house rule — check the flag, drop the
      // animation, keep the information. A held overlay still confirms the
      // capture; nothing interpolates.
      setHeld(true);
      const timer = setTimeout(() => setHeld(false), STATIC_HOLD_MS);
      return () => clearTimeout(timer);
    }

    const animation = Animated.sequence([
      Animated.timing(opacity, {
        toValue: PEAK_OPACITY,
        duration: RISE_MS,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.timing(opacity, {
        toValue: 0,
        duration: FALL_MS,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
    ]);
    animation.start();
    // Stopping on re-trigger rather than queueing: three quick taps should be
    // three blinks in time with the thumb, not one long smear finishing after
    // the technician has moved on.
    return () => animation.stop();
  }, [opacity, reducedMotion, trigger]);

  // pointerEvents in the style object, matching the framing overlay on this
  // screen. A flash that swallowed the next shutter tap would cost the shot it
  // is meant to confirm.
  const base = {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#fff',
    pointerEvents: 'none',
  } as const;

  // Silent to assistive tech on purpose: the screen already announces the
  // capture, and a second channel would speak over it.
  const hidden = {
    accessibilityElementsHidden: true,
    importantForAccessibility: 'no-hide-descendants',
  } as const;

  if (reducedMotion) {
    if (!held) return null;
    return <View {...hidden} style={[base, { opacity: STATIC_OPACITY }]} />;
  }

  return <Animated.View {...hidden} style={[base, { opacity }]} />;
}
