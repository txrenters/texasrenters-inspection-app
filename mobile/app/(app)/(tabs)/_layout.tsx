import { Tabs } from 'expo-router';
import {
  HomeIcon,
  ClipboardListIcon,
  InboxIcon,
  UploadCloudIcon,
  CogIcon,
} from 'lucide-react-native';
import { useAssignedInspectionCount, useOpenEvidenceRequests } from '@/src/features/queries';
import { registerIcons } from '@/src/lib/icons';
import { useThemeColors } from '@/src/lib/theme-colors';

registerIcons(HomeIcon);
registerIcons(ClipboardListIcon);
registerIcons(UploadCloudIcon);
registerIcons(CogIcon);

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
        tabBarStyle: {
          backgroundColor: theme.background,
          borderTopColor: theme.border,
          paddingBottom: 4,
          height: 56,
        },
        tabBarActiveTintColor: theme.primary,
        tabBarInactiveTintColor: theme.mutedForeground,
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: '600',
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarIcon: ({ focused }) => (
            <HomeIcon className={focused ? 'text-primary' : 'text-muted-foreground'} size={22} />
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
              size={22}
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
            <InboxIcon
              className={focused ? 'text-primary' : 'text-muted-foreground'}
              size={22}
            />
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
              size={22}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ focused }) => (
            <CogIcon className={focused ? 'text-primary' : 'text-muted-foreground'} size={22} />
          ),
        }}
      />
    </Tabs>
  );
}
