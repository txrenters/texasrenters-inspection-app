import type { ComponentProps, PropsWithChildren, ReactNode } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { Badge as ReusableBadge } from './ui/badge';
import { Button as ReusableButton } from './ui/button';
import { Card as ReusableCard } from './ui/card';
import { Progress as ReusableProgress } from './ui/progress';
import { Text as ReusableText } from './ui/text';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { cn } from '../lib/utils';
import { isDemoMode } from '../config/environment';
import {
  type AppColors,
  radius,
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
  icon,
}: {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  accessibilityLabel?: string;
  compact?: boolean;
  icon?: ComponentProps<typeof Ionicons>['name'];
}) {
  const { colors } = useAppTheme();
  const reusableVariant = {
    primary: 'default',
    secondary: 'secondary',
    outline: 'outline',
    danger: 'destructive',
    ghost: 'ghost',
  }[variant] as 'default' | 'secondary' | 'outline' | 'destructive' | 'ghost';

  return (
    <ReusableButton
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled, busy: loading }}
      disabled={disabled || loading}
      variant={reusableVariant}
      size={compact ? 'sm' : 'lg'}
      className={cn('min-h-11', compact && 'px-3')}
      onPress={() => {
        blurActiveWebElement();
        onPress();
      }}
    >
      {loading ? (
        <ActivityIndicator
          color={variant === 'primary' || variant === 'danger' ? colors.white : colors.primary}
        />
      ) : (
        <>
          {icon ? (
            <Ionicons
              name={icon}
              size={18}
              color={
                variant === 'primary' || variant === 'danger' ? colors.white : colors.primary
              }
            />
          ) : null}
          <ReusableText className="shrink text-center text-[15px] font-semibold">
            {label}
          </ReusableText>
        </>
      )}
    </ReusableButton>
  );
}

function blurActiveWebElement() {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return;
  const activeElement = document.activeElement;
  if (activeElement instanceof HTMLElement) activeElement.blur();
}

const toneMap = {
  success: {
    container: 'border-approved/20 bg-approved/15',
    text: 'text-approved',
    icon: '✓',
  },
  warning: {
    container: 'border-needs-review/20 bg-needs-review/15',
    text: 'text-needs-review',
    icon: '!',
  },
  danger: {
    container: 'border-failed/20 bg-failed/15',
    text: 'text-failed',
    icon: '×',
  },
  info: {
    container: 'border-uploading/20 bg-uploading/15',
    text: 'text-uploading',
    icon: '•',
  },
  neutral: {
    container: 'border-border bg-muted',
    text: 'text-muted-foreground',
    icon: '•',
  },
} as const;

export type StatusTone = keyof typeof toneMap;

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
  const palette = toneMap[tone];
  return (
    <ReusableBadge
      variant="outline"
      accessibilityLabel={formatStatus(label)}
      style={nativeBadgeStyles.container}
      className={cn(
        'min-h-7 max-w-full shrink self-start gap-1 px-2.5 py-1',
        palette.container,
      )}
    >
      <ReusableText className={cn('text-[11px] font-black', palette.text)}>
        {palette.icon}
      </ReusableText>
      <ReusableText
        style={nativeBadgeStyles.label}
        className={cn('min-w-0 shrink text-[11px] font-extrabold', palette.text)}
      >
        {formatStatus(label)}
      </ReusableText>
    </ReusableBadge>
  );
}

export function ProgressBar({ value, label }: { value: number; label?: string }) {
  const styles = useThemedStyles(createStyles);
  const percentage = Math.max(0, Math.min(100, Math.round(value * 100)));
  return (
    <View style={styles.progressGroup}>
      {label ? <Text style={styles.progressLabel}>{label}</Text> : null}
      <ReusableProgress
        value={percentage}
        accessibilityLabel={label}
        style={nativeProgressStyles.root}
        className="h-2 bg-primary/20"
        indicatorClassName="bg-primary"
      />
    </View>
  );
}

export function Card({ children, muted = false }: PropsWithChildren<{ muted?: boolean }>) {
  return (
    <ReusableCard
      className={cn(
        'w-full min-w-0 gap-4 p-4 py-4 shadow-none',
        muted && 'border-transparent bg-muted',
      )}
    >
      {children}
    </ReusableCard>
  );
}

export function SectionHeader({
  title,
  action,
  icon,
}: {
  title: string;
  action?: ReactNode;
  icon?: ComponentProps<typeof Ionicons>['name'];
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.sectionHeader}>
      <View style={styles.sectionHeading}>
        {icon ? <Ionicons name={icon} size={18} style={styles.sectionIcon} /> : null}
        <Text style={styles.sectionTitle}>{title}</Text>
      </View>
      {action}
    </View>
  );
}

