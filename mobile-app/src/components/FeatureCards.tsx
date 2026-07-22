import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, Text, View } from 'react-native';

import type { Finding, Inspection, InspectionRoom, Property, UploadItem } from '../domain/models';
import { MotionPressable } from './motion';
import { AppButton, Card, ProgressBar, PropertyVisual, StatusBadge, formatStatus } from './ui';
import { type AppColors, radius, shadows, spacing, typography, useThemedStyles } from '../theme';

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
  const progressValue = progress.total ? progress.completed / progress.total : 0;
  const uploadAttention = progress.hasFailedUpload;
  const action =
    inspection.status === 'SCHEDULED'
      ? 'Start inspection'
      : inspection.status === 'COMPLETED'
        ? 'View report'
        : ['PROCESSING', 'REVIEW_REQUIRED'].includes(inspection.status)
          ? 'View submitted inspection'
          : 'Continue inspection';
  return (
    <MotionPressable
      accessibilityRole="button"
      accessibilityLabel={`${action} at ${property.address}`}
      onPress={onPress}
      style={styles.inspectionCard}
    >
      <View style={styles.inspectionHeader}>
        <Text numberOfLines={2} style={styles.eyebrow}>
          {formatStatus(inspection.type)} · {inspection.priority}
        </Text>
        <StatusBadge label={inspection.status} />
      </View>
      <View style={styles.inspectionTop}>
        <PropertyVisual tone={property.imageTone} compact />
        <View style={styles.flex}>
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
        <View style={styles.statusRow}>
          <StatusBadge
            label={uploadAttention ? 'FAILED' : 'PENDING'}
            tone={uploadAttention ? 'danger' : 'warning'}
          />
          <Text style={styles.actionText}>{action}</Text>
          <View style={styles.actionArrow}>
            <Ionicons name="arrow-forward" size={16} style={styles.actionArrowIcon} />
          </View>
        </View>
      </View>
    </MotionPressable>
  );
}

export function RoomCard({ room, onPress }: { room: InspectionRoom; onPress: () => void }) {
  const styles = useThemedStyles(createStyles);
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
    <MotionPressable
      accessibilityRole="button"
      accessibilityLabel={`${nextAction} for ${room.name}`}
      onPress={onPress}
      style={styles.roomCard}
    >
      <View style={styles.rowBetween}>
        <View style={styles.flex}>
          <Text style={styles.cardTitle}>{room.name}</Text>
          <Text style={styles.cardBody}>
            {room.floorName} · {room.isRequired ? 'Required' : 'Optional'}
          </Text>
        </View>
        <View style={styles.chevronShell}>
          <Ionicons name="chevron-forward" size={18} style={styles.chevron} />
        </View>
      </View>
      <View style={styles.statusGrid}>
        <StatusLine label="Baseline" value={room.baseline.condition} />
        <StatusLine label="Recording" value={room.completionStatus} />
        <StatusLine label="Upload" value={room.uploadStatus} />
        <StatusLine label="AI review" value={room.processingStatus} />
      </View>
      <View style={styles.nextAction}>
        <Text style={styles.nextActionLabel}>NEXT</Text>
        <Text style={styles.actionText}>{nextAction}</Text>
      </View>
    </MotionPressable>
  );
}

function StatusLine({ label, value }: { label: string; value: string }) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.statusLine}>
      <Text style={styles.statusLabel}>{label}</Text>
      <StatusBadge label={value} />
    </View>
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
    <MotionPressable
      accessibilityRole="button"
      accessibilityLabel={`Review ${finding.title}`}
      onPress={onPress}
      style={styles.findingCard}
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
    </MotionPressable>
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
    inspectionCard: {
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.xl,
      padding: 18,
      gap: spacing.md,
      ...shadows.card,
    },
    inspectionHeader: {
      minWidth: 0,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
    },
    inspectionTop: { flexDirection: 'row', gap: spacing.md },
    roomCard: {
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.xl,
      padding: 18,
      gap: spacing.md,
      ...shadows.card,
    },
    findingCard: {
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.xl,
      padding: 18,
      gap: spacing.sm,
      ...shadows.card,
    },
    flex: { flex: 1, minWidth: 0 },
    rowBetween: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
    },
    eyebrow: {
      ...typography.caption,
      color: colors.primary,
      fontWeight: '800',
      letterSpacing: 0.5,
      flexShrink: 1,
    },
    cardTitle: { ...typography.heading, color: colors.textPrimary },
    cardBody: { ...typography.body, color: colors.textSecondary },
    date: { ...typography.caption, color: colors.textPrimary, marginTop: spacing.xs },
    meta: { ...typography.caption, color: colors.textSecondary },
    statusRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
    actionText: { ...typography.label, color: colors.primary, flex: 1 },
    actionArrow: {
      width: 30,
      height: 30,
      borderRadius: 10,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.primarySoft,
    },
    actionArrowIcon: { color: colors.primary },
    chevronShell: {
      width: 34,
      height: 34,
      borderRadius: 11,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.primarySoft,
    },
    chevron: { color: colors.primary },
    statusGrid: {
      gap: spacing.sm,
      padding: spacing.sm,
      backgroundColor: colors.background,
      borderRadius: radius.md,
    },
    statusLine: {
      minHeight: 30,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
    },
    statusLabel: { ...typography.caption, color: colors.textSecondary },
    nextAction: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
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
    confidence: { ...typography.caption, color: colors.textSecondary, textAlign: 'right' },
    recommendation: {
      ...typography.caption,
      color: colors.info,
      backgroundColor: colors.infoSoft,
      borderRadius: radius.sm,
      padding: spacing.sm,
    },
  });
