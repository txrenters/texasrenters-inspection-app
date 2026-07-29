import { Tabs } from 'expo-router';
import { HomeIcon, ClipboardListIcon, UploadCloudIcon, CogIcon } from 'lucide-react-native';
import { cssInterop, useColorScheme } from 'nativewind';

cssInterop(HomeIcon, { className: { target: 'style', nativeStyleToProp: { color: true } } });
cssInterop(ClipboardListIcon, { className: { target: 'style', nativeStyleToProp: { color: true } } });
cssInterop(UploadCloudIcon, { className: { target: 'style', nativeStyleToProp: { color: true } } });
cssInterop(CogIcon, { className: { target: 'style', nativeStyleToProp: { color: true } } });

export default function TabsLayout() {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

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
          tabBarIcon: ({ focused }) => (
            <ClipboardListIcon className={focused ? 'text-primary' : 'text-muted-foreground'} size={22} />
          ),
        }}
      />
      <Tabs.Screen
        name="uploads"
        options={{
          title: 'Uploads',
          tabBarIcon: ({ focused }) => (
            <UploadCloudIcon className={focused ? 'text-primary' : 'text-muted-foreground'} size={22} />
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
