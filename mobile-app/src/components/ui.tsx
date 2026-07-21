import type { PropsWithChildren, ReactNode } from 'react';
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { isDemoMode } from '../config/environment';
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

type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'danger' | 'ghost';

export function AppButton({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  loading = false,
  accessibilityLabel,
  compact = false,
}: {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  accessibilityLabel?: string;
  compact?: boolean;
}) {
  const { colors } = useAppTheme();
  const styles = useThemedStyles(createStyles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled, busy: loading }}
      disabled={disabled || loading}
      onPress={() => {
        blurActiveWebElement();
        onPress();
      }}
      style={({ pressed }) => [
        styles.button,
        styles[`${variant}Button`],
        compact && styles.compactButton,
        pressed && styles.pressed,
        (disabled || loading) && styles.disabled,
      ]}
    >
      {loading ? (
        <ActivityIndicator
          color={variant === 'primary' || variant === 'danger' ? colors.white : colors.primary}
        />
      ) : (
        <Text style={[styles.buttonLabel, styles[`${variant}Label`]]}>{label}</Text>
      )}
    </Pressable>
  );
}

function blurActiveWebElement() {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return;
  const activeElement = document.activeElement;
  if (activeElement instanceof HTMLElement) activeElement.blur();
}

const toneMap = (colors: AppColors) =>
  ({
    success: { background: colors.successSoft, text: colors.success, icon: '✓' },
    warning: { background: colors.warningSoft, text: colors.warning, icon: '!' },
    danger: { background: colors.dangerSoft, text: colors.danger, icon: '×' },
    info: { background: colors.infoSoft, text: colors.info, icon: '•' },
    neutral: { background: colors.surfaceMuted, text: colors.textSecondary, icon: '•' },
  }) as const;

export type StatusTone = keyof ReturnType<typeof toneMap>;

export function statusTone(status: string): StatusTone {
  if (['COMPLETED', 'APPROVED', 'READY_FOR_REVIEW', 'DOCUMENTED'].includes(status))
    return 'success';
  if (['FAILED', 'REJECTED', 'NEEDS_ATTENTION'].includes(status)) return 'danger';
  if (
    [
      'UPLOADING',
      'VIDEO_PROCESSING',
      'TRANSCRIBING',
      'ANALYZING',
      'COMPARING_BASELINE',
      'PREPARING_FINDINGS',
      'PROCESSING',
    ].includes(status)
  )
    return 'info';
  if (
    [
      'PENDING',
      'PENDING_REVIEW',
      'REVIEW_REQUIRED',
      'SCHEDULED',
      'PAUSED',
      'REINSPECTION_REQUESTED',
      'HIGH',
    ].includes(status)
  )
    return 'warning';
  return 'neutral';
}

export function formatStatus(status: string) {
  return status
    .replaceAll('_', ' ')
    .toLowerCase()
    .replace(/(^|\s)\S/g, (character) => character.toUpperCase());
}

export function StatusBadge({
  label,
  tone = statusTone(label),
}: {
  label: string;
  tone?: StatusTone;
}) {
  const { colors } = useAppTheme();
  const styles = useThemedStyles(createStyles);
  const palette = toneMap(colors)[tone];
  return (
    <View
      accessibilityLabel={formatStatus(label)}
      style={[styles.badge, { backgroundColor: palette.background }]}
    >
      <Text style={[styles.badgeIcon, { color: palette.text }]}>{palette.icon}</Text>
      <Text style={[styles.badgeText, { color: palette.text }]}>{formatStatus(label)}</Text>
    </View>
  );
}

export function ProgressBar({ value, label }: { value: number; label?: string }) {
  const styles = useThemedStyles(createStyles);
  const percentage = Math.max(0, Math.min(100, Math.round(value * 100)));
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: percentage }}
      style={styles.progressGroup}
    >
      {label ? <Text style={styles.progressLabel}>{label}</Text> : null}
      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, { width: `${percentage}%` }]} />
      </View>
    </View>
  );
}

export function Card({ children, muted = false }: PropsWithChildren<{ muted?: boolean }>) {
  const styles = useThemedStyles(createStyles);
  return <View style={[styles.card, muted && styles.mutedCard]}>{children}</View>;
}

export function SectionHeader({ title, action }: { title: string; action?: ReactNode }) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {action}
    </View>
  );
}

