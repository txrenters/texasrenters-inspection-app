import { useState, type PropsWithChildren, type ReactNode } from 'react';
import { Platform, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ScreenEntrance } from './motion';
import { ScreenHeader, StickyActionFooter, stickyActionReservedSpace } from './ScreenPrimitives';
import { DemoModeBanner } from './ui';
import { NetworkBanner } from './NetworkBanner';
import { type AppColors, sizes, spacing, useAppTheme, useThemedStyles } from '../theme';

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
  const insets = useSafeAreaInsets();
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
        contentContainerStyle={[
          styles.content,
          {
            paddingBottom:
              (bottomAction ? stickyActionReservedSpace : spacing.xl) + insets.bottom,
          },
        ]}
      >
        <ScreenEntrance>
          <View style={styles.screenContent}>
            <ScreenHeader title={title} subtitle={subtitle} eyebrow={eyebrow} action={action} />
            <View style={styles.body}>{children}</View>
          </View>
        </ScreenEntrance>
      </ScrollView>
      {bottomAction ? <StickyActionFooter>{bottomAction}</StickyActionFooter> : null}
    </View>
  );
}

const createStyles = (colors: AppColors) =>
  StyleSheet.create({
    root: { flex: 1, minWidth: 0, overflow: 'hidden', backgroundColor: colors.canvas },
    content: {
      width: '100%',
      maxWidth: sizes.contentMax,
      minWidth: 0,
      flexGrow: 1,
      alignSelf: 'center',
      padding: spacing.md,
      ...Platform.select({ web: { boxSizing: 'border-box' as const } }),
    },
    screenContent: { width: '100%', minWidth: 0, gap: spacing.lg },
    body: { width: '100%', minWidth: 0, gap: spacing.lg },
  });
