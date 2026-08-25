import { useEffect, useState } from 'react';
import { Keyboard, Platform } from 'react-native';

/**
 * How far a bottom-anchored sheet has to lift to clear the Android keyboard.
 *
 * React Native's `KeyboardAvoidingView` cannot do this inside a `Modal` here.
 * The sheet sets `statusBarTranslucent`, which puts the modal in its own window
 * with `FLAG_LAYOUT_NO_LIMITS` — and a window with no limits does not resize
 * when the keyboard opens. `behavior="height"` had nothing to react to, so the
 * fields at the foot of the Add Area sheet sat underneath the keyboard the
 * whole time the technician was typing into them.
 *
 * Reading the keyboard's own reported height sidesteps the window entirely.
 *
 * Android only, and 0 everywhere else: iOS resizes its modal window normally,
 * so `KeyboardAvoidingView` still does the work there and adding this on top
 * would lift the sheet twice.
 */
export function useAndroidKeyboardInset(): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    // `Did` rather than `Will`: Android does not emit the `Will` pair at all,
    // and the height is only final once the keyboard has finished animating.
    const shown = Keyboard.addListener('keyboardDidShow', (event) =>
      setInset(event.endCoordinates.height),
    );
    const hidden = Keyboard.addListener('keyboardDidHide', () => setInset(0));
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);

  return inset;
}
