import { Tabs } from 'expo-router';
import {
  ClipboardListIcon,
  CogIcon,
  HomeIcon,
  SearchIcon,
  UploadCloudIcon,
  type LucideIcon,
} from 'lucide-react-native';
import { StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAssignedInspectionCount } from '@/src/features/queries';
import { registerIcons } from '@/src/lib/icons';
import { useThemeColors } from '@/src/lib/theme-colors';

/**
 * The tab bar on Android (and the web build). iOS draws its own: see
 * `_layout.ios.tsx`, which is UIKit's tab bar in Liquid Glass. Both list the
 * same five tabs, each a group with its own stack and native header.
 */

/**
 * The bar's own height on Android, before the system inset is added.
 *
 * A 25pt glyph, 6pt above it and a 10pt label come to about 50; 56 is the
 * Material bottom-navigation height and leaves the row breathing room without
 * making the bar taller than the platform's own.
 */
const ANDROID_TAB_BAR_HEIGHT = 56;

/**
 * The least room left below the row on Android.
 *
 * `insets.bottom` comes back as 0 on this build: there is no edge-to-edge
 * integration, so the window never receives the navigation bar's insets, and
 * deriving the padding from them left the glyphs and labels flush against the
 * bottom edge of the bar — reading as cropped, which is exactly what it was.
 *
 * 24 is Android's own gesture-navigation inset. Applied as a floor rather than
 * a replacement, so the real value still wins the day it starts arriving —
 * which is what installing `react-native-edge-to-edge` would do, at the cost of
 * a native rebuild.
 */
const ANDROID_MIN_BOTTOM_INSET = 24;

/**
 * One tab glyph, outlined, leaning on colour for the selected tab as Material
 * does. Takes React Navigation's own `color`, so the glyph cannot drift from
 * `tabBarActiveTintColor`.
 */
function tabGlyph(Icon: LucideIcon) {
  return function TabGlyph({ color, focused }: { color: string; focused: boolean }) {
    return <Icon color={color} size={25} strokeWidth={focused ? 2 : 1.8} />;
  };
}

registerIcons(HomeIcon, ClipboardListIcon, UploadCloudIcon, CogIcon, SearchIcon);

export default function TabsLayout() {
  // React Navigation's bar takes real colours rather than classes.
  const theme = useThemeColors();
  // Android 15 draws every app edge-to-edge whether it asks to or not, so the
  // system navigation bar sits *over* the window. See ANDROID_MIN_BOTTOM_INSET.
  const insets = useSafeAreaInsets();
  const bottomInset = Math.max(insets.bottom, ANDROID_MIN_BOTTOM_INSET);
  // Today's assigned-but-not-started work. Live: the realtime provider
  // invalidates the inspection queries when an assignment lands.
  const assigned = useAssignedInspectionCount();
  const assignedCount = assigned.data ?? 0;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: theme.background,
          height: ANDROID_TAB_BAR_HEIGHT + bottomInset,
          paddingBottom: bottomInset,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: theme.border,
        },
        tabBarActiveTintColor: theme.primary,
        tabBarInactiveTintColor: theme.mutedForeground,
        tabBarLabelStyle: { fontSize: 10, fontWeight: '500', marginBottom: 2 },
        tabBarItemStyle: { paddingTop: 6 },
      }}
    >
      <Tabs.Screen name="(home)" options={{ title: 'Home', tabBarIcon: tabGlyph(HomeIcon) }} />
      <Tabs.Screen
        name="(jobs)"
        options={{
          title: 'Jobs',
          // Undefined rather than 0: React Navigation renders a badge for any
          // defined value, so zero would leave an empty dot sitting there.
          tabBarBadge: assignedCount > 0 ? assignedCount : undefined,
          tabBarBadgeStyle: {
            backgroundColor: theme.primary,
            color: theme.primaryForeground,
            fontSize: 11,
            fontWeight: '700',
          },
          tabBarAccessibilityLabel:
            assignedCount > 0 ? `Jobs, ${assignedCount} today not started` : 'Jobs',
          tabBarIcon: tabGlyph(ClipboardListIcon),
        }}
      />
      <Tabs.Screen name="(uploads)" options={{ title: 'Uploads', tabBarIcon: tabGlyph(UploadCloudIcon) }} />
      <Tabs.Screen name="(settings)" options={{ title: 'Settings', tabBarIcon: tabGlyph(CogIcon) }} />
      <Tabs.Screen name="(search)" options={{ title: 'Search', tabBarIcon: tabGlyph(SearchIcon) }} />
    </Tabs>
  );
}
