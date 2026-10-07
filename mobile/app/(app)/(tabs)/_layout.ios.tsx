import { Badge, Icon, Label, NativeTabs } from 'expo-router/unstable-native-tabs';

import { useAssignedInspectionCount } from '@/src/features/queries';
import { useThemeColors } from '@/src/lib/theme-colors';

/**
 * UIKit's own tab bar (the office, 2026-10-07: "more native to iOS... liquid
 * glass effect on the navigation bar").
 *
 * The bar this replaces was React Navigation's, drawn in JavaScript over a
 * system-chrome blur: close to the platform's, and never the platform's. This is
 * `UITabBarController`. In a build made with the iOS 26 SDK it is Liquid Glass,
 * shrinks to a pill as a list scrolls, and puts Search in a button of its own
 * beside it -- none of which an app can draw for itself. Earlier iOS versions
 * get the standard translucent bar.
 *
 * SF Symbols, filled when selected, as every system app's tabs are. Android
 * keeps `_layout.tsx`.
 */
export default function NativeTabsLayout() {
  const theme = useThemeColors();
  // Today's assigned-but-not-started work, kept live by the realtime provider.
  const assigned = useAssignedInspectionCount();
  const assignedCount = assigned.data ?? 0;

  return (
    <NativeTabs
      tintColor={theme.primary}
      badgeBackgroundColor={theme.primary}
      minimizeBehavior="onScrollDown"
    >
      <NativeTabs.Trigger name="(home)">
        <Label>Home</Label>
        <Icon sf={{ default: 'house', selected: 'house.fill' }} />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="(jobs)">
        <Label>Jobs</Label>
        <Icon sf={{ default: 'list.clipboard', selected: 'list.clipboard.fill' }} />
        {/* Hidden rather than "0": an empty badge would sit there all day. */}
        <Badge hidden={assignedCount === 0}>{String(assignedCount)}</Badge>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="(uploads)">
        <Label>Uploads</Label>
        <Icon sf={{ default: 'icloud.and.arrow.up', selected: 'icloud.and.arrow.up.fill' }} />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="(settings)">
        <Label>Settings</Label>
        <Icon sf={{ default: 'gearshape', selected: 'gearshape.fill' }} />
      </NativeTabs.Trigger>
      {/* The system's own search tab: its glyph, its title, and on iOS 26 its
          own button apart from the bar. */}
      <NativeTabs.Trigger name="(search)" role="search" />
    </NativeTabs>
  );
}
