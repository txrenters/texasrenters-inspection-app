import type { ReactElement, ReactNode } from 'react';
import {
  FlatList,
  type FlatListProps,
  KeyboardAvoidingView,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DemoModeBanner } from './ui';
import { NetworkBanner } from './NetworkBanner';
import { ScreenEntrance } from './motion';
import { type AppColors, sizes, spacing, typography, useAppTheme, useThemedStyles } from '../theme';

const STICKY_ACTION_MIN_HEIGHT = 88;

export function ScreenHeader({
  title,
  subtitle,
  eyebrow,
  action,
}: {
  title: string;
  subtitle?: string;
  eyebrow?: string;
  action?: ReactNode;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.header}>
      <View style={styles.headerCopy}>
        {eyebrow ? <Text style={styles.eyebrow}>{eyebrow}</Text> : null}
        <Text style={styles.title}>{title}</Text>
        {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
      </View>
      {action}
    </View>
  );
}

export function StickyActionFooter({
  children,
  testID = 'sticky-action-footer',
}: {
  children: ReactNode;
  testID?: string;
}) {
  const insets = useSafeAreaInsets();
  const styles = useThemedStyles(createStyles);
  return (
    <View
      testID={testID}
      style={[styles.stickyFooter, { paddingBottom: Math.max(spacing.md, insets.bottom) }]}
    >
      {children}
    </View>
  );
}

export function EvidenceSummary({
  items,
}: {
  items: Array<{
    label: string;
    value: string;
    complete?: boolean;
    attention?: boolean;
  }>;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.evidencePanel}>
      {items.map((item, index) => (
        <View key={item.label} style={[styles.evidenceRow, index > 0 && styles.evidenceDivider]}>
          <View
            style={[
              styles.evidenceIcon,
              item.complete && styles.evidenceIconComplete,
              item.attention && styles.evidenceIconAttention,
            ]}
          >
            <Ionicons
              name={item.complete ? 'checkmark' : item.attention ? 'alert' : 'ellipse-outline'}
              size={14}
              style={styles.evidenceIconGlyph}
            />
          </View>
          <Text style={styles.evidenceLabel}>{item.label}</Text>
          <Text style={styles.evidenceValue} numberOfLines={2}>
            {item.value}
          </Text>
        </View>
      ))}
    </View>
  );
}

export function KeyboardAwareFormScreen({
  title,
  subtitle,
  children,
  bottomAction,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  bottomAction: ReactNode;
}) {
  const styles = useThemedStyles(createStyles);
  const insets = useSafeAreaInsets();
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 56 : 0}
      style={styles.root}
    >
      <ScrollView
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[
          styles.formContent,
          { paddingBottom: STICKY_ACTION_MIN_HEIGHT + insets.bottom },
        ]}
      >
        <ScreenHeader title={title} subtitle={subtitle} />
        <View style={styles.formBody}>{children}</View>
      </ScrollView>
      <StickyActionFooter>{bottomAction}</StickyActionFooter>
    </KeyboardAvoidingView>
  );
}

export function AppListScreen<ItemT>({
  title,
  subtitle,
  eyebrow,
  action,
  header,
  bottomAction,
  refresh,
  contentGap = spacing.md,
  ...listProps
}: {
  title: string;
  subtitle?: string;
  eyebrow?: string;
  action?: ReactNode;
  header?: ReactNode;
  bottomAction?: ReactNode;
  refresh?: {
    onRefresh: () => void | Promise<unknown>;
    refreshing?: boolean;
  };
  contentGap?: number;
} & Omit<
  FlatListProps<ItemT>,
  'ListHeaderComponent' | 'contentContainerStyle' | 'refreshControl'
>): ReactElement {
  const { colors } = useAppTheme();
  const styles = useThemedStyles(createStyles);
  const insets = useSafeAreaInsets();
  const listHeader = (
    <ScreenEntrance>
      <View style={styles.listHeader}>
        <ScreenHeader title={title} subtitle={subtitle} eyebrow={eyebrow} action={action} />
        {header}
      </View>
    </ScreenEntrance>
  );

  return (
    <View style={styles.root}>
      <DemoModeBanner />
      <NetworkBanner />
      <FlatList
        {...listProps}
        testID={listProps.testID ?? 'app-list-screen'}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={listHeader}
        refreshControl={
          refresh ? (
            <RefreshControl
              refreshing={refresh.refreshing ?? false}
              onRefresh={() => void refresh.onRefresh()}
              tintColor={colors.primary}
            />
          ) : undefined
        }
        contentContainerStyle={[
          styles.listContent,
          {
            gap: contentGap,
            paddingBottom:
              (bottomAction ? STICKY_ACTION_MIN_HEIGHT : spacing.xl) + insets.bottom,
          },
        ]}
      />
      {bottomAction ? <StickyActionFooter>{bottomAction}</StickyActionFooter> : null}
    </View>
  );
}

export const stickyActionReservedSpace = STICKY_ACTION_MIN_HEIGHT;

const createStyles = (colors: AppColors) =>
  StyleSheet.create({
    root: {
      flex: 1,
      minWidth: 0,
      overflow: 'hidden',
      backgroundColor: colors.canvas,
    },
    header: {
      width: '100%',
      minWidth: 0,
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.md,
      paddingHorizontal: spacing.xs,
      paddingTop: spacing.sm,
    },
    headerCopy: { flex: 1, minWidth: 0 },
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
    listHeader: { width: '100%', minWidth: 0, gap: spacing.lg },
    listContent: {
      width: '100%',
      maxWidth: sizes.contentMax,
      minWidth: 0,
      flexGrow: 1,
      alignSelf: 'center',
      padding: spacing.md,
      ...Platform.select({ web: { boxSizing: 'border-box' as const } }),
    },
    formContent: {
      width: '100%',
      maxWidth: sizes.contentMax,
      minWidth: 0,
      flexGrow: 1,
      alignSelf: 'center',
      padding: spacing.md,
      gap: spacing.lg,
      ...Platform.select({ web: { boxSizing: 'border-box' as const } }),
    },
    formBody: { width: '100%', minWidth: 0, gap: spacing.md },
    evidencePanel: {
      width: '100%',
      overflow: 'hidden',
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 14,
      backgroundColor: colors.surface,
    },
    evidenceRow: {
      minHeight: 48,
      minWidth: 0,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
    evidenceDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
    evidenceIcon: {
      width: 24,
      height: 24,
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surfaceMuted,
    },
    evidenceIconComplete: { backgroundColor: colors.successSoft },
    evidenceIconAttention: { backgroundColor: colors.warningSoft },
    evidenceIconGlyph: { color: colors.textSecondary },
    evidenceLabel: { ...typography.label, color: colors.textPrimary, flex: 1, minWidth: 0 },
    evidenceValue: {
      ...typography.caption,
      maxWidth: '46%',
      color: colors.textSecondary,
      textAlign: 'right',
      flexShrink: 1,
    },
    stickyFooter: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      minHeight: STICKY_ACTION_MIN_HEIGHT,
      justifyContent: 'center',
      borderTopWidth: 1,
      borderTopColor: colors.border,
      backgroundColor: colors.surface,
      paddingHorizontal: spacing.md,
      paddingTop: spacing.sm,
      ...Platform.select({ web: { boxSizing: 'border-box' as const } }),
    },
  });
