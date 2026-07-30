import { router, useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { AppScreen } from '../../../../src/components/AppScreen';
import { inspectionProgress } from '../../../../src/components/FeatureCards';
import { ErrorState, LoadingState } from '../../../../src/components/ScreenStates';
import {
  AppButton,
  Card,
  ProgressBar,
  PropertyVisual,
  SectionHeader,
  StatusBadge,
  formatStatus,
} from '../../../../src/components/ui';
import { useInspectionActions, useInspectionContext } from '../../../../src/features/queries';
import { type AppColors, spacing, typography, useThemedStyles } from '../../../../src/theme';
import { formatUnitName } from '../../../../src/utils/unit-name';

export default function InspectionOverviewScreen() {
  const styles = useThemedStyles(createStyles);
  const { inspectionId = '' } = useLocalSearchParams<{ inspectionId: string }>();
  const context = useInspectionContext(inspectionId);
  const actions = useInspectionActions(inspectionId);
  if (context.isLoading) return <LoadingState label="Preparing inspection overview…" />;
  if (!context.data)
    return <ErrorState message="Inspection unavailable" onRetry={() => void context.refetch()} />;
  const { inspection, property, rooms, pendingReviewCount } = context.data;
  const unitName = formatUnitName(inspection.unitName ?? property.unitName);
  const progress = inspectionProgress(rooms);
  const required = rooms.filter((room) => room.isRequired).length;
  const pendingUploads = rooms.filter((room) => !['COMPLETED'].includes(room.uploadStatus)).length;
  const primaryLabel =
    inspection.status === 'SCHEDULED'
      ? 'Start inspection'
      : inspection.status === 'IN_PROGRESS' && progress.completed === progress.total
        ? 'Submit inspection'
        : inspection.status === 'COMPLETED'
          ? 'View completed report'
          : ['PROCESSING', 'REVIEW_REQUIRED'].includes(inspection.status)
            ? 'View submitted inspection'
            : 'Continue inspection';
  const primaryAction = async () => {
    if (inspection.status === 'SCHEDULED') await actions.start.mutateAsync();
    else if (inspection.status === 'IN_PROGRESS' && progress.completed === progress.total) {
      await actions.complete.mutateAsync();
      return;
    }
    // Submitted inspections open the consolidated report; active ones open the checklist.
    const pathname = ['PROCESSING', 'REVIEW_REQUIRED', 'COMPLETED'].includes(inspection.status)
      ? '/(app)/inspections/[inspectionId]/report'
      : '/(app)/inspections/[inspectionId]/areas';
    router.push({ pathname, params: { inspectionId } });
  };
  const actionError = actions.start.error ?? actions.complete.error;
  return (
    <AppScreen
      title={property.address}
      subtitle={`${property.cityStateZip}${unitName ? ` · ${unitName}` : ''} · ${formatStatus(inspection.type)} inspection`}
      bottomAction={
        <AppButton
          label={primaryLabel}
          loading={actions.start.isPending || actions.complete.isPending}
          onPress={() => void primaryAction()}
        />
      }
    >
      <PropertyVisual tone={property.imageTone} />
      {actionError ? (
        <Text style={styles.actionError}>
          {actionError instanceof Error ? actionError.message : 'The action could not be completed.'}
        </Text>
      ) : null}
      <View style={styles.statusRow}>
        <StatusBadge label={inspection.type} tone="info" />
        <StatusBadge label={inspection.status} />
        <StatusBadge label={inspection.priority} />
        <Text style={styles.schedule}>
          {new Intl.DateTimeFormat('en-US', {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
          }).format(new Date(inspection.scheduledAt))}
        </Text>
      </View>
      <Card muted>
        <Text style={styles.cardLabel}>
          {inspection.type === 'MOVE_IN' ? 'INITIAL CONDITION' : 'COMPARISON BASELINE'}
        </Text>
        <Text style={styles.cardBody}>
          {inspection.type === 'MOVE_IN'
            ? 'Reminder: this move-in inspection becomes the baseline every future inspection of this property is compared against. Record each room thoroughly — what you capture here defines the documented starting condition.'
            : inspection.baselineScheduledAt
              ? `Compared with the move-in inspection completed ${new Date(inspection.baselineScheduledAt).toLocaleDateString()}.`
              : 'A completed move-in inspection is required as the comparison baseline.'}
        </Text>
      </Card>
      {['SCHEDULED', 'IN_PROGRESS'].includes(inspection.status) ? (
        <Card>
          <SectionHeader title="How this inspection works" />
          <Step
            number={1}
            text="Open the room checklist and record one video per room. Snap photos of defects anytime — even while recording."
          />
          <Step
            number={2}
            text="Save and queue the recording. The next unfinished room opens immediately while the upload runs independently."
          />
          <Step
            number={3}
            text="If the connection drops, the recording stays on this device and retries automatically when the app is active again."
          />
          <Step
            number={4}
            text="After upload, the narration is transcribed and AI prepares a condition summary and reviewable findings."
          />
          <Step
            number={5}
            text="Complete every required room (or skip with a reason), then submit. AI suggestions remain pending until a person reviews them."
          />
        </Card>
      ) : null}
      <Card>
        <SectionHeader title="Inspection progress" />
        <ProgressBar
          value={progress.value}
          label={`${progress.completed} of ${progress.total} required rooms complete`}
        />
        <View style={styles.metrics}>
          <Metric value={required} label="Required rooms" />
          <Metric value={rooms.length - required} label="Optional" />
          <Metric value={pendingUploads} label="Pending uploads" />
          <Metric value={pendingReviewCount} label="Needs review" />
        </View>
      </Card>
      <Card muted>
        <Text style={styles.cardLabel}>PROPERTY NOTES</Text>
        <Text style={styles.cardBody}>{inspection.propertyNotes}</Text>
        <Text style={styles.cardLabel}>ACCESS INSTRUCTIONS</Text>
        <Text style={styles.cardBody}>{property.accessInstructions}</Text>
      </Card>
      <SectionHeader title="Plan and evidence" />
      <View style={styles.actions}>
        <AppButton
          label="View floor plan"
          variant="outline"
          onPress={() =>
            router.push({
              pathname: '/(app)/properties/[propertyId]/floor-plan',
              params: { propertyId: property.id, inspectionId },
            })
          }
        />
        <AppButton
          label="Open room list"
          variant="outline"
          onPress={() =>
            router.push({
              pathname: '/(app)/inspections/[inspectionId]/areas',
              params: { inspectionId },
            })
          }
        />
        <AppButton
          label="Review AI summary & findings"
          variant="outline"
          onPress={() =>
            router.push({
              pathname: '/(app)/inspections/[inspectionId]/findings',
              params: { inspectionId },
            })
          }
        />
        <AppButton
          label="View consolidated report"
          variant="outline"
          onPress={() =>
            router.push({
              pathname: '/(app)/inspections/[inspectionId]/report',
              params: { inspectionId },
            })
          }
        />
      </View>
    </AppScreen>
  );
}

function Metric({ value, label }: { value: number; label: string }) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.metric}>
      <Text style={styles.metricValue}>{value}</Text>
      <Text style={styles.metricLabel}>{label}</Text>
    </View>
  );
}

