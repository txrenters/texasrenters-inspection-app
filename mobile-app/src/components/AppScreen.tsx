import { useState, type PropsWithChildren, type ReactNode } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { DemoModeBanner } from './ui';
import { NetworkBanner } from './NetworkBanner';
import { type AppColors, sizes, spacing, typography, useAppTheme, useThemedStyles } from '../theme';

export function AppScreen({
  title,
  subtitle,
  action,
  bottomAction,
  refresh,
  children,
}: PropsWithChildren<{
  title: string;
  subtitle?: string;
  action?: ReactNode;
  bottomAction?: ReactNode;
  refresh?: {
    onRefresh: () => void | Promise<unknown>;
    refreshing?: boolean;
  };
}>) {
  const { colors } = useAppTheme();
  const styles = useThemedStyles(createStyles);
  const [manualRefreshActive, setManualRefreshActive] = useState(false);
  const refreshActive = refresh?.refreshing ?? manualRefreshActive;
  const handleRefresh = async () => {
    if (!refresh || refreshActive) return;
    setManualRefreshActive(true);
    try {
      await refresh.onRefresh();
    } finally {
      setManualRefreshActive(false);
    }
  };
  return (
    <View style={styles.root}>
      <DemoModeBanner />
      <NetworkBanner />
      <ScrollView
        testID="app-screen-scroll"
        accessibilityState={{ busy: refreshActive }}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          refresh ? (
            <RefreshControl
              refreshing={refreshActive}
              onRefresh={() => void handleRefresh()}
              tintColor={colors.primary}
            />
          ) : undefined
        }
        contentContainerStyle={styles.content}
      >
        <View style={styles.header}>
          <View style={styles.flex}>
            <Text style={styles.title}>{title}</Text>
            {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
          </View>
          {action}
        </View>
        {children}
      </ScrollView>
      {bottomAction ? <View style={styles.bottomAction}>{bottomAction}</View> : null}
    </View>
  );
}

const createStyles = (colors: AppColors) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.canvas },
    content: {
      width: '100%',
      maxWidth: sizes.contentMax,
      alignSelf: 'center',
      padding: spacing.md,
      paddingBottom: 104,
      gap: spacing.md,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      marginVertical: spacing.sm,
    },
    flex: { flex: 1 },
    title: { ...typography.title, color: colors.textPrimary },
    subtitle: { ...typography.body, color: colors.textSecondary, marginTop: spacing.xs },
    bottomAction: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: colors.surface,
      borderTopWidth: 1,
      borderTopColor: colors.border,
      padding: spacing.md,
    },
  });
