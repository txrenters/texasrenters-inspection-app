import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Modal, Platform, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * A panel anchored to the bottom of the screen, over a dimmed backdrop.
 *
 * This exists because `Modal` renders outside the screen's `SafeAreaView` and
 * inherits none of its insets, and nothing in its API hints at that. All three
 * sheets in the app were written independently and all three got it wrong the
 * same way — a guessed forty points of bottom padding and no keyboard handling
 * — which left a technician typing a skip reason underneath their own keyboard,
 * unable to reach the button that would submit it.
 *
 * So the parts that were forgotten are not optional here: the measured inset,
 * keyboard avoidance, `accessibilityViewIsModal`, and a translucent status bar
 * so the backdrop covers the whole screen on Android. A fourth sheet gets them
 * by construction rather than by remembering.
 *
 * Keyboard avoidance applies even to a sheet with nothing to type in. It costs
 * a wrapper view when no field is focused, and that is cheaper than each caller
 * deciding — the sheet that gains its first input would not think to revisit
 * the flag.
 */
export function BottomSheet({
  visible,
  onClose,
  children,
  animationType = 'slide',
  className,
  accessibilityRole,
}: {
  visible: boolean;
  /** Also runs on the Android back button, which must always dismiss. */
  onClose: () => void;
  children: ReactNode;
  animationType?: 'fade' | 'slide' | 'none';
  /** Classes for the panel — a maximum height, typically. Padding is set here. */
  className?: string;
  /** 'alert' for a sheet that interrupts to ask something. */
  accessibilityRole?: 'alert';
}) {
  const insets = useSafeAreaInsets();

  return (
    <Modal
      animationType={animationType}
      transparent
      statusBarTranslucent
      visible={visible}
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        className="flex-1 justify-end bg-black/55"
      >
        <View
          accessibilityRole={accessibilityRole}
          accessibilityViewIsModal
          className={`rounded-t-3xl bg-background px-5 pt-6 ${className ?? ''}`}
          // Measured rather than assumed: enough to clear a home indicator
          // where there is one, and not a dead gap where there is not.
          style={{ paddingBottom: Math.max(insets.bottom, 24) }}
        >
          {children}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
