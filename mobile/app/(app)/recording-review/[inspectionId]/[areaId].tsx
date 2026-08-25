import { useEffect, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';

import { HomeButton } from '@/src/components/HomeButton';
import { useVideoPlayer, VideoView } from 'expo-video';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { AdditionalVideoCategory } from '@/src/domain/models';
import { useInspection, useRoom, useRooms, useSaveRecording } from '@/src/features/queries';
import { deleteDraftRecording } from '@/src/media/local-recordings';
import { discardCaptureSession } from '@/src/media/discard-capture-session';
import { useDemoStore } from '@/src/stores/demo.store';
import { nextInspectionRoom } from '@/src/utils/room-workflow';
import { useThemeColors } from '@/src/lib/theme-colors';

const ADDITIONAL_CATEGORIES: readonly {
  value: AdditionalVideoCategory;
  label: string;
}[] = [
  { value: 'ADDITIONAL_DAMAGE', label: 'Damage' },
  { value: 'APPLIANCE_TEST', label: 'Appliance' },
  { value: 'SAFETY', label: 'Safety' },
  { value: 'FOLLOW_UP', label: 'Follow-up' },
  { value: 'OTHER', label: 'Other' },
];

export default function RecordingReviewScreen() {
  const theme = useThemeColors();
  const {
    inspectionId = '',
    areaId = '',
    recordingType,
  } = useLocalSearchParams<{
    inspectionId: string;
    areaId: string;
    recordingType?: string;
  }>();
  const room = useRoom(areaId);
  const rooms = useRooms(inspectionId);
  const inspection = useInspection(inspectionId);
  const selectedUserId = useDemoStore((state) => state.selectedUserId);
  const draft = useDemoStore((state) =>
    state.draftRecording?.ownerUserId === selectedUserId ? state.draftRecording : null,
  );
  const setDraft = useDemoStore((state) => state.setDraftRecording);
  const snapshots = useDemoStore((state) => state.snapshots);
  const removeSnapshots = useDemoStore((state) => state.removeSnapshots);
  const save = useSaveRecording();
  const [note, setNote] = useState(draft?.note ?? '');
  const [confirmed, setConfirmed] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [discardError, setDiscardError] = useState<string | null>(null);
  /**
   * The video's own shape, so the box matches the footage instead of the
   * footage sitting letterboxed inside a fixed 300px band.
   *
   * A walkthrough is shot with the phone upright, so the default is portrait —
   * being briefly too tall while the track loads is better than being far too
   * short, which is what a landscape default would do to every recording this
   * app produces.
   */
  const [aspectRatio, setAspectRatio] = useState(9 / 16);
  const [label, setLabel] = useState(draft?.label ?? '');
  const [category, setCategory] = useState<AdditionalVideoCategory>(draft?.category ?? 'OTHER');
  const player = useVideoPlayer(draft?.uri ?? null, (instance) => {
    instance.loop = false;
  });

  useEffect(() => {
    // The track is not there the moment the player is created; it arrives with
    // the first loaded frame, so this reads it on every status change and stops
    // once a usable size appears.
    const applySize = () => {
      const size = player.videoTrack?.size;
      if (size?.width && size.height) setAspectRatio(size.width / size.height);
    };
    applySize();
    const subscription = player.addListener('statusChange', applySize);
    return () => subscription.remove();
  }, [player]);
  const isAdditional =
    draft?.recordingType === 'ADDITIONAL_ISSUE' || recordingType === 'ADDITIONAL_ISSUE';

  if (!draft) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-background px-6">
        <Text className="text-xl font-bold text-foreground">No recording to review</Text>
        <Text className="mt-2 text-center text-muted-foreground">
          Return to the room and record a video first.
        </Text>
        <Pressable
          accessibilityLabel="Back to room"
          accessibilityRole="button"
          className="mt-5 min-h-12 justify-center rounded-xl bg-primary px-6 py-3"
          onPress={() => router.replace(`/areas/${areaId}`)}
        >
          <Text className="font-bold text-primary-foreground">Back to room</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  const nextRoom = nextInspectionRoom(rooms.data ?? [], areaId);
  const submit = () => {
    if (!confirmed) return;
    save.mutate(
      {
        input: {
          inspectionId,
          roomId: areaId,
          recordingType: draft.recordingType ?? 'PRIMARY_AREA',
          label: isAdditional
            ? label.trim() || `${room.data?.name ?? 'Room'} additional evidence`
            : draft.label,
          category: isAdditional ? category : draft.category,
          propertyAddress: inspection.data?.property.address ?? 'Assigned property',
          roomName: room.data?.name ?? 'Room evidence',
          uri: draft.uri,
          durationSeconds: draft.durationSeconds,
          estimatedSizeMb: draft.estimatedSizeMb,
          note,
          captureSummary: draft.captureSummary
            ? {
                ...draft.captureSummary,
                manualConfirmation: true,
                coverageStatus:
                  draft.captureSummary.coverageStatus === 'COMPLETE' ||
                  draft.captureSummary.coverageStatus === 'LIKELY_COMPLETE'
                    ? draft.captureSummary.coverageStatus
                    : 'MANUALLY_CONFIRMED',
              }
            : undefined,
        },
      },
      {
        onSuccess: () => {
          if (isAdditional) {
            router.replace(`/areas/${areaId}`);
          } else if (nextRoom) {
            router.replace(`/areas/${nextRoom.id}`);
          } else {
            router.replace(`/inspections/${inspectionId}`);
          }
        },
      },
    );
  };

  /**
   * Throws away the take and everything it produced.
   *
   * Shared by Retake and Discard because they differ only in where they go
   * next — both abandon this walkthrough, and a retake that left the previous
   * take's photographs behind would quietly stack two sets of evidence on one
   * room.
   *
   * Nothing local is touched until the server has let go of the uploaded
   * copies. If it refuses — offline, most likely — the take is left exactly as
   * it was and the technician can try again, because the alternative is
   * telling them the evidence is gone while it is still bound for the report.
   */
  const discardTake = async (next: () => void) => {
    if (!draft || discarding) return;
    setDiscarding(true);
    setDiscardError(null);
    try {
      const { removedIds, failed } = await discardCaptureSession(
        snapshots ?? [],
        draft.recordingSessionId,
      );
      if (failed.length) {
        setDiscardError(
          `${failed.length} photo${failed.length === 1 ? '' : 's'} could not be removed from the server. Nothing was discarded — check your connection and try again.`,
        );
        return;
      }
      if (removedIds.length) removeSnapshots(removedIds);
      deleteDraftRecording(draft.uri);
      setDraft(null);
      next();
    } finally {
      setDiscarding(false);
    }
  };

  return (
    <SafeAreaView edges={['top', 'bottom']} className="flex-1 bg-background">
      <ScrollView className="flex-1" contentContainerStyle={{ padding: 20, paddingBottom: 24 }}>
        <View className="flex-row items-start gap-3">
          <View className="min-w-0 flex-1">
            <Text className="text-2xl font-bold text-foreground">Review recording</Text>
            <Text className="mt-1 text-sm text-muted-foreground">
              {room.data?.name ?? 'Room'} · Stored on this device
            </Text>
          </View>
          {/* The take is on the device but not submitted; leaving now keeps the
              file in the queue but abandons this screen's note and confirmation,
              so it asks first. */}
          <HomeButton
            confirm={{
              title: 'Leave this recording?',
              detail:
                'The video stays saved on this device, but the note you have typed here is not kept. You can come back to the area and review it again.',
              leaveLabel: 'Leave',
            }}
          />
        </View>
        <VideoView
          player={player}
          nativeControls
          contentFit="contain"
          style={{
            aspectRatio,
            // Capped so a portrait clip cannot push the note and the
            // confirmation off the screen — the point of this screen is to
            // review *and* confirm, and a video tall enough to fill it would
            // hide the control that lets them move on.
            maxHeight: 420,
            marginTop: 20,
            borderRadius: 18,
            backgroundColor: '#000',
          }}
        />
        <View className="mt-5 rounded-2xl bg-card p-5">
          <Text nativeID="recording-note-label" className="font-semibold text-foreground">
            Technician note
          </Text>
          <TextInput
            accessibilityLabel="Technician note"
            accessibilityHint="Add context for the reviewer"
            accessibilityLabelledBy="recording-note-label"
            className="mt-3 min-h-24 rounded-xl border border-border bg-muted px-4 py-3 text-foreground"
            value={note}
            onChangeText={setNote}
            multiline
            textAlignVertical="top"
            placeholder="Add context for the reviewer"
            placeholderTextColor={theme.mutedForeground}
          />
        </View>
        {isAdditional ? (
          <View className="mt-4 rounded-2xl bg-card p-5">
            <Text className="font-semibold text-foreground">Additional evidence details</Text>
            <Text className="mt-1 text-xs leading-5 text-muted-foreground">
              Give this focused clip a short label so reviewers understand why it was added.
            </Text>
            <TextInput
              accessibilityLabel="Additional evidence label"
              className="mt-3 min-h-12 rounded-xl border border-border bg-muted px-4 py-3 text-foreground"
              value={label}
              onChangeText={setLabel}
              placeholder="e.g. Sink leak follow-up"
              placeholderTextColor={theme.mutedForeground}
            />
            <Text className="mt-4 text-xs font-bold uppercase tracking-wider text-muted-foreground">
              Category
            </Text>
            <View accessibilityRole="radiogroup" className="mt-2 flex-row flex-wrap gap-2">
              {ADDITIONAL_CATEGORIES.map((option) => {
                const selected = category === option.value;
                return (
                  <Pressable
                    key={option.value}
                    accessibilityRole="radio"
                    accessibilityState={{ selected }}
                    className={`min-h-11 items-center justify-center rounded-full border px-4 ${
                      selected ? 'border-primary bg-primary/10' : 'border-border bg-muted'
                    }`}
                    onPress={() => setCategory(option.value)}
                  >
                    <Text
                      className={`text-sm font-semibold ${
                        selected ? 'text-primary' : 'text-muted-foreground'
                      }`}
                    >
                      {option.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        ) : null}
        <Pressable
          // The tick is rendered as a bare "✓" glyph, which a screen reader
          // either skips or reads as punctuation, so the label must carry the
          // whole statement being agreed to.
          accessibilityLabel={
            isAdditional
              ? 'I confirm this clip clearly captures the additional evidence.'
              : 'I confirm this recording captures the required room evidence.'
          }
          accessibilityRole="checkbox"
          accessibilityState={{ checked: confirmed }}
          className={`mt-4 min-h-14 flex-row items-start gap-3 rounded-2xl border p-4 ${
            confirmed ? 'border-primary bg-primary/10' : 'border-border bg-card'
          }`}
          onPress={() => setConfirmed((value) => !value)}
        >
          <View
            className={`mt-0.5 h-5 w-5 items-center justify-center rounded-full ${
              confirmed ? 'bg-primary' : 'border border-border'
            }`}
          >
            <Text className="text-xs text-primary-foreground">{confirmed ? '✓' : ''}</Text>
          </View>
          <Text className="flex-1 text-sm leading-5 text-foreground">
            {isAdditional
              ? 'I confirm this clip clearly captures the additional evidence.'
              : 'I confirm this recording captures the required room evidence.'}
          </Text>
        </Pressable>
        {save.isError ? (
          <Text
            accessibilityLiveRegion="assertive"
            accessibilityRole="alert"
            className="mt-3 text-sm text-destructive"
          >
            {save.error instanceof Error ? save.error.message : 'Could not queue the recording.'}
          </Text>
        ) : null}
        {discardError ? (
          <Text
            accessibilityLiveRegion="assertive"
            accessibilityRole="alert"
            className="mt-3 text-sm text-destructive"
          >
            {discardError}
          </Text>
        ) : null}
        <View className="mt-5 flex-row gap-3">
          {/* Both discard the take — the video and the photographs shot during
              it, which are already uploaded by this point. The hints say so
              explicitly, because these sit side by side and an accidental tap
              loses the walkthrough. */}
          <Pressable
            accessibilityHint="Deletes this recording and its photos, and reopens the camera"
            accessibilityLabel="Retake recording"
            accessibilityRole="button"
            accessibilityState={{ busy: discarding, disabled: discarding }}
            className="min-h-12 flex-1 items-center justify-center rounded-xl border border-border bg-card py-3"
            disabled={discarding}
            onPress={() =>
              void discardTake(() =>
                router.replace(
                  isAdditional
                    ? `/camera/${inspectionId}/${areaId}?recordingType=ADDITIONAL_ISSUE`
                    : `/camera/${inspectionId}/${areaId}`,
                ),
              )
            }
          >
            <Text className="font-semibold text-foreground">Retake</Text>
          </Pressable>
          <Pressable
            accessibilityHint="Deletes this recording and its photos, and returns to the area without saving"
            accessibilityLabel="Discard recording"
            accessibilityRole="button"
            accessibilityState={{ busy: discarding, disabled: discarding }}
            className="min-h-12 flex-1 items-center justify-center rounded-xl bg-destructive/10 py-3"
            disabled={discarding}
            onPress={() => void discardTake(() => router.replace(`/areas/${areaId}`))}
          >
            <Text className="font-semibold text-destructive">
              {discarding ? 'Discarding…' : 'Discard'}
            </Text>
          </Pressable>
        </View>
      </ScrollView>
      {/* A sibling below the scroll, not an overlay across it.
          It was positioned absolutely, so the scroll had to reserve exactly its
          height — first a hard-coded 130, then a measurement. Both are a number
          that has to stay in step with a layout nobody remembers to check, and
          both let the video end up underneath it. Laid out in the column,
          overlap is impossible by construction. */}
      <View className="border-t border-border bg-background px-5 pb-8 pt-3">
        {/* The reason the button below is dead, said out loud.
            It was an accessibilityHint alone, which only a screen reader ever
            announced — everyone else saw a greyed-out control and no way to
            find out what it wanted. */}
        {confirmed ? null : (
          <Text className="mb-2 text-center text-xs leading-4 text-muted-foreground">
            Tick the confirmation above to save this recording.
          </Text>
        )}
        <Pressable
          // Disabled with no stated reason is indistinguishable from broken.
          accessibilityHint={confirmed ? undefined : 'Confirm the recording above before saving'}
          accessibilityLabel={
            save.isPending
              ? 'Saving and queueing recording'
              : isAdditional
                ? 'Save and queue additional evidence'
                : nextRoom
                  ? `Save and continue to ${nextRoom.name}`
                  : 'Save and return to inspection'
          }
          accessibilityRole="button"
          accessibilityState={{ busy: save.isPending, disabled: !confirmed || save.isPending }}
          className={`min-h-12 items-center justify-center rounded-xl py-4 ${
            confirmed ? 'bg-primary' : 'bg-muted'
          }`}
          disabled={!confirmed || save.isPending}
          onPress={submit}
        >
          <Text
            className={`font-bold ${
              confirmed ? 'text-primary-foreground' : 'text-muted-foreground'
            }`}
          >
            {save.isPending
              ? 'Saving & queueing…'
              : isAdditional
                ? 'Save & queue evidence'
                : nextRoom
                  ? `Save & continue to ${nextRoom.name}`
                  : 'Save & return to inspection'}
          </Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}
