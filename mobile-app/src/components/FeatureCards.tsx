import Ionicons from '@expo/vector-icons/Ionicons';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';

import type { Finding, Inspection, InspectionRoom, Property, UploadItem } from '../domain/models';
import { AppButton, Card, ProgressBar, PropertyVisual, StatusBadge, formatStatus } from './ui';
import { type AppColors, radius, spacing, typography, useAppTheme, useThemedStyles } from '../theme';
import { formatUnitName } from '../utils/unit-name';
import { inspectionUrgency } from '../utils/inspection-alerts';
import { usePulse } from './motion';

export function inspectionProgress(rooms: InspectionRoom[]) {
  const required = rooms.filter((room) => room.isRequired);
  const completed = required.filter((room) =>
    ['COMPLETED', 'SKIPPED'].includes(room.completionStatus),
  ).length;
  return {
    completed,
    total: required.length,
    value: required.length ? completed / required.length : 0,
  };
}

export function InspectionSummaryCard({
  inspection,
  property,
  progress,
  onPress,
}: {
  inspection: Inspection;
  property: Pick<Property, 'address' | 'cityStateZip' | 'imageTone'>;
  progress: Inspection['progress'];
  onPress: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  const { colors } = useAppTheme();
  const progressValue = progress.total ? progress.completed / progress.total : 0;
  const uploadAttention = progress.hasFailedUpload;
  const unitName = formatUnitName(inspection.unitName);
  const urgency = inspectionUrgency(inspection);
  const isOverdue = urgency === 'overdue';
  const pulse = usePulse(isOverdue);
  const action =
    inspection.status === 'SCHEDULED'
      ? 'Start inspection'
      : inspection.status === 'COMPLETED'
        ? 'View report'
        : [
              'TECHNICIAN_SUBMITTED',
              'PROCESSING',
              'REVIEW_REQUIRED',
              'UNDER_REVIEW',
              'TBD',
              'FOLLOW_UP_REQUIRED',
            ].includes(inspection.status)
          ? 'View submitted inspection'
          : 'Continue inspection';
  const accessibilityLabel = isOverdue
    ? `Overdue: ${action} at ${property.address}`
    : `${action} at ${property.address}`;
  return (
    <Pressable
      testID="inspection-summary-card"
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={({ pressed }) => [
        styles.inspectionCard,
        isOverdue && styles.overdueCard,
        pressed && styles.pressed,
      ]}
    >
      {isOverdue ? (
        <Animated.View
          style={[
            styles.overdueRing,
            { opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.3, 1] }) },
          ]}
        />
      ) : null}
      <View testID="inspection-summary-header" style={styles.inspectionHeader}>
        <View style={styles.summaryBadges}>
          <StatusBadge label={inspection.type} tone="info" />
          {unitName ? <StatusBadge label={unitName} tone="info" /> : null}
          {urgency === 'overdue' ? (
            <StatusBadge label="OVERDUE" tone="danger" />
          ) : urgency === 'due_soon' ? (
            <StatusBadge label="DUE SOON" tone="warning" />
          ) : (
            <StatusBadge label={inspection.status} />
          )}
          <StatusBadge
            label={`${formatStatus(inspection.priority)} priority`}
            tone={inspection.priority === 'HIGH' ? 'warning' : 'neutral'}
          />
        </View>
      </View>
      <View testID="inspection-summary-property-row" style={styles.inspectionTop}>
        <PropertyVisual tone={property.imageTone} compact />
        <View testID="inspection-summary-copy" style={styles.inspectionCopy}>
          <Text style={styles.cardTitle}>{property.address}</Text>
          <Text style={styles.cardBody}>{property.cityStateZip}</Text>
          <Text style={styles.date}>{formatDateTime(inspection.scheduledAt)}</Text>
        </View>
      </View>
      <ProgressBar
        value={progressValue}
        label={`${progress.completed} of ${progress.total} required rooms complete`}
      />
      <View style={styles.rowBetween}>
        <View testID="inspection-summary-action-row" style={styles.statusRow}>
          <StatusBadge
            label={uploadAttention ? 'FAILED' : 'PENDING'}
            tone={uploadAttention ? 'danger' : 'warning'}
          />
          <View style={styles.primaryAction}>
            <Text style={styles.primaryActionText}>{action}</Text>
            <Ionicons name="arrow-forward" size={16} color={colors.primary} />
          </View>
        </View>
      </View>
    </Pressable>
  );
}

