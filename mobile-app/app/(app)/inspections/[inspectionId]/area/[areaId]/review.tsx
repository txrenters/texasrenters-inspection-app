import { useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { AppScreen } from '../../../../../../src/components/AppScreen';
import { formatDuration } from '../../../../../../src/components/FeatureCards';
import { AppButton, Card, ConfirmationModal } from '../../../../../../src/components/ui';
import type { AdditionalVideoCategory } from '../../../../../../src/domain/models';
import {
  useInspection,
  useRoom,
  useRooms,
  useSaveRecording,
} from '../../../../../../src/features/queries';
import { deleteDraftRecording } from '../../../../../../src/media/local-recordings';
import { useDemoStore } from '../../../../../../src/stores/demo.store';
import {
  type AppColors,
  radius,
  spacing,
  typography,
  useAppTheme,
  useThemedStyles,
} from '../../../../../../src/theme';
import { nextInspectionRoom } from '../../../../../../src/utils/room-workflow';

const ADDITIONAL_VIDEO_CATEGORIES: ReadonlyArray<{ value: AdditionalVideoCategory; label: string }> =
  [
    { value: 'ADDITIONAL_DAMAGE', label: 'Additional damage' },
    { value: 'APPLIANCE_TEST', label: 'Appliance test' },
    { value: 'PLUMBING', label: 'Plumbing' },
    { value: 'ELECTRICAL', label: 'Electrical' },
    { value: 'PEST', label: 'Pest' },
    { value: 'PET_EVIDENCE', label: 'Pet evidence' },
    { value: 'SAFETY', label: 'Safety' },
    { value: 'EXTERIOR', label: 'Exterior' },
    { value: 'FOLLOW_UP', label: 'Follow-up' },
    { value: 'REINSPECTION', label: 'Re-inspection' },
    { value: 'OTHER', label: 'Other' },
  ];

export default function RecordingReviewScreen() {
  const { colors } = useAppTheme();
  const styles = useThemedStyles(createStyles);
  const { inspectionId = '', areaId = '' } = useLocalSearchParams<{
    inspectionId: string;
    areaId: string;
  }>();
  const room = useRoom(areaId);
  const rooms = useRooms(inspectionId);
  const inspection = useInspection(inspectionId);
  const draft = useDemoStore((state) =>
    state.draftRecording?.ownerUserId === state.selectedUserId ? state.draftRecording : null,
  );
  const setDraft = useDemoStore((state) => state.setDraftRecording);
  const save = useSaveRecording();
  const isAdditional = draft?.recordingType === 'ADDITIONAL_ISSUE';
  const [note, setNote] = useState(draft?.note ?? '');
  const [label, setLabel] = useState(draft?.label ?? '');
  const [category, setCategory] = useState<AdditionalVideoCategory | undefined>(draft?.category);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [coverageConfirmed, setCoverageConfirmed] = useState(false);
  const playableUri = draft && !draft.uri.startsWith('mock://') ? draft.uri : null;
  const player = useVideoPlayer(playableUri, (videoPlayer) => {
    videoPlayer.loop = false;
  });
  if (!draft)
    return (
      <AppScreen title="No recording to review">
        <Text style={styles.body}>Return to the room and record a video first.</Text>
        <AppButton
          label="Back to room"
          onPress={() =>
            router.replace({
              pathname: '/(app)/inspections/[inspectionId]/area/[areaId]',
              params: { inspectionId, areaId },
            })
          }
        />
      </AppScreen>
    );
  const nextRoom = nextInspectionRoom(rooms.data ?? [], areaId);
  const trimmedLabel = label.trim();
  const canSave = isAdditional ? trimmedLabel.length > 0 : coverageConfirmed;
  const saveForUpload = () => {
    if (!canSave) return;
    save.mutate(
      {
        input: {
          inspectionId,
          roomId: areaId,
          recordingType: isAdditional ? 'ADDITIONAL_ISSUE' : 'PRIMARY_AREA',
          ...(isAdditional ? { label: trimmedLabel, category } : {}),
          propertyAddress: inspection.data?.property.address ?? 'Assigned property',
          roomName: room.data?.name ?? 'Room evidence',
          uri: draft.uri,
          durationSeconds: draft.durationSeconds,
          estimatedSizeMb: draft.estimatedSizeMb,
          note,
          captureSummary: draft.captureSummary
            ? {
                ...draft.captureSummary,
                manualConfirmation: coverageConfirmed,
                coverageStatus:
                  draft.captureSummary.coverageStatus === 'COMPLETE'
                    ? 'COMPLETE'
                    : 'MANUALLY_CONFIRMED',
              }
            : undefined,
        },
      },
      {
        onSuccess: () => {
          // Additional clips never complete or advance the room — return to the
          // room so the technician can keep recording the primary walkthrough.
          if (isAdditional) {
            router.replace({
              pathname: '/(app)/inspections/[inspectionId]/area/[areaId]',
              params: { inspectionId, areaId },
            });
            return;
          }
          if (nextRoom) {
            router.replace({
              pathname: '/(app)/inspections/[inspectionId]/area/[areaId]',
              params: { inspectionId, areaId: nextRoom.id },
            });
            return;
          }
          router.replace({
            pathname: '/(app)/inspections/[inspectionId]/areas',
            params: { inspectionId },
          });
        },
      },
    );
  };
  const bottomLabel = isAdditional
    ? 'Save additional clip'
    : nextRoom
      ? `Save & continue to ${nextRoom.name}`
      : 'Save & return to checklist';
  return (
    <AppScreen
      title={isAdditional ? 'Review additional clip' : 'Review recording'}
      subtitle={`${room.data?.name ?? 'Room'} · Stored on this device`}
      bottomAction={
        <AppButton
          label={bottomLabel}
          onPress={saveForUpload}
          loading={save.isPending}
          disabled={!canSave}
        />
      }
    >
      {playableUri ? (
        <VideoView
          contentFit="contain"
          fullscreenOptions={{ enable: true }}
          nativeControls
          player={player}
          style={styles.preview}
        />
      ) : (
        <View style={styles.preview}>
          <View style={styles.play}>
            <Text style={styles.playText}>▶</Text>
          </View>
          <Text style={styles.previewLabel}>LOCAL VIDEO PREVIEW</Text>
        </View>
      )}
      <Text style={styles.localNotice}>
        Saving keeps a copy on this device and queues the video for upload to TexasRenters. Track
        progress in the Uploads tab.
      </Text>
      <Card>
        <View style={styles.row}>
          <Meta label="Duration" value={formatDuration(draft.durationSeconds)} />
          <Meta label="Estimated size" value={`${draft.estimatedSizeMb.toFixed(1)} MB`} />
        </View>
        <Meta label="Recorded" value={new Date(draft.recordedAt).toLocaleString()} />
      </Card>
      {!isAdditional && draft.captureSummary ? (
        <Card>
          <Text style={styles.label}>GUIDED CAPTURE SUMMARY</Text>
          <View style={styles.summaryGrid}>
            <Meta
              label="Rotation estimate"
              value={`${draft.captureSummary.clockwiseRotationDegrees}° clockwise`}
            />
            <Meta
              label="Returned to Wall 1"
              value={draft.captureSummary.returnedToStart ? 'Estimated yes' : 'Not confirmed'}
            />
            <Meta label="Sensor confidence" value={draft.captureSummary.sensorConfidence} />
            <Meta
              label="Evidence"
              value={`${draft.captureSummary.snapshotCount} photos · ${draft.captureSummary.findingMarkerCount} markers`}
            />
          </View>
          <Text style={styles.captureDisclaimer}>
            Sensors estimate movement only; they do not prove every surface was visible.
          </Text>
          <Pressable
            accessibilityRole="checkbox"
            accessibilityState={{ checked: coverageConfirmed }}
            onPress={() => setCoverageConfirmed((value) => !value)}
            style={[styles.confirmation, coverageConfirmed && styles.confirmationChecked]}
          >
            <Text style={styles.confirmationMark}>{coverageConfirmed ? '✓' : '○'}</Text>
            <Text style={styles.confirmationText}>
              I confirm the room video and photos capture the required evidence.
            </Text>
          </Pressable>
        </Card>
      ) : null}
      {isAdditional ? (
        <Card>
          <Text style={styles.label}>CLIP LABEL</Text>
          <TextInput
            accessibilityLabel="Clip label"
            value={label}
            onChangeText={setLabel}
            placeholder="e.g. Water stain under kitchen sink"
            placeholderTextColor={colors.textSecondary}
            maxLength={120}
            style={styles.labelInput}
          />
          <Text style={styles.hint}>A short label is required so reviewers can find this clip.</Text>
          <Text style={[styles.label, styles.categoryLabel]}>CATEGORY (OPTIONAL)</Text>
          <View style={styles.categoryRow}>
            {ADDITIONAL_VIDEO_CATEGORIES.map((option) => {
              const selected = category === option.value;
              return (
                <Pressable
                  key={option.value}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  onPress={() => setCategory(selected ? undefined : option.value)}
                  style={[styles.categoryChip, selected && styles.categoryChipSelected]}
                >
                  <Text
                    style={[styles.categoryChipText, selected && styles.categoryChipTextSelected]}
                  >
                    {option.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </Card>
      ) : null}
      <Card>
        <Text style={styles.label}>TECHNICIAN NOTES</Text>
        <TextInput
          accessibilityLabel="Recording notes"
          value={note}
          onChangeText={setNote}
          placeholder="Add context for the reviewer"
          placeholderTextColor={colors.textSecondary}
          multiline
          style={styles.input}
        />
      </Card>
      <View style={styles.actions}>
        <AppButton
          label="Retake"
          variant="outline"
          onPress={() => {
            deleteDraftRecording(draft.uri);
            setDraft(null);
            router.replace({
              pathname: '/(app)/inspections/[inspectionId]/area/[areaId]/record',
              params: { inspectionId, areaId },
            });
          }}
        />
        <AppButton label="Discard" variant="ghost" onPress={() => setDiscardOpen(true)} />
      </View>
      {save.isError ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {save.error.message}
        </Text>
      ) : null}
      <ConfirmationModal
        visible={discardOpen}
        title="Discard this recording?"
        message="This local draft has not been added to the upload queue."
        confirmLabel="Discard"
        destructive
        onCancel={() => setDiscardOpen(false)}
        onConfirm={() => {
          deleteDraftRecording(draft.uri);
          setDraft(null);
          router.replace({
            pathname: '/(app)/inspections/[inspectionId]/area/[areaId]',
            params: { inspectionId, areaId },
          });
        }}
      />
    </AppScreen>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.meta}>
      <Text style={styles.label}>{label.toUpperCase()}</Text>
      <Text style={styles.value}>{value}</Text>
    </View>
  );
}
const createStyles = (colors: AppColors) =>
  StyleSheet.create({
    preview: {
      height: 230,
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.md,
      borderRadius: radius.lg,
      backgroundColor: colors.primaryDark,
    },
    play: {
      width: 64,
      height: 64,
      borderRadius: 32,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.white,
    },
    playText: { color: colors.primaryDark, fontSize: 25, marginLeft: 4 },
    previewLabel: { ...typography.caption, color: colors.primarySoft, letterSpacing: 1 },
    localNotice: { ...typography.caption, color: colors.textSecondary },
    row: { flexDirection: 'row', gap: spacing.md },
    meta: { flex: 1, gap: spacing.xs },
    label: { ...typography.caption, color: colors.primary, fontWeight: '800' },
    categoryLabel: { marginTop: spacing.md },
    value: { ...typography.body, color: colors.textPrimary },
    body: { ...typography.body, color: colors.textSecondary },
    hint: { ...typography.caption, color: colors.textSecondary },
    input: {
      minHeight: 100,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.md,
      padding: spacing.md,
      color: colors.textPrimary,
      textAlignVertical: 'top',
    },
    labelInput: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.md,
      padding: spacing.md,
      color: colors.textPrimary,
    },
    categoryRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
    categoryChip: {
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs,
      borderRadius: radius.round,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
    },
    categoryChipSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
    categoryChipText: { ...typography.caption, color: colors.textSecondary },
    categoryChipTextSelected: { color: colors.white, fontWeight: '700' },
    actions: { gap: spacing.sm },
    summaryGrid: { gap: spacing.sm },
    captureDisclaimer: { ...typography.caption, color: colors.textSecondary },
    confirmation: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.md,
      padding: spacing.md,
    },
    confirmationChecked: {
      borderColor: colors.success,
      backgroundColor: colors.successSoft,
    },
    confirmationMark: { ...typography.heading, color: colors.primary },
    confirmationText: { ...typography.body, color: colors.textPrimary, flex: 1 },
    error: { ...typography.caption, color: colors.danger },
  });
