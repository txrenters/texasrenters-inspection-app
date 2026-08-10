import { Tabs } from 'expo-router';
import { HomeIcon, ClipboardListIcon, UploadCloudIcon, CogIcon } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import { useAssignedInspectionCount } from '@/src/features/queries';
import { registerIcons } from '@/src/lib/icons';

registerIcons(HomeIcon);
registerIcons(ClipboardListIcon);
registerIcons(UploadCloudIcon);
registerIcons(CogIcon);

export default function TabsLayout() {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  // Assigned-but-not-started work. Live: the realtime provider invalidates the
  // inspection queries when an assignment lands, so this moves without the
  // technician reopening anything.
  const assigned = useAssignedInspectionCount();
  const assignedCount = assigned.data ?? 0;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: isDark ? '#0f1720' : '#fcfbf8',
          borderTopColor: isDark ? '#1e2a38' : '#e2ded9',
          paddingBottom: 4,
          height: 56,
        },
        tabBarActiveTintColor: isDark ? '#2dd4bf' : '#145347',
        tabBarInactiveTintColor: isDark ? '#5e6b78' : '#9a9484',
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
            backgroundColor: isDark ? '#2dd4bf' : '#145347',
            color: isDark ? '#0f1720' : '#ffffff',
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
