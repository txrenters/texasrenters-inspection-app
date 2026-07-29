import { useEffect, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { Alert, StyleSheet, Text, View } from 'react-native';

import { AppScreen } from '../../../../../../src/components/AppScreen';
import { formatDuration } from '../../../../../../src/components/FeatureCards';
import { EvidenceSummary } from '../../../../../../src/components/ScreenPrimitives';
import { AreaCompletionChecklist } from '../../../../../../src/components/AreaCompletionChecklist';
import { AreaStatusLine } from '../../../../../../src/components/AreaStatusLine';
import {
  areaCompletionGate,
  deriveAreaRequirements,
} from '../../../../../../src/utils/area-requirements';
import { ErrorState, LoadingState } from '../../../../../../src/components/ScreenStates';
import {
  AppButton,
  Card,
  ConfirmationModal,
  SectionHeader,
  StatusBadge,
} from '../../../../../../src/components/ui';
import { Input } from '../../../../../../src/components/ui/input';
import { Textarea } from '../../../../../../src/components/ui/textarea';
import { isDemoMode } from '../../../../../../src/config/environment';
import {
  useFindings,
  useRoom,
  useRoomMedia,
  useUpdateRoom,
} from '../../../../../../src/features/queries';
import { recordPetObservation } from '../../../../../../src/media/pet-observation';
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
  // Findings are fetched per inspection, so this reuses the cache the area list
  // already populated rather than issuing a second request.
  const findings = useFindings(inspectionId);
  const areaFindingCount = (findings.data ?? []).filter(
    (finding) => finding.roomId === areaId,
  ).length;
  const actions = useUpdateRoom(inspectionId, areaId);
  const [note, setNote] = useState('');
  const [skipOpen, setSkipOpen] = useState(false);
  const [skipReason, setSkipReason] = useState('');
  const [petOpen, setPetOpen] = useState(false);
  const [petSpecies, setPetSpecies] = useState('');
  const [petLabel, setPetLabel] = useState('');
  const [petNotes, setPetNotes] = useState('');
  const [petSaving, setPetSaving] = useState(false);
  const [petError, setPetError] = useState<string | null>(null);
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
  // Derived from the same room record the list uses, so the detail screen and
  // the area card can never disagree about this area's state.
  const requirements = deriveAreaRequirements(
    { ...room.data, completionStatus },
    {
      hasPrimaryRecording: hasSavedRecording,
      // Photos are not listed by the mobile client yet, so this stays 0 rather
      // than guessing. It only affects the advisory defect re-check.
      photoCount: 0,
      findingCount: areaFindingCount,
      uploadSettled: room.data.uploadStatus !== 'FAILED',
    },
  );
  const gate = areaCompletionGate(requirements);
  const recordAdditional = () =>
    router.push({
      pathname: '/(app)/inspections/[inspectionId]/area/[areaId]/record',
      params: { inspectionId, areaId, recordingType: 'ADDITIONAL_ISSUE' },
    });
  const isOccupied = room.data?.inspectionType === 'OCCUPIED';
  const submitPetObservation = async () => {
    setPetError(null);
    // In demo mode there is no backend session; treat it as a local success.
    if (isDemoMode) {
      Alert.alert('Pet logged', 'This evidence is represented locally in the frontend demo.');
      setPetOpen(false);
      setPetSpecies('');
      setPetLabel('');
      setPetNotes('');
      return;
    }
    setPetSaving(true);
    try {
      await recordPetObservation({
        inspectionId,
        species: petSpecies.trim(),
        temporaryLabel: petLabel.trim(),
        notes: petNotes.trim() || undefined,
      });
      setPetOpen(false);
      setPetSpecies('');
      setPetLabel('');
      setPetNotes('');
    } catch (error) {
      setPetError(error instanceof Error ? error.message : 'The pet observation could not be saved.');
    } finally {
      setPetSaving(false);
    }
  };
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
      {/* One derived status with an icon, label and explanation, replacing a row
          of unlabeled badges that stated the state twice without saying what to
          do about it. */}
      <AreaStatusLine room={{ ...room.data, completionStatus }} />
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
          media.data.map((item) => {
            const additional = item.recordingType === 'ADDITIONAL_ISSUE';
            return (
              <View key={item.id} style={styles.mediaRow}>
                <View style={styles.play}>
                  <Text style={styles.playText}>▶</Text>
                </View>
                <View style={styles.flex}>
                  <Text style={styles.mediaTitle}>
                    {additional ? (item.label ?? 'Additional clip') : 'Room video'}
                  </Text>
                  <Text style={styles.meta}>
                    {formatDuration(item.durationSeconds)} ·{' '}
                    {new Date(item.recordedAt).toLocaleString()}
                  </Text>
                </View>
                <StatusBadge
                  label={additional ? 'ADDITIONAL' : 'PRIMARY'}
                  tone={additional ? 'info' : 'success'}
                />
              </View>
            );
          })
        ) : (
          <Text style={styles.meta}>No recording saved for this room yet.</Text>
        )}
      </Card>
      <Card>
        <SectionHeader title="Technician note" />
        <Textarea
          accessibilityLabel="Room note"
          value={note}
          onChangeText={setNote}
          placeholder="Add an observation or reminder"
          className="min-h-24"
        />
        <AppButton
          label="Save note"
          variant="outline"
          onPress={() => actions.note.mutate(note)}
          loading={actions.note.isPending}
          compact
        />
      </Card>
      <View style={styles.sectionBlock}>
        <SectionHeader title="Evidence status" />
        <EvidenceSummary
          items={[
            { label: 'Baseline', value: 'Reviewed', complete: true },
            {
              label: 'Room recording',
              value: hasSavedRecording ? 'Saved on this device' : 'Required before completion',
              complete: hasSavedRecording,
              attention: !hasSavedRecording,
            },
            {
              label: 'Upload',
              value:
                room.data.uploadStatus === 'COMPLETED'
                  ? 'Confirmed'
                  : room.data.uploadStatus === 'FAILED'
                    ? 'Needs retry'
                    : hasSavedRecording
                      ? 'Queued in background'
                      : 'Waiting for recording',
              complete: room.data.uploadStatus === 'COMPLETED',
              attention: room.data.uploadStatus === 'FAILED',
            },
            {
              label: 'AI review',
              value:
                room.data.processingStatus === 'READY_FOR_REVIEW'
                  ? 'Ready for review'
                  : hasSavedRecording
                    ? 'Runs after upload'
                    : 'Waiting for evidence',
              complete: room.data.processingStatus === 'READY_FOR_REVIEW',
            },
          ]}
        />
      </View>
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
        {hasSavedRecording ? (
          <AppButton
            label="Add additional evidence clip"
            variant="outline"
            onPress={recordAdditional}
          />
        ) : null}
        {isOccupied ? (
          <AppButton label="Log pet sighting" variant="outline" onPress={() => setPetOpen(true)} />
        ) : null}
        <AppButton
          label="Mark complete"
          variant="secondary"
          onPress={() => actions.complete.mutate()}
          disabled={!hasSavedRecording || actions.complete.isPending}
          loading={actions.complete.isPending}
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
        <Textarea
          accessibilityLabel="Skip reason"
          value={skipReason}
          onChangeText={setSkipReason}
          placeholder="Required reason"
          className="min-h-24"
        />
        {actions.skip.isError ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {actions.skip.error.message}
          </Text>
        ) : null}
      </ConfirmationModal>
      <ConfirmationModal
        visible={petOpen}
        title="Log pet sighting"
        message="Record evidence only. An administrator confirms whether it is a unique unauthorized pet and whether it is chargeable."
        confirmLabel={petSaving ? 'Saving…' : 'Log pet'}
        onCancel={() => setPetOpen(false)}
        onConfirm={() => {
          if (!petSaving && petSpecies.trim() && petLabel.trim()) void submitPetObservation();
        }}
      >
        <Input
          accessibilityLabel="Pet species"
          value={petSpecies}
          onChangeText={setPetSpecies}
          placeholder="Species (e.g. Dog)"
        />
        <Input
          accessibilityLabel="Temporary pet label"
          value={petLabel}
          onChangeText={setPetLabel}
          placeholder="Temporary label (e.g. Brown dog)"
        />
        <Textarea
          accessibilityLabel="Pet notes"
          value={petNotes}
          onChangeText={setPetNotes}
          placeholder="Distinguishing characteristics, area seen, notes"
          className="min-h-24"
        />
        {petError ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {petError}
          </Text>
        ) : null}
      </ConfirmationModal>
      <AreaCompletionChecklist blockedReason={gate.reason} requirements={requirements} />
    </AppScreen>
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
    sectionBlock: { gap: spacing.sm },
    actions: { gap: spacing.sm },
    error: { ...typography.caption, color: colors.danger },
  });
