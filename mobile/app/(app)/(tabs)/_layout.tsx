import * as Haptics from 'expo-haptics';
import { Tabs } from 'expo-router';
import {
  HomeIcon,
  ClipboardListIcon,
  InboxIcon,
  UploadCloudIcon,
  CogIcon,
} from 'lucide-react-native';
import { Platform, StyleSheet } from 'react-native';
import { useAssignedInspectionCount, useOpenEvidenceRequests } from '@/src/features/queries';
import { TabBarBackground } from '@/src/components/ui/TabBarBackground';
import { registerIcons } from '@/src/lib/icons';
import { useThemeColors } from '@/src/lib/theme-colors';

registerIcons(HomeIcon);
registerIcons(ClipboardListIcon);
registerIcons(UploadCloudIcon);
registerIcons(CogIcon);

/**
 * Selection feedback on a tab change, iOS only.
 *
 * `selectionAsync` is the light tick Apple uses for a segmented control or a
 * picker landing on a new value, which is exactly what changing tab is. It is
 * deliberately not `impactAsync` — impact is for something arriving or
 * completing, and the camera screen already uses it for capture milestones.
 * Firing the heavier one here would make routine navigation feel more
 * consequential than taking a photograph.
 *
 * Android is left alone: the platform does not tick on tab changes, and adding
 * it reads as a rattle rather than as feedback.
 */
function tabPressFeedback() {
  if (Platform.OS !== 'ios') return;
  void Haptics.selectionAsync().catch(() => undefined);
}

export default function TabsLayout() {
  // The tab bar is React Navigation's, so it takes real colours rather than
  // classes. These restated `--background`, `--border`, `--primary` and
  // `--muted-foreground` as six hex literals, which meant the one piece of
  // chrome visible on every screen was the one piece a palette change missed.
  const theme = useThemeColors();
  // Assigned-but-not-started work. Live: the realtime provider invalidates the
  // inspection queries when an assignment lands, so this moves without the
  // technician reopening anything.
  const assigned = useAssignedInspectionCount();
  const assignedCount = assigned.data ?? 0;
  // Kept live by the realtime gateway: the badge changes the moment the office
  // asks for something, not on the next poll.
  const openRequests = useOpenEvidenceRequests();
  const requestCount = openRequests.data?.length ?? 0;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarBackground: TabBarBackground,
        tabBarStyle: {
          // Absolute on iOS so content scrolls *under* the translucent bar,
          // which is the whole point of the blur. Every tab screen pays for this
          // by insetting its scroll container with `useBottomTabBarHeight()` —
          // without that the last row of a list sits under the bar unreachable.
          //
          // Android keeps the bar in normal flow, where the platform expects an
          // opaque navigation surface that content stops above.
          ...Platform.select({
            ios: { position: 'absolute' as const, backgroundColor: 'transparent' },
            default: { backgroundColor: theme.background },
          }),
          // A hairline, not a 1px rule. On a 3x screen `hairlineWidth` is 0.33pt
          // — the separator iOS actually draws. A full point reads as a drawn
          // border, and next to system chrome it is visibly heavier than
          // anything the OS puts on screen.
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: theme.border,
          // Height and bottom padding are left to React Navigation, which
          // derives them from the safe-area inset. The previous fixed
          // `height: 56` + `paddingBottom: 4` ignored the home indicator, so on
          // a notched device the labels sat inside the swipe region.
        },
        tabBarActiveTintColor: theme.primary,
        tabBarInactiveTintColor: theme.mutedForeground,
        tabBarLabelStyle: {
          // 10pt is the iOS tab label size. 11 with `600` weight was heavier and
          // larger than any system tab bar, which is what made the bar read as
          // an app's own control rather than as chrome.
          fontSize: 10,
          fontWeight: '500',
          // iOS sets tab labels tight under the glyph.
          marginBottom: Platform.OS === 'ios' ? 0 : 2,
        },
        tabBarItemStyle: { paddingTop: 6 },
      }}
      screenListeners={{
        tabPress: tabPressFeedback,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          // 25 rather than 22: the iOS tab glyph is 25pt, and at 22 the icons
          // read as undersized against a system-weight label.
          tabBarIcon: ({ focused }) => (
            <HomeIcon className={focused ? 'text-primary' : 'text-muted-foreground'} size={25} />
          ),
        }}
      />
      <Tabs.Screen
        name="inspections"
        options={{
          title: 'Inspections',
          // Undefined rather than 0: React Navigation renders a badge for any
          // defined value, so zero would leave an empty dot sitting there
          // permanently.
          tabBarBadge: assignedCount > 0 ? assignedCount : undefined,
          tabBarBadgeStyle: {
            backgroundColor: theme.primary,
            // The token that exists precisely to be legible on `primary`, and
            // is measured against it (8.5:1 in light, 8.3:1 in dark). The hex
            // pair here was `#ffffff`/`#0f1720`, neither of which tracked the
            // fill behind them.
            color: theme.primaryForeground,
            fontSize: 11,
            fontWeight: '700',
          },
          tabBarAccessibilityLabel:
            assignedCount > 0
              ? `Inspections, ${assignedCount} assigned and not started`
              : 'Inspections',
          tabBarIcon: ({ focused }) => (
            <ClipboardListIcon
              className={focused ? 'text-primary' : 'text-muted-foreground'}
              size={25}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="requests"
        options={{
          title: 'Requests',
          // Same rule as Inspections: undefined, never 0, or an empty dot sits
          // on the tab for ever.
          tabBarBadge: requestCount > 0 ? requestCount : undefined,
          tabBarBadgeStyle: {
            // `chart-4` is the app's "waiting on you" tone, so this badge and
            // the pending pills inside the screens now say the same thing in
            // the same colour. It was a loose amber pair (`#f59e0b`/`#b45309`)
            // that matched nothing else.
            backgroundColor: theme.chart4,
            // Light mode's chart-4 is a dark ochre and dark mode's is a light
            // amber, so the legible label is the opposing surface rather than a
            // fixed white — which was 2.2:1 against the amber before.
            color: theme.isDark ? theme.background : theme.card,
            fontSize: 11,
            fontWeight: '700',
          },
          tabBarAccessibilityLabel:
            requestCount > 0
              ? `Requests, ${requestCount} area${requestCount === 1 ? '' : 's'} the office is waiting on`
              : 'Requests',
          tabBarIcon: ({ focused }) => (
            <InboxIcon className={focused ? 'text-primary' : 'text-muted-foreground'} size={25} />
          ),
        }}
      />
      <Tabs.Screen
        name="uploads"
        options={{
          title: 'Uploads',
          tabBarIcon: ({ focused }) => (
            <UploadCloudIcon
              className={focused ? 'text-primary' : 'text-muted-foreground'}
              size={25}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ focused }) => (
            <CogIcon className={focused ? 'text-primary' : 'text-muted-foreground'} size={25} />
          ),
        }}
      />
    </Tabs>
  );
}
