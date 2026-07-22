import { useState, type PropsWithChildren, type ReactNode } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { ScreenEntrance } from './motion';
import { DemoModeBanner } from './ui';
import { NetworkBanner } from './NetworkBanner';
import { type AppColors, sizes, spacing, typography, useAppTheme, useThemedStyles } from '../theme';

export function AppScreen({
  title,
  subtitle,
  eyebrow,
  action,
  bottomAction,
  refresh,
  children,
}: PropsWithChildren<{
  title: string;
  subtitle?: string;
  eyebrow?: string;
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
        showsVerticalScrollIndicator={false}
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
        <ScreenEntrance>
          <View style={styles.screenContent}>
            <View style={styles.header}>
              <View style={styles.flex}>
                {eyebrow ? <Text style={styles.eyebrow}>{eyebrow}</Text> : null}
                <Text style={styles.title}>{title}</Text>
                {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
              </View>
              {action}
            </View>
            <View style={styles.body}>{children}</View>
          </View>
        </ScreenEntrance>
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
    },
    screenContent: { gap: spacing.lg },
    body: { gap: spacing.lg },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingHorizontal: spacing.xs,
      paddingTop: spacing.sm,
    },
    flex: { flex: 1 },
    eyebrow: {
      ...typography.caption,
      color: colors.primary,
      fontSize: 10,
      fontWeight: '900',
      letterSpacing: 1.25,
      marginBottom: spacing.xs,
    },
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
