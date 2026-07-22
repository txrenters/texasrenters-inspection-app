import { useEffect, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { Alert, StyleSheet, Text, TextInput, View } from 'react-native';

import { AppScreen } from '../../../../../../src/components/AppScreen';
import { formatDuration } from '../../../../../../src/components/FeatureCards';
import { ErrorState, LoadingState } from '../../../../../../src/components/ScreenStates';
import {
  AppButton,
  Card,
  ConfirmationModal,
  SectionHeader,
  StatusBadge,
} from '../../../../../../src/components/ui';
import { isDemoMode } from '../../../../../../src/config/environment';
import { useRoom, useRoomMedia, useUpdateRoom } from '../../../../../../src/features/queries';
import {
  type AppColors,
  radius,
  spacing,
  typography,
  useThemedStyles,
} from '../../../../../../src/theme';

export default function RoomDetailsScreen() {
  const styles = useThemedStyles(createStyles);
  const { inspectionId = '', areaId = '' } = useLocalSearchParams<{
    inspectionId: string;
    areaId: string;
  }>();
  const room = useRoom(areaId);
  const media = useRoomMedia(areaId);
  const actions = useUpdateRoom(inspectionId, areaId);
  const [note, setNote] = useState('');
  const [skipOpen, setSkipOpen] = useState(false);
  const [skipReason, setSkipReason] = useState('');
  useEffect(() => setNote(room.data?.note ?? ''), [room.data?.note]);
  if (room.isLoading || media.isLoading) return <LoadingState label="Loading room baseline…" />;
  if (!room.data)
    return <ErrorState message="Room unavailable" onRetry={() => void room.refetch()} />;
  const hasSavedRecording = Boolean(media.data?.length);
  const completionStatus =
    hasSavedRecording && room.data.completionStatus === 'NOT_STARTED'
      ? 'RECORDING_SAVED'
      : room.data.completionStatus;
  const roomClosed = completionStatus === 'COMPLETED';
  const record = () => {
    const navigate = () =>
      router.push({
        pathname: '/(app)/inspections/[inspectionId]/area/[areaId]/record',
        params: { inspectionId, areaId },
      });
    if (!hasSavedRecording) return navigate();
    // Exactly one video per room: recording again replaces the saved one.
    Alert.alert(
      'Replace room video?',
      'Each room keeps exactly one video. Recording again replaces the current recording for this room.',
      [
        { text: 'Keep current video', style: 'cancel' },
        { text: 'Replace video', style: 'destructive', onPress: navigate },
      ],
    );
  };
  return (
    <AppScreen
      title={room.data.name}
      subtitle={`${room.data.floorName} · ${room.data.isRequired ? 'Required room' : 'Optional room'}`}
      bottomAction={
        roomClosed ? undefined : (
          <AppButton
            label={!hasSavedRecording ? 'Record room video' : 'Replace room video'}
            onPress={record}
          />
        )
      }
    >
      <View style={styles.badges}>
        <StatusBadge label={completionStatus} />
        <StatusBadge label={room.data.uploadStatus} />
        <StatusBadge label={room.data.processingStatus} />
      </View>
      <Card>
        <SectionHeader
          title={room.data.inspectionType === 'MOVE_IN' ? 'Initial condition' : 'Move-in baseline'}
          action={<StatusBadge label={room.data.baseline.condition} />}
        />
        <Text style={styles.body}>{room.data.baseline.summary}</Text>
        <Text style={styles.meta}>
          {room.data.baseline.evidenceCount} reference photos available
        </Text>
        <Text style={styles.label}>EXISTING DOCUMENTED DEFECTS</Text>
        {room.data.baseline.existingDefects.length ? (
          room.data.baseline.existingDefects.map((defect) => (
            <Text key={defect} style={styles.defect}>
              • {defect}
            </Text>
          ))
        ) : (
          <Text style={styles.meta}>No existing defects documented.</Text>
        )}
        <View style={styles.thumbnails}>
          {Array.from({ length: Math.min(3, room.data.baseline.evidenceCount) }).map((_, index) => (
            <View
              key={index}
              accessibilityLabel={`Baseline evidence ${index + 1}`}
              style={styles.thumbnail}
            >
              <Text style={styles.thumbnailText}>PHOTO {index + 1}</Text>
            </View>
          ))}
        </View>
      </Card>
      <Card>
        <SectionHeader title="Current recordings" />
        {media.data?.length ? (
          media.data.map((item) => (
            <View key={item.id} style={styles.mediaRow}>
              <View style={styles.play}>
                <Text style={styles.playText}>▶</Text>
              </View>
              <View style={styles.flex}>
                <Text style={styles.mediaTitle}>Room video</Text>
                <Text style={styles.meta}>
                  {formatDuration(item.durationSeconds)} ·{' '}
                  {new Date(item.recordedAt).toLocaleString()}
                </Text>
              </View>
              <StatusBadge label="SAVED" tone="success" />
            </View>
          ))
        ) : (
          <Text style={styles.meta}>No recording saved for this room yet.</Text>
        )}
      </Card>
      <Card>
        <SectionHeader title="Technician note" />
        <TextInput
          accessibilityLabel="Room note"
          value={note}
          onChangeText={setNote}
          placeholder="Add an observation or reminder"
          multiline
          style={styles.input}
        />
        <AppButton
          label="Save note"
          variant="outline"
          onPress={() => actions.note.mutate(note)}
          loading={actions.note.isPending}
          compact
        />
      </Card>
      <Card muted>
        <SectionHeader title="Room status" />
        <Timeline label="Baseline reviewed" complete />
        <Timeline label="Recording saved" complete={hasSavedRecording} />
        <Timeline label="Upload confirmed" complete={room.data.uploadStatus === 'COMPLETED'} />
        <Timeline
          label="AI findings ready"
          complete={room.data.processingStatus === 'READY_FOR_REVIEW'}
        />
      </Card>
      <View style={styles.actions}>
        {isDemoMode ? (
          <AppButton
            label="Add photo"
            variant="outline"
            onPress={() =>
              Alert.alert(
                'Demo photo added',
                'Photo capture is represented as local mock evidence in this frontend demo.',
              )
            }
          />
        ) : null}
        <AppButton
          label="Mark complete"
          variant="secondary"
          onPress={() => actions.complete.mutate()}
        />
        <AppButton label="Mark as skipped" variant="ghost" onPress={() => setSkipOpen(true)} />
      </View>
      {actions.complete.isError ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {actions.complete.error.message}
        </Text>
      ) : null}
      <ConfirmationModal
        visible={skipOpen}
        title={`Skip ${room.data.name}?`}
        message={
          room.data.isRequired
            ? 'A reason is required because this is an approved required room.'
            : 'Add a short reason for the inspection record.'
        }
        confirmLabel="Skip room"
        destructive
        onCancel={() => setSkipOpen(false)}
        onConfirm={() =>
          actions.skip.mutate(skipReason, {
            onSuccess: () => {
              setSkipOpen(false);
              setSkipReason('');
            },
          })
        }
      >
        <TextInput
          accessibilityLabel="Skip reason"
          value={skipReason}
          onChangeText={setSkipReason}
          placeholder="Required reason"
          multiline
          style={styles.input}
        />
        {actions.skip.isError ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {actions.skip.error.message}
          </Text>
        ) : null}
      </ConfirmationModal>
    </AppScreen>
  );
}

