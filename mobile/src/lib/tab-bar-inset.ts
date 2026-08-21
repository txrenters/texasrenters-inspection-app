import { useBottomTabBarHeight } from '@react-navigation/bottom-tabs';
import { Platform } from 'react-native';

/**
 * The space a scrolling tab screen must leave at its bottom.
 *
 * On iOS the tab bar is positioned absolutely so content can pass under its
 * translucent material (see `TabBarBackground`). That is what makes the bar look
 * native, and it is also what makes it dangerous: an absolutely positioned bar
 * is outside layout, so a list ends *behind* it. The final row of an inspection
 * list, or the sign-out button at the foot of Settings, would be drawn but
 * unreachable — visible through the blur, and impossible to tap.
 *
 * Every scrolling tab screen therefore ends with this much padding. Use it on
 * `contentContainerStyle`, not on the screen's own view: padding the container
 * would stop the content scrolling under the bar at all, which is the effect
 * being paid for.
 *
 * Returns 0 on Android and web, where the bar sits in normal flow and the
 * layout has already accounted for it.
 */
export function useTabBarInset(): number {
  // Safe in every caller: this hook only exists inside the `(tabs)` group, all
  // of whose screens are children of the tab navigator.
  const height = useBottomTabBarHeight();
  return Platform.OS === 'ios' ? height : 0;
}
