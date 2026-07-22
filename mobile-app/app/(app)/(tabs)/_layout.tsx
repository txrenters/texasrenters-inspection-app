import { useEffect, useRef, type ComponentProps } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import { Animated, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  type AppColors,
  radius,
  shadows,
  useAppTheme,
  useThemedStyles,
} from '../../../src/theme';

const icons: Record<string, ComponentProps<typeof Ionicons>['name']> = {
  dashboard: 'home-outline',
  inspections: 'clipboard-outline',
  uploads: 'cloud-upload-outline',
  settings: 'settings-outline',
};

function TabIcon({ name, focused }: { name: string; focused: boolean }) {
  const { colors } = useAppTheme();
  const styles = useThemedStyles(createStyles);
  const progress = useRef(new Animated.Value(focused ? 1 : 0)).current;

  useEffect(() => {
    Animated.spring(progress, {
      toValue: focused ? 1 : 0,
      speed: 28,
      bounciness: 4,
      useNativeDriver: true,
    }).start();
  }, [focused, progress]);

  return (
    <Animated.View
      style={[
        styles.iconShell,
        focused && styles.activeIconShell,
        {
          transform: [
            { scale: progress.interpolate({ inputRange: [0, 1], outputRange: [1, 1.08] }) },
          ],
        },
      ]}
    >
      <Ionicons
        name={icons[name] ?? 'ellipse-outline'}
        size={21}
        color={focused ? colors.primary : colors.textSecondary}
      />
    </Animated.View>
  );
}

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
          tabBarHideOnKeyboard: true,
          tabBarItemStyle: styles.tabItem,
          tabBarIcon: ({ focused }) => <TabIcon name={route.name} focused={focused} />,
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
      minHeight: 76,
      paddingTop: 8,
      paddingBottom: 9,
      borderTopColor: colors.border,
      backgroundColor: colors.surface,
      ...shadows.floating,
    },
    tabItem: { paddingVertical: 2 },
    label: { fontSize: 10, fontWeight: '800', letterSpacing: 0.15 },
    iconShell: {
      width: 40,
      height: 30,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.md,
    },
    activeIconShell: { backgroundColor: colors.primarySoft },
  });