function Timeline({ label, complete }: { label: string; complete: boolean }) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.timeline}>
      <View style={[styles.timelineDot, complete && styles.timelineDone]}>
        <Text style={styles.timelineIcon}>{complete ? '✓' : ''}</Text>
      </View>
      <Text style={[styles.timelineLabel, complete && styles.timelineLabelDone]}>{label}</Text>
    </View>
  );
}

const createStyles = (colors: AppColors) =>
  StyleSheet.create({
    badges: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    body: { ...typography.body, color: colors.textPrimary },
    meta: { ...typography.caption, color: colors.textSecondary },
    label: {
      ...typography.caption,
      color: colors.primary,
      fontWeight: '800',
      marginTop: spacing.sm,
    },
    defect: { ...typography.body, color: colors.textPrimary },
    thumbnails: { flexDirection: 'row', gap: spacing.sm },
    thumbnail: {
      height: 72,
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.sm,
      backgroundColor: colors.surfaceMuted,
    },
    thumbnailText: { ...typography.caption, color: colors.textSecondary },
    mediaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    play: {
      width: 50,
      height: 42,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.sm,
      backgroundColor: colors.primaryDark,
    },
    playText: { color: colors.white },
    flex: { flex: 1 },
    mediaTitle: { ...typography.label, color: colors.textPrimary },
    input: {
      minHeight: 88,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.md,
      backgroundColor: colors.surface,
      color: colors.textPrimary,
      padding: spacing.md,
      textAlignVertical: 'top',
    },
    timeline: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    timelineDot: {
      width: 24,
      height: 24,
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 2,
      borderColor: colors.border,
    },
    timelineDone: { backgroundColor: colors.success, borderColor: colors.success },
    timelineIcon: { color: colors.white, fontSize: 11, fontWeight: '900' },
    timelineLabel: { ...typography.body, color: colors.textSecondary },
    timelineLabelDone: { color: colors.textPrimary, fontWeight: '600' },
    actions: { gap: spacing.sm },
    error: { ...typography.caption, color: colors.danger },
  });
