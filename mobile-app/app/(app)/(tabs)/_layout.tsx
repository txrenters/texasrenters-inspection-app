import type { ComponentProps } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Tabs } from 'expo-router';
import { StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useInspectionAlerts } from '../../../src/features/useInspectionAlerts';
import { type AppColors, useAppTheme, useThemedStyles } from '../../../src/theme';

const icons: Record<
  string,
  [ComponentProps<typeof Ionicons>['name'], ComponentProps<typeof Ionicons>['name']]
> = {
  dashboard: ['home-outline', 'home'],
  inspections: ['clipboard-outline', 'clipboard'],
  uploads: ['cloud-upload-outline', 'cloud-upload'],
  settings: ['settings-outline', 'settings'],
};

export default function TabsLayout() {
  const { colors } = useAppTheme();
  const styles = useThemedStyles(createStyles);
  const { overdueCount, alertCount } = useInspectionAlerts();
  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <Tabs
        screenOptions={({ route }) => ({
          headerShown: false,
          tabBarActiveTintColor: colors.primary,
          tabBarInactiveTintColor: colors.textSecondary,
          tabBarStyle: styles.tabBar,
          tabBarLabelStyle: styles.label,
          tabBarHideOnKeyboard: true,
          tabBarIcon: ({ color, focused }) => {
            const names = icons[route.name] ?? ['ellipse-outline', 'ellipse'];
            return <Ionicons name={names[focused ? 1 : 0]} size={22} color={color} />;
          },
        })}
      >
        <Tabs.Screen
          name="dashboard"
          options={{
            title: 'Home',
            // Alert the technician to overdue/due-soon inspections from any tab.
            tabBarBadge: alertCount > 0 ? alertCount : undefined,
            tabBarBadgeStyle: {
              backgroundColor: overdueCount > 0 ? colors.danger : colors.warning,
              color: colors.surface,
              fontSize: 11,
            },
          }}
        />
        <Tabs.Screen name="inspections" options={{ title: 'Inspections' }} />
        <Tabs.Screen name="uploads" options={{ title: 'Uploads' }} />
        <Tabs.Screen name="settings" options={{ title: 'Settings' }} />
      </Tabs>
    </SafeAreaView>
  );
}

const createStyles = (colors: AppColors) =>
  StyleSheet.create({
    safeArea: { flex: 1, backgroundColor: colors.canvas },
    tabBar: {
      minHeight: 74,
      paddingTop: 8,
      paddingBottom: 9,
      borderTopColor: colors.border,
      backgroundColor: colors.surface,
    },
    label: { fontSize: 10, fontWeight: '700', letterSpacing: 0.1 },
  });
