import { AccessibilityInfo } from 'react-native';

/**
 * Speak a one-off status change to a screen reader.
 *
 * Capture is otherwise silent: the shutter sound is disabled so it does not
 * land on the inspection's audio track, and success shows only as a number
 * changing on screen. Without this a technician using VoiceOver has no way to
 * know whether a photo was actually taken, and will either re-shoot or leave
 * the area undocumented.
 *
 * No-ops when no screen reader is running, so it is safe to call unconditionally.
 */
export function announce(message: string): void {
  if (!message) return;
  try {
    AccessibilityInfo.announceForAccessibility(message);
  } catch {
    // Never let an accessibility nicety break a capture flow.
  }
}