export function StatCard({
  value,
  label,
  tone = 'primary',
  icon,
}: {
  value: number | string;
  label: string;
  tone?: 'primary' | 'success' | 'warning' | 'info';
  icon?: ComponentProps<typeof Ionicons>['name'];
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
      <View style={styles.statTopRow}>
        <Text style={styles.statValue}>{value}</Text>
        {icon ? <Ionicons name={icon} size={19} color={toneColor} /> : null}
      </View>
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
      <Ionicons accessibilityElementsHidden name="search" size={20} color={colors.textSecondary} />
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
      <View style={[styles.sun, compact && styles.compactSun]} />
      <View style={[styles.houseRoof, compact && styles.compactHouseRoof]} />
      <View style={[styles.houseBody, compact && styles.compactHouseBody]}>
        <View style={[styles.door, compact && styles.compactDoor]} />
        <View style={[styles.window, compact && styles.compactWindow]} />
      </View>
      <View style={[styles.ground, compact && styles.compactGround]} />
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
  if (!destructive) {
    return (
      <Dialog
        open={visible}
        onOpenChange={(open) => {
          if (!open) onCancel();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{message}</DialogDescription>
          </DialogHeader>
          {children}
          <DialogFooter>
            <ReusableButton variant="outline" onPress={onCancel}>
              <ReusableText>Cancel</ReusableText>
            </ReusableButton>
            <ReusableButton onPress={onConfirm}>
              <ReusableText>{confirmLabel}</ReusableText>
            </ReusableButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <AlertDialog
      open={visible}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{message}</AlertDialogDescription>
        </AlertDialogHeader>
        {children}
        <AlertDialogFooter>
          <AlertDialogCancel onPress={onCancel}>
            <Text>Cancel</Text>
          </AlertDialogCancel>
          <ReusableButton variant="destructive" onPress={onConfirm}>
            <ReusableText>{confirmLabel}</ReusableText>
          </ReusableButton>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
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

const nativeBadgeStyles = StyleSheet.create({
  container: {
    maxWidth: '100%',
    flexShrink: 1,
    alignSelf: 'flex-start',
  },
  label: {
    minWidth: 0,
    flexShrink: 1,
  },
});

const nativeProgressStyles = StyleSheet.create({
  root: {
    width: '100%',
    minWidth: 0,
    height: 8,
    flexShrink: 0,
  },
});

const createStyles = (colors: AppColors) =>
  StyleSheet.create({
    pressed: { opacity: 0.78, transform: [{ scale: 0.975 }] },
    progressGroup: { width: '100%', minWidth: 0, gap: spacing.xs },
    progressLabel: { ...typography.caption, color: colors.textSecondary, flexShrink: 1 },
    sectionHeader: {
      width: '100%',
      minWidth: 0,
      minHeight: 32,
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.md,
    },
    sectionHeading: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minWidth: 0 },
    sectionIcon: { color: colors.primary },
    sectionTitle: { ...typography.heading, color: colors.textPrimary, flexShrink: 1 },
    statCard: {
      minWidth: '46%',
      flexGrow: 1,
      padding: spacing.md,
    },
    statTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    statValue: { ...typography.title, color: colors.textPrimary },
    statLabel: { ...typography.caption, color: colors.textSecondary, marginTop: spacing.xs },
    chip: {
      minHeight: 40,
      justifyContent: 'center',
      paddingHorizontal: spacing.md,
      borderRadius: radius.round,
      backgroundColor: colors.surfaceMuted,
    },
    selectedChip: { backgroundColor: colors.primary, borderColor: colors.primary },
    chipText: { ...typography.label, color: colors.textSecondary },
    selectedChipText: { color: colors.white },
    searchBox: {
      width: '100%',
      minWidth: 0,
      minHeight: sizes.touch,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      borderRadius: radius.md,
      backgroundColor: colors.surfaceMuted,
      paddingHorizontal: spacing.md,
    },
    searchInput: {
      flex: 1,
      minWidth: 0,
      color: colors.textPrimary,
      fontSize: 15,
      paddingVertical: spacing.sm,
    },
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
      width: '100%',
      minWidth: 0,
      height: 176,
      borderRadius: radius.lg,
      overflow: 'hidden',
      justifyContent: 'flex-end',
      alignItems: 'center',
    },
    compactVisual: {
      width: 78,
      minWidth: 78,
      maxWidth: 78,
      height: 72,
      flexGrow: 0,
      flexShrink: 0,
      borderRadius: radius.md,
    },
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
    compactHouseRoof: {
      borderLeftWidth: 35,
      borderRightWidth: 35,
      borderBottomWidth: 26,
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
    compactHouseBody: {
      width: 62,
      height: 36,
      paddingHorizontal: spacing.xs,
    },
    door: { width: 26, height: 50, backgroundColor: '#8C6D56' },
    compactDoor: { width: 15, height: 25 },
    window: {
      width: 34,
      height: 30,
      backgroundColor: '#B8D7E5',
      borderWidth: 3,
      borderColor: colors.white,
      marginBottom: spacing.md,
    },
    compactWindow: {
      width: 20,
      height: 17,
      borderWidth: 2,
      marginBottom: 6,
    },
    ground: { height: 18, alignSelf: 'stretch', backgroundColor: '#8BAA88' },
    compactGround: { height: 10 },
    compactSun: { width: 18, height: 18, borderRadius: 9, right: 8, top: 7 },
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
