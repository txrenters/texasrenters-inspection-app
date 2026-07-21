import { Tabs } from 'expo-router';
import { StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { type AppColors, sizes, useAppTheme, useThemedStyles } from '../../../src/theme';

const icons: Record<string, string> = {
  dashboard: '⌂',
  inspections: '▣',
  uploads: '⇧',
  settings: '⚙',
};

export default function TabsLayout() {
  const { colors } = useAppTheme();
  const styles = useThemedStyles(createStyles);
  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <Tabs
        screenOptions={({ route }) => ({
          headerShown: false,
          tabBarActiveTintColor: colors.primary,
          tabBarInactiveTintColor: colors.textSecondary,
          tabBarStyle: styles.tabBar,
          tabBarLabelStyle: styles.label,
          tabBarIcon: ({ color }) => (
            <Text style={[styles.icon, { color }]}>{icons[route.name] ?? '•'}</Text>
          ),
        })}
      >
        <Tabs.Screen name="dashboard" options={{ title: 'Home' }} />
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
      minHeight: 68,
      paddingTop: 7,
      paddingBottom: 8,
      borderTopColor: colors.border,
      backgroundColor: colors.surface,
    },
    label: { fontSize: 11, fontWeight: '700' },
    icon: { fontSize: sizes.icon, lineHeight: 26 },
  });
