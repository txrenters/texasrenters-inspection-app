import { BlurView } from 'expo-blur';
import { Platform, StyleSheet, View } from 'react-native';

import { useThemeColors } from '@/src/lib/theme-colors';

/**
 * The material behind the tab bar.
 *
 * iOS chrome is translucent: the bar samples whatever scrolls beneath it, so a
 * list running under it tints the bar as it passes. That sampling is the single
 * property that makes a tab bar read as native rather than as a coloured strip
 * pinned to the bottom, and it is why the bar is positioned absolutely in
 * `(tabs)/_layout.tsx` — a bar in normal flow has nothing behind it but the
 * screen's own background, and blurring a flat colour produces that same flat
 * colour at the cost of a GPU pass.
 *
 * `systemChromeMaterial` rather than a fixed light or dark blur: it is the tint
 * Apple uses for bars specifically, and it follows the system appearance without
 * this component tracking the colour scheme. The `tint` still switches, because
 * the app honours its own in-app theme as well as the system one.
 *
 * Android and web get a solid fill. `BlurView` runs on both, but Android blur is
 * expensive on the mid-range hardware technicians actually carry, and a
 * translucent bottom bar is not an Android convention — Material draws an opaque
 * navigation bar. Matching each platform beats one look imposed on both.
 */
export function TabBarBackground() {
  const theme = useThemeColors();

  if (Platform.OS !== 'ios') {
    return (
      <View
        style={[StyleSheet.absoluteFill, { backgroundColor: theme.background }]}
        // Decorative: the bar's buttons carry the labels and roles.
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      />
    );
  }

  return (
    <BlurView
      intensity={100}
      tint={theme.isDark ? 'systemChromeMaterialDark' : 'systemChromeMaterialLight'}
      style={StyleSheet.absoluteFill}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    />
  );
}