export function RoomCard({
  room,
  onPress,
  sequenceNumber,
  isUpNext = false,
}: {
  room: InspectionRoom;
  onPress: () => void;
  sequenceNumber?: number;
  isUpNext?: boolean;
}) {
  const styles = useThemedStyles(createStyles);
  const recordingLabel =
    room.completionStatus === 'NOT_STARTED'
      ? 'No recording'
      : formatStatus(room.completionStatus);
  const uploadLabel =
    room.uploadStatus === 'COMPLETED'
      ? 'Uploaded'
      : room.uploadStatus === 'FAILED'
        ? 'Upload failed'
        : 'Queued';
  const processingLabel =
    room.processingStatus === 'READY_FOR_REVIEW'
      ? 'AI ready'
      : room.processingStatus === 'NOT_STARTED'
        ? 'AI pending'
        : 'AI processing';
  const nextAction =
    room.uploadStatus === 'FAILED'
      ? 'Retry upload'
      : room.processingStatus !== 'NOT_STARTED' && room.processingStatus !== 'READY_FOR_REVIEW'
        ? 'View status'
        : room.completionStatus === 'NOT_STARTED'
          ? 'Start recording'
          : room.reviewStatus === 'PENDING_REVIEW'
            ? 'Review finding'
            : 'Open room';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${isUpNext ? 'Up next: ' : ''}${nextAction} for ${room.name}`}
      onPress={onPress}
      style={({ pressed }) => [
        styles.roomCard,
        isUpNext && styles.upNextCard,
        pressed && styles.pressed,
      ]}
    >
      <View style={styles.roomHeader}>
        {sequenceNumber != null ? (
          <View style={[styles.sequenceBadge, isUpNext && styles.sequenceBadgeActive]}>
            <Text style={[styles.sequenceNumber, isUpNext && styles.sequenceNumberActive]}>
              {sequenceNumber}
            </Text>
          </View>
        ) : null}
        <View style={styles.flex}>
          <Text style={styles.cardTitle}>{room.name}</Text>
          <Text style={styles.cardBody}>
            {room.floorName} · {room.isRequired ? 'Required' : 'Optional'}
          </Text>
        </View>
        <View style={styles.roomTrailing}>
          <StatusBadge
            label={
              isUpNext
                ? 'UP NEXT'
                : room.completionStatus === 'COMPLETED'
                  ? 'COMPLETED'
                  : room.completionStatus
            }
            tone={isUpNext ? 'info' : undefined}
          />
          <Ionicons name="chevron-forward" size={20} style={styles.chevronIcon} />
        </View>
      </View>
      <View style={styles.evidenceSummary}>
        <Text style={styles.evidenceSummaryText}>
          {recordingLabel} · {uploadLabel} · {processingLabel}
        </Text>
      </View>
      <View style={styles.nextAction}>
        <Text style={styles.nextActionLabel}>{isUpNext ? 'NEXT AREA' : 'ROOM ACTION'}</Text>
        <Text style={styles.actionText}>{nextAction}</Text>
      </View>
    </Pressable>
  );
}

export function UploadProgressCard({
  item,
  onRetry,
  onPause,
  onResume,
  onRemove,
  onViewRoom,
}: {
  item: UploadItem;
  onRetry: () => void;
  onPause: () => void;
  onResume: () => void;
  onRemove: () => void;
  onViewRoom: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <Card>
      <View style={styles.rowBetween}>
        <View style={styles.flex}>
          <Text style={styles.cardTitle}>{item.roomName}</Text>
          <Text style={styles.cardBody}>{item.propertyAddress}</Text>
        </View>
        <StatusBadge label={item.status} />
      </View>
      <Text style={styles.meta}>
        {formatDuration(item.durationSeconds)} · {item.estimatedSizeMb.toFixed(1)} MB
      </Text>
      <ProgressBar value={item.progress} label={`${Math.round(item.progress * 100)}% uploaded`} />
      {item.lastError ? (
        <Text accessibilityRole="alert" style={styles.errorText}>
          {item.lastError}
        </Text>
      ) : null}
      {item.status === 'COMPLETED' ? (
        <ProcessingTimeline status={item.processingStatus} progress={item.processingProgress} />
      ) : null}
      <View style={styles.actionRow}>
        {item.status === 'FAILED' ? <AppButton label="Retry" onPress={onRetry} compact /> : null}
        {item.status === 'UPLOADING' ? (
          <AppButton label="Pause" variant="outline" onPress={onPause} compact />
        ) : null}
        {item.status === 'PAUSED' || item.status === 'PENDING' ? (
          <AppButton label="Resume" onPress={onResume} compact />
        ) : null}
        <AppButton label="View room" variant="ghost" onPress={onViewRoom} compact />
        <AppButton label="Remove" variant="ghost" onPress={onRemove} compact />
      </View>
    </Card>
  );
}

const processingSteps = [
  ['VIDEO_PROCESSING', 'Video processing'],
  ['TRANSCRIBING', 'Transcribing narration'],
  ['ANALYZING', 'Analyzing room condition'],
  ['COMPARING_BASELINE', 'Comparing baseline'],
  ['PREPARING_FINDINGS', 'Preparing findings'],
  ['READY_FOR_REVIEW', 'Ready for review'],
] as const;

export function ProcessingTimeline({
  status,
  progress,
}: {
  status: UploadItem['processingStatus'];
  progress: number;
}) {
  const styles = useThemedStyles(createStyles);
  const activeIndex = processingSteps.findIndex(([value]) => value === status);
  return (
    <View accessibilityLabel={`Processing status ${formatStatus(status)}`} style={styles.timeline}>
      <Text style={styles.timelineHeading}>AI processing</Text>
      {processingSteps.map(([value, label], index) => {
        const completed = status === 'READY_FOR_REVIEW' || index < activeIndex;
        const active = index === activeIndex && !completed;
        return (
          <View key={value} style={styles.timelineRow}>
            <View
              style={[
                styles.timelineDot,
                completed && styles.timelineComplete,
                active && styles.timelineActive,
              ]}
            >
              <Text style={styles.timelineDotText}>{completed ? '✓' : active ? '•' : ''}</Text>
            </View>
            <Text style={[styles.timelineText, (completed || active) && styles.timelineTextActive]}>
              {label}
            </Text>
          </View>
        );
      })}
      <ProgressBar value={progress} />
    </View>
  );
}

export function FindingSummaryCard({
  finding,
  onPress,
}: {
  finding: Finding;
  onPress: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Review ${finding.title}`}
      onPress={onPress}
      style={({ pressed }) => [styles.findingCard, pressed && styles.pressed]}
    >
      <View style={styles.rowBetween}>
        <Text style={styles.eyebrow}>{finding.roomName.toUpperCase()}</Text>
        <StatusBadge label={finding.reviewStatus} />
      </View>
      <Text style={styles.cardTitle}>{finding.title}</Text>
      <Text style={styles.cardBody}>
        {finding.category} · {formatStatus(finding.comparisonResult)}
      </Text>
      <View style={styles.rowBetween}>
        <StatusBadge
          label={finding.severity}
          tone={finding.severity === 'HIGH' ? 'danger' : 'warning'}
        />
        <Text style={styles.confidence}>
          {Math.round(finding.confidence * 100)}% confidence · {finding.videoTimestampStart}s
        </Text>
      </View>
      <Text style={styles.recommendation}>{finding.recommendedReview}</Text>
    </Pressable>
  );
}