function Step({ number, text }: { number: number; text: string }) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.step}>
      <View style={styles.stepBadge}>
        <Text style={styles.stepNumber}>{number}</Text>
      </View>
      <Text style={styles.stepText}>{text}</Text>
    </View>
  );
}

const createStyles = (colors: AppColors) =>
  StyleSheet.create({
    statusRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm },
    schedule: {
      ...typography.caption,
      color: colors.textSecondary,
      flexGrow: 1,
      flexShrink: 1,
      textAlign: 'right',
    },
    metrics: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    metric: {
      minWidth: '46%',
      flexGrow: 1,
      padding: spacing.sm,
      backgroundColor: colors.background,
      borderRadius: 10,
    },
    metricValue: { ...typography.heading, color: colors.textPrimary },
    metricLabel: { ...typography.caption, color: colors.textSecondary },
    cardLabel: {
      ...typography.caption,
      color: colors.primary,
      fontWeight: '800',
      letterSpacing: 0.6,
    },
    cardBody: { ...typography.body, color: colors.textPrimary },
    actions: { gap: spacing.sm },
    actionError: { ...typography.caption, color: colors.danger },
    step: { minWidth: 0, flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
    stepBadge: {
      width: 22,
      height: 22,
      borderRadius: 11,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.primarySoft,
      marginTop: 2,
    },
    stepNumber: { ...typography.caption, color: colors.primary, fontWeight: '800' },
    stepText: { ...typography.caption, color: colors.textSecondary, flex: 1 },
  });
