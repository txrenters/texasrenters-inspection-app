import { useState, type PropsWithChildren, type ReactNode } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { ScreenEntrance } from './motion';
import { DemoModeBanner } from './ui';
import { NetworkBanner } from './NetworkBanner';
import {
  type AppColors,
  radius,
  shadows,
  sizes,
  spacing,
  typography,
  useAppTheme,
  useThemedStyles,
} from '../theme';

export function AppScreen({
  title,
  subtitle,
  eyebrow = 'FIELD WORKSPACE',
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
          <View style={styles.entranceContent}>
            <View style={styles.headerCard}>
              <View style={styles.headerAccent} />
              <View style={styles.header}>
                <View style={styles.flex}>
                  <Text style={styles.eyebrow}>{eyebrow}</Text>
                  <Text style={styles.title}>{title}</Text>
                  {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
                </View>
                {action}
              </View>
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
      paddingHorizontal: spacing.md,
      paddingTop: spacing.md,
      paddingBottom: 104,
    },
    entranceContent: { gap: spacing.lg },
    body: { gap: spacing.lg },
    headerCard: {
      position: 'relative',
      overflow: 'hidden',
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.xl,
      backgroundColor: colors.surface,
      ...shadows.card,
    },
    headerAccent: {
      position: 'absolute',
      left: 0,
      top: 0,
      bottom: 0,
      width: 5,
      backgroundColor: colors.secondary,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingVertical: 20,
    },
    flex: { flex: 1 },
    eyebrow: {
      ...typography.caption,
      color: colors.primary,
      fontSize: 10,
      fontWeight: '900',
      letterSpacing: 1.35,
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
      ...shadows.floating,
    },
  });
