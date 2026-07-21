import { useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { AppScreen } from '../../../../../../src/components/AppScreen';
import { formatDuration } from '../../../../../../src/components/FeatureCards';
import { AppButton, Card, ConfirmationModal } from '../../../../../../src/components/ui';
import { useRoom, useSaveRecording } from '../../../../../../src/features/queries';
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

export default function RecordingReviewScreen() {
  const { colors } = useAppTheme();
  const styles = useThemedStyles(createStyles);
  const { inspectionId = '', areaId = '' } = useLocalSearchParams<{
    inspectionId: string;
    areaId: string;
  }>();
  const room = useRoom(areaId);
  const draft = useDemoStore((state) => state.draftRecording);
  const setDraft = useDemoStore((state) => state.setDraftRecording);
  const save = useSaveRecording();
  const [note, setNote] = useState(draft?.note ?? '');
  const [discardOpen, setDiscardOpen] = useState(false);
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
  const saveForUpload = () =>
    save.mutate(
      {
        input: {
          inspectionId,
          roomId: areaId,
          uri: draft.uri,
          durationSeconds: draft.durationSeconds,
          estimatedSizeMb: draft.estimatedSizeMb,
          note,
        },
      },
      {
        onSuccess: () =>
          router.replace({
            pathname: '/(app)/inspections/[inspectionId]/area/[areaId]',
            params: { inspectionId, areaId },
          }),
      },
    );
  return (
    <AppScreen
      title="Review recording"
      subtitle={`${room.data?.name ?? 'Room'} · Stored on this device`}
      bottomAction={
        <AppButton label="Save locally" onPress={saveForUpload} loading={save.isPending} />
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
        This recording stays on the device. Cloud upload remains queued for later integration.
      </Text>
      <Card>
        <View style={styles.row}>
          <Meta label="Duration" value={formatDuration(draft.durationSeconds)} />
          <Meta label="Estimated size" value={`${draft.estimatedSizeMb.toFixed(1)} MB`} />
        </View>
        <Meta label="Recorded" value={new Date(draft.recordedAt).toLocaleString()} />
      </Card>
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
    value: { ...typography.body, color: colors.textPrimary },
    body: { ...typography.body, color: colors.textSecondary },
    input: {
      minHeight: 100,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.md,
      padding: spacing.md,
      color: colors.textPrimary,
      textAlignVertical: 'top',
    },
    actions: { gap: spacing.sm },
    error: { ...typography.caption, color: colors.danger },
  });
