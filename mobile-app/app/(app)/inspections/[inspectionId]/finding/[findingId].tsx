import { useState } from 'react';
import { Alert, StyleSheet, Text, TextInput, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';

import { AppScreen } from '../../../../../src/components/AppScreen';
import { ErrorState, LoadingState } from '../../../../../src/components/ScreenStates';
import {
  AppButton,
  Card,
  ConfirmationModal,
  SectionHeader,
  StatusBadge,
} from '../../../../../src/components/ui';
import { isDemoMode } from '../../../../../src/config/environment';
import { useFinding, useFindingActions } from '../../../../../src/features/queries';
import {
  type AppColors,
  radius,
  spacing,
  typography,
  useThemedStyles,
} from '../../../../../src/theme';

type Dialog = 'approve' | 'edit' | 'reject' | 'reinspect' | null;

export default function FindingDetailScreen() {
  const styles = useThemedStyles(createStyles);
  const { inspectionId = '', findingId = '' } = useLocalSearchParams<{
    inspectionId: string;
    findingId: string;
  }>();
  const finding = useFinding(findingId, inspectionId);
  const actions = useFindingActions(inspectionId, findingId);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [reason, setReason] = useState('');
  const [observation, setObservation] = useState('');
  const [notes, setNotes] = useState('');
  if (finding.isLoading) return <LoadingState label="Loading finding evidence…" />;
  if (!finding.data)
    return <ErrorState message="Finding unavailable" onRetry={() => void finding.refetch()} />;
  const closeSuccess = (message: string) => {
    setDialog(null);
    setReason('');
    Alert.alert('Review saved', message);
  };
  const error = actions.reject.error ?? actions.reinspect.error ?? actions.edit.error;
  return (
    <AppScreen
      title={finding.data.title}
      subtitle={`${finding.data.roomName} · ${
        isDemoMode ? 'Human review required' : 'Read-only · reviewed in the admin console'
      }`}
    >
      <View style={styles.video}>
        <View style={styles.play}>
          <Text style={styles.playText}>▶</Text>
        </View>
        <Text style={styles.videoLabel}>
          ROOM VIDEO · {finding.data.videoTimestampStart}s–{finding.data.videoTimestampEnd}s
        </Text>
        <AppButton
          label={`Jump to ${finding.data.videoTimestampStart}s`}
          variant="secondary"
          onPress={() =>
            Alert.alert(
              'Video position updated',
              `Demo playback moved to ${finding.data.videoTimestampStart} seconds.`,
            )
          }
          compact
        />
      </View>
      <View style={styles.badges}>
        <StatusBadge label={finding.data.reviewStatus} />
        <StatusBadge label={finding.data.severity} />
        <StatusBadge label={finding.data.comparisonResult} />
      </View>
      <Card>
        <SectionHeader title="Baseline comparison" />
        <Comparison
          label="MOVE-IN BASELINE"
          text={finding.data.baselineCondition}
          tone="baseline"
        />
        <Comparison
          label="MOVE-OUT OBSERVATION"
          text={finding.data.observation}
          tone="observation"
        />
      </Card>
      <Card muted>
        <Text style={styles.label}>AI-ASSISTED SUMMARY</Text>
        <Text style={styles.body}>{finding.data.aiSummary}</Text>
        <Text style={styles.confidence}>
          {Math.round(finding.data.confidence * 100)}% model confidence · Not a confirmed fact
        </Text>
        <Text style={styles.recommendation}>{finding.data.recommendedReview}</Text>
      </Card>
      <Card>
        <SectionHeader title="Reference evidence" />
        <View style={styles.thumbnails}>
          {[1, 2, 3].map((number) => (
            <View key={number} style={styles.thumbnail}>
              <Text style={styles.thumbnailText}>MOVE-IN {number}</Text>
            </View>
          ))}
        </View>
      </Card>
      {finding.data.reviewerNotes ? (
        <Card>
          <Text style={styles.label}>REVIEWER NOTES</Text>
          <Text style={styles.body}>{finding.data.reviewerNotes}</Text>
        </Card>
      ) : null}
      {isDemoMode ? (
        <View style={styles.actions}>
          <AppButton label="Approve" onPress={() => setDialog('approve')} />
          <AppButton
            label="Edit observation"
            variant="outline"
            onPress={() => {
              setObservation(finding.data.observation);
              setNotes(finding.data.reviewerNotes ?? '');
              setDialog('edit');
            }}
          />
          <AppButton label="Reject" variant="outline" onPress={() => setDialog('reject')} />
          <AppButton
            label="Request reinspection"
            variant="secondary"
            onPress={() => setDialog('reinspect')}
          />
        </View>
      ) : null}
      <Text style={styles.disclaimer}>
        {isDemoMode
          ? 'Approval confirms this finding for inspection review only. It does not authorize financial charges or determine legal responsibility.'
          : 'Findings are approved or rejected by reviewers in the TexasRenters admin console. Nothing here authorizes financial charges.'}
      </Text>
      <ConfirmationModal
        visible={dialog === 'approve'}
        title="Approve this finding?"
        message="Confirm that you reviewed the room video, timestamp, and move-in baseline."
        confirmLabel="Approve finding"
        onCancel={() => setDialog(null)}
        onConfirm={() =>
          actions.approve.mutate(undefined, {
            onSuccess: () => closeSuccess('The finding is marked approved for human review.'),
          })
        }
      />
      <ConfirmationModal
        visible={dialog === 'reject' || dialog === 'reinspect'}
        title={dialog === 'reject' ? 'Reject this finding?' : 'Request room reinspection?'}
        message="A specific reason is required and will be saved with the review decision."
        confirmLabel={dialog === 'reject' ? 'Reject finding' : 'Request reinspection'}
        destructive={dialog === 'reject'}
        onCancel={() => setDialog(null)}
        onConfirm={() => {
          const mutation = dialog === 'reject' ? actions.reject : actions.reinspect;
          mutation.mutate(reason, {
            onSuccess: () =>
              closeSuccess(
                dialog === 'reject'
                  ? 'The finding was rejected.'
                  : 'A room reinspection was requested.',
              ),
          });
        }}
      >
        <TextInput
          accessibilityLabel="Review decision reason"
          value={reason}
          onChangeText={setReason}
          placeholder="Required reason"
          multiline
          style={styles.input}
        />
        {error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {error.message}
          </Text>
        ) : null}
      </ConfirmationModal>
      <ConfirmationModal
        visible={dialog === 'edit'}
        title="Edit inspection observation"
        message="Revise the observation and add reviewer context. The decision will be marked Edited."
        confirmLabel="Save edit"
        onCancel={() => setDialog(null)}
        onConfirm={() =>
          actions.edit.mutate(
            { observation, notes },
            { onSuccess: () => closeSuccess('The reviewer edit was saved.') },
          )
        }
      >
        <TextInput
          accessibilityLabel="Edited observation"
          value={observation}
          onChangeText={setObservation}
          multiline
          style={styles.input}
        />
        <TextInput
          accessibilityLabel="Reviewer notes"
          value={notes}
          onChangeText={setNotes}
          placeholder="Reviewer notes"
          multiline
          style={styles.input}
        />
        {error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {error.message}
          </Text>
        ) : null}
      </ConfirmationModal>
    </AppScreen>
  );
}