export function StatCard({
  value,
  label,
  tone = 'primary',
}: {
  value: number | string;
  label: string;
  tone?: 'primary' | 'success' | 'warning' | 'info';
}) {
  const { colors } = useAppTheme();
  const styles = useThemedStyles(createStyles);
  const toneColor = {
    primary: colors.primary,
    success: colors.success,
    warning: colors.warning,
    info: colors.info,
  }[tone];
  return (
    <View style={styles.statCard}>
      <View style={[styles.statMarker, { backgroundColor: toneColor }]} />
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

export function FilterChip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        selected && styles.selectedChip,
        pressed && styles.pressed,
      ]}
    >
      <Text style={[styles.chipText, selected && styles.selectedChipText]}>{label}</Text>
    </Pressable>
  );
}

export function SearchInput({
  value,
  onChangeText,
  placeholder,
}: {
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
}) {
  const { colors } = useAppTheme();
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.searchBox}>
      <Text accessibilityElementsHidden style={styles.searchIcon}>
        ⌕
      </Text>
      <TextInput
        accessibilityLabel={placeholder}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textSecondary}
        autoCapitalize="none"
        returnKeyType="search"
        style={styles.searchInput}
      />
    </View>
  );
}

export function DemoModeBanner() {
  const styles = useThemedStyles(createStyles);
  if (!isDemoMode) return null;
  return (
    <View style={styles.demoBanner}>
      <View style={styles.demoDot} />
      <Text style={styles.demoText}>Demo Mode · Local mock data</Text>
    </View>
  );
}

export function PropertyVisual({
  tone = 'teal',
  compact = false,
}: {
  tone?: 'teal' | 'navy' | 'sand' | 'sage';
  compact?: boolean;
}) {
  const styles = useThemedStyles(createStyles);
  const backgrounds = { teal: '#BDD8D5', navy: '#C6D1DC', sand: '#E7D8C5', sage: '#CFDCCB' };
  return (
    <View
      accessibilityLabel="Property image placeholder"
      style={[
        styles.propertyVisual,
        compact && styles.compactVisual,
        { backgroundColor: backgrounds[tone] },
      ]}
    >
      <View style={styles.sun} />
      <View style={styles.houseRoof} />
      <View style={styles.houseBody}>
        <View style={styles.door} />
        <View style={styles.window} />
      </View>
      <View style={styles.ground} />
    </View>
  );
}

export function ConfirmationModal({
  visible,
  title,
  message,
  confirmLabel,
  destructive = false,
  onCancel,
  onConfirm,
  children,
}: PropsWithChildren<{
  visible: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  destructive?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}>) {
  const styles = useThemedStyles(createStyles);
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.modalOverlay}>
        <View accessibilityViewIsModal style={styles.modalCard}>
          <Text style={styles.modalTitle}>{title}</Text>
          <Text style={styles.modalMessage}>{message}</Text>
          {children}
          <View style={styles.modalActions}>
            <AppButton label="Cancel" variant="ghost" onPress={onCancel} compact />
            <AppButton
              label={confirmLabel}
              variant={destructive ? 'danger' : 'primary'}
              onPress={onConfirm}
              compact
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

export function InitialsAvatar({ initials }: { initials: string }) {
  const styles = useThemedStyles(createStyles);
  return (
    <View accessibilityLabel={`Profile ${initials}`} style={styles.avatar}>
      <Text style={styles.avatarText}>{initials}</Text>
    </View>
  );
}