/**
 * Screen-level banner warning about overdue (and, failing that, due-soon)
 * inspections. Overdue takes priority and reads as danger; due-soon reads as a
 * softer warning. Renders nothing when there is nothing to warn about.
 */
export function InspectionAlertBanner({
  overdueCount,
  dueSoonCount,
  onPress,
}: {
  overdueCount: number;
  dueSoonCount: number;
  onPress?: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  const { colors } = useAppTheme();
  const pulse = usePulse(overdueCount > 0);
  if (overdueCount === 0 && dueSoonCount === 0) return null;
  const overdue = overdueCount > 0;
  const message = overdue
    ? `${overdueCount} inspection${overdueCount === 1 ? '' : 's'} overdue — start ${overdueCount === 1 ? 'it' : 'them'} now.`
    : `${dueSoonCount} inspection${dueSoonCount === 1 ? '' : 's'} due soon.`;
  return (
    <Pressable
      accessibilityRole={onPress ? 'button' : 'summary'}
      accessibilityLabel={message}
      onPress={onPress}
      style={[styles.alertBanner, overdue ? styles.alertBannerDanger : styles.alertBannerWarning]}
    >
      <Animated.View style={{ opacity: overdue ? pulse : 1 }}>
        <Ionicons
          name={overdue ? 'alert-circle' : 'time-outline'}
          size={20}
          color={overdue ? colors.danger : colors.warning}
        />
      </Animated.View>
      <Text
        style={[styles.alertBannerText, { color: overdue ? colors.danger : colors.warning }]}
      >
        {message}
      </Text>
      {onPress ? (
        <Ionicons
          name="chevron-forward"
          size={18}
          color={overdue ? colors.danger : colors.warning}
        />
      ) : null}
    </Pressable>
  );
}

export function formatDateTime(value: string) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

export function formatDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

const createStyles = (colors: AppColors) =>
  StyleSheet.create({
    summaryBadges: {
      minWidth: 0,
      flexGrow: 1,
      flexShrink: 1,
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'flex-start',
      gap: spacing.xs,
    },
    inspectionCard: {
      width: '100%',
      minWidth: 0,
      alignSelf: 'stretch',
      overflow: 'hidden',
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.lg,
      padding: spacing.md,
      gap: spacing.md,
    },
    overdueCard: {
      borderColor: colors.danger,
      backgroundColor: colors.dangerSoft,
    },
    overdueRing: {
      pointerEvents: 'none',
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      borderRadius: radius.lg,
      borderWidth: 2,
      borderColor: colors.danger,
    },
    alertBanner: {
      width: '100%',
      minWidth: 0,
      alignSelf: 'stretch',
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      borderRadius: radius.md,
      borderWidth: 1,
      paddingVertical: spacing.sm,
      paddingHorizontal: spacing.md,
    },
    alertBannerDanger: {
      backgroundColor: colors.dangerSoft,
      borderColor: colors.danger,
    },
    alertBannerWarning: {
      backgroundColor: colors.warningSoft,
      borderColor: colors.warning,
    },
    alertBannerText: { ...typography.label, flex: 1, minWidth: 0, flexShrink: 1 },
    inspectionHeader: {
      width: '100%',
      minWidth: 0,
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      gap: spacing.sm,
    },
    inspectionTop: {
      width: '100%',
      minWidth: 0,
      flexDirection: 'row',
      flexWrap: 'nowrap',
      alignItems: 'flex-start',
      gap: spacing.sm,
    },
    roomCard: {
      width: '100%',
      minWidth: 0,
      alignSelf: 'stretch',
      overflow: 'hidden',
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.lg,
      padding: spacing.md,
      gap: spacing.sm,
    },
    upNextCard: { borderColor: colors.primary, borderWidth: 2 },
    sequenceBadge: {
      width: 26,
      height: 26,
      borderRadius: 13,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surfaceMuted,
      marginRight: spacing.sm,
    },
    sequenceBadgeActive: { backgroundColor: colors.primary },
    sequenceNumber: { ...typography.caption, color: colors.textSecondary, fontWeight: '800' },
    sequenceNumberActive: { color: colors.white },
    findingCard: {
      width: '100%',
      minWidth: 0,
      alignSelf: 'stretch',
      overflow: 'hidden',
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.lg,
      padding: spacing.md,
      gap: spacing.sm,
    },
    pressed: { opacity: 0.8, transform: [{ scale: 0.995 }] },
    flex: { flex: 1, minWidth: 0 },
    inspectionCopy: {
      minWidth: 0,
      flexGrow: 1,
      flexShrink: 1,
      flexBasis: 0,
    },
    rowBetween: {
      width: '100%',
      minWidth: 0,
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
    },
    roomHeader: {
      width: '100%',
      minWidth: 0,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    roomTrailing: {
      maxWidth: '42%',
      minWidth: 0,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'flex-end',
      gap: spacing.xs,
    },
    eyebrow: {
      ...typography.caption,
      color: colors.primary,
      fontWeight: '800',
      letterSpacing: 0.5,
      flexShrink: 1,
    },
    cardTitle: { ...typography.heading, color: colors.textPrimary, flexShrink: 1 },
    cardBody: { ...typography.body, color: colors.textSecondary, flexShrink: 1 },
    date: { ...typography.caption, color: colors.textPrimary, marginTop: spacing.xs },
    meta: { ...typography.caption, color: colors.textSecondary },
    statusRow: {
      flex: 1,
      minWidth: 0,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      flexWrap: 'wrap',
    },
    actionText: { ...typography.label, color: colors.primary, flexShrink: 1 },
    primaryAction: {
      minHeight: 36,
      minWidth: 0,
      flexGrow: 1,
      flexShrink: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'flex-end',
      gap: spacing.xs,
    },
    primaryActionText: {
      ...typography.label,
      color: colors.primary,
      textAlign: 'right',
      flexShrink: 1,
    },
    chevronIcon: { color: colors.primary },
    evidenceSummary: {
      minHeight: 34,
      justifyContent: 'center',
      borderRadius: radius.sm,
      backgroundColor: colors.surfaceMuted,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xs,
    },
    evidenceSummaryText: {
      ...typography.caption,
      color: colors.textSecondary,
      flexShrink: 1,
    },
    nextAction: {
      minWidth: 0,
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
    },
    nextActionLabel: { ...typography.caption, color: colors.textSecondary, fontWeight: '800' },
    errorText: {
      ...typography.caption,
      color: colors.danger,
      backgroundColor: colors.dangerSoft,
      borderRadius: radius.sm,
      padding: spacing.sm,
    },
    actionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    timeline: {
      gap: spacing.sm,
      padding: spacing.md,
      borderRadius: radius.md,
      backgroundColor: colors.infoSoft,
    },
    timelineHeading: { ...typography.label, color: colors.info },
    timelineRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    timelineDot: {
      width: 22,
      height: 22,
      borderRadius: 11,
      borderWidth: 2,
      borderColor: colors.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    timelineComplete: { backgroundColor: colors.success, borderColor: colors.success },
    timelineActive: { borderColor: colors.info, backgroundColor: colors.white },
    timelineDotText: { color: colors.white, fontSize: 11, fontWeight: '900' },
    timelineText: { ...typography.caption, color: colors.textSecondary },
    timelineTextActive: { color: colors.textPrimary, fontWeight: '700' },
    confidence: {
      ...typography.caption,
      color: colors.textSecondary,
      textAlign: 'right',
      flexShrink: 1,
    },
    recommendation: {
      ...typography.caption,
      color: colors.info,
      backgroundColor: colors.infoSoft,
      borderRadius: radius.sm,
      padding: spacing.sm,
    },
  });