function Comparison({
  label,
  text,
  tone,
}: {
  label: string;
  text: string;
  tone: 'baseline' | 'observation';
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={[styles.comparison, tone === 'observation' && styles.observation]}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.body}>{text}</Text>
    </View>
  );
}

const createStyles = (colors: AppColors) =>
  StyleSheet.create({
    video: {
      minHeight: 210,
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.md,
      borderRadius: radius.lg,
      backgroundColor: colors.primaryDark,
    },
    play: {
      width: 58,
      height: 58,
      borderRadius: 29,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.white,
    },
    playText: { color: colors.primaryDark, fontSize: 23, marginLeft: 3 },
    videoLabel: { ...typography.caption, color: colors.primarySoft },
    badges: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    comparison: {
      gap: spacing.xs,
      padding: spacing.md,
      borderRadius: radius.md,
      backgroundColor: colors.successSoft,
    },
    observation: { backgroundColor: colors.warningSoft },
    label: { ...typography.caption, color: colors.primary, fontWeight: '800', letterSpacing: 0.5 },
    body: { ...typography.body, color: colors.textPrimary },
    confidence: { ...typography.caption, color: colors.info, fontWeight: '700' },
    recommendation: {
      ...typography.body,
      color: colors.textPrimary,
      borderLeftWidth: 3,
      borderLeftColor: colors.info,
      paddingLeft: spacing.md,
    },
    thumbnails: { flexDirection: 'row', gap: spacing.sm },
    thumbnail: {
      height: 78,
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.sm,
      backgroundColor: colors.surfaceMuted,
    },
    thumbnailText: { ...typography.caption, color: colors.textSecondary, fontSize: 10 },
    actions: { gap: spacing.sm },
    disclaimer: {
      ...typography.caption,
      color: colors.textSecondary,
      textAlign: 'center',
      padding: spacing.md,
    },
    input: {
      minHeight: 86,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.md,
      padding: spacing.md,
      color: colors.textPrimary,
      textAlignVertical: 'top',
    },
    error: { ...typography.caption, color: colors.danger },
  });