const createStyles = (colors: AppColors) =>
  StyleSheet.create({
    button: {
      minHeight: sizes.button,
      borderRadius: radius.md,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: spacing.lg,
    },
    compactButton: { minHeight: sizes.touch, paddingHorizontal: spacing.md, flexGrow: 0 },
    primaryButton: { backgroundColor: colors.primary },
    secondaryButton: { backgroundColor: colors.secondarySoft },
    outlineButton: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.primary },
    dangerButton: { backgroundColor: colors.danger },
    ghostButton: { backgroundColor: 'transparent' },
    buttonLabel: { ...typography.label, fontSize: 15 },
    primaryLabel: { color: colors.white },
    secondaryLabel: { color: colors.secondaryDark },
    outlineLabel: { color: colors.primary },
    dangerLabel: { color: colors.white },
    ghostLabel: { color: colors.primary },
    pressed: { opacity: 0.78, transform: [{ scale: 0.99 }] },
    disabled: { opacity: 0.46 },
    badge: {
      minHeight: 28,
      flexDirection: 'row',
      alignItems: 'center',
      alignSelf: 'flex-start',
      gap: 5,
      borderRadius: radius.round,
      paddingHorizontal: 10,
      paddingVertical: 5,
    },
    badgeIcon: { fontSize: 12, fontWeight: '900' },
    badgeText: { fontSize: 11, lineHeight: 15, fontWeight: '800' },
    progressGroup: { gap: spacing.xs },
    progressLabel: { ...typography.caption, color: colors.textSecondary },
    progressTrack: {
      height: 8,
      backgroundColor: colors.border,
      borderRadius: radius.round,
      overflow: 'hidden',
    },
    progressFill: { height: 8, backgroundColor: colors.primary, borderRadius: radius.round },
    card: {
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.lg,
      padding: spacing.md,
      gap: spacing.sm,
      ...shadows.card,
    },
    mutedCard: {
      backgroundColor: colors.surfaceMuted,
      ...Platform.select({
        web: { boxShadow: 'none' },
        default: { shadowOpacity: 0, elevation: 0 },
      }),
    },
    sectionHeader: {
      minHeight: 32,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.md,
    },
    sectionTitle: { ...typography.heading, color: colors.textPrimary },
    statCard: {
      minWidth: '46%',
      flexGrow: 1,
      backgroundColor: colors.surface,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.border,
      padding: spacing.md,
      overflow: 'hidden',
      ...shadows.card,
    },
    statMarker: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 4 },
    statValue: { ...typography.title, color: colors.textPrimary },
    statLabel: { ...typography.caption, color: colors.textSecondary, marginTop: spacing.xs },
    chip: {
      minHeight: 40,
      justifyContent: 'center',
      paddingHorizontal: spacing.md,
      borderRadius: radius.round,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
    },
    selectedChip: { backgroundColor: colors.primary, borderColor: colors.primary },
    chipText: { ...typography.label, color: colors.textSecondary },
    selectedChipText: { color: colors.white },
    searchBox: {
      minHeight: sizes.touch,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.md,
      backgroundColor: colors.surface,
      paddingHorizontal: spacing.md,
    },
    searchIcon: { color: colors.textSecondary, fontSize: 24 },
    searchInput: { flex: 1, color: colors.textPrimary, fontSize: 15, paddingVertical: spacing.sm },
    demoBanner: {
      minHeight: 32,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      backgroundColor: colors.primarySoft,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      paddingHorizontal: spacing.md,
    },
    demoDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.primary },
    demoText: { ...typography.caption, color: colors.primaryDark, fontWeight: '700' },
    propertyVisual: {
      height: 176,
      borderRadius: radius.lg,
      overflow: 'hidden',
      justifyContent: 'flex-end',
      alignItems: 'center',
    },
    compactVisual: { height: 92, width: 96, borderRadius: radius.md },
    sun: {
      position: 'absolute',
      width: 34,
      height: 34,
      borderRadius: 17,
      backgroundColor: '#F4E4AC',
      right: 20,
      top: 18,
    },
    houseRoof: {
      width: 0,
      height: 0,
      borderLeftWidth: 74,
      borderRightWidth: 74,
      borderBottomWidth: 58,
      borderLeftColor: 'transparent',
      borderRightColor: 'transparent',
      borderBottomColor: colors.primaryDark,
    },
    houseBody: {
      width: 130,
      height: 72,
      backgroundColor: '#F9F7F1',
      flexDirection: 'row',
      alignItems: 'flex-end',
      justifyContent: 'space-around',
      paddingHorizontal: spacing.md,
    },
    door: { width: 26, height: 50, backgroundColor: '#8C6D56' },
    window: {
      width: 34,
      height: 30,
      backgroundColor: '#B8D7E5',
      borderWidth: 3,
      borderColor: colors.white,
      marginBottom: spacing.md,
    },
    ground: { height: 18, alignSelf: 'stretch', backgroundColor: '#8BAA88' },
    modalOverlay: {
      flex: 1,
      backgroundColor: colors.overlay,
      justifyContent: 'center',
      padding: spacing.lg,
    },
    modalCard: {
      width: '100%',
      maxWidth: 520,
      alignSelf: 'center',
      backgroundColor: colors.surface,
      borderRadius: radius.xl,
      padding: spacing.lg,
      gap: spacing.md,
      ...shadows.floating,
    },
    modalTitle: { ...typography.heading, color: colors.textPrimary },
    modalMessage: { ...typography.body, color: colors.textSecondary },
    modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm },
    avatar: {
      width: 46,
      height: 46,
      borderRadius: 23,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.primaryDark,
    },
    avatarText: { color: colors.white, fontWeight: '800', fontSize: 15 },
  });
