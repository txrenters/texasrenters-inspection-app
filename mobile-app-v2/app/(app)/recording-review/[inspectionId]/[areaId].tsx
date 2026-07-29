import { useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useInspection, useRoom, useRooms, useSaveRecording } from '@/src/features/queries';
import { deleteDraftRecording } from '@/src/media/local-recordings';
import { useDemoStore } from '@/src/stores/demo.store';
import { nextInspectionRoom } from '@/src/utils/room-workflow';

export default function RecordingReviewScreen() {
  const { inspectionId = '', areaId = '' } = useLocalSearchParams<{
    inspectionId: string;
    areaId: string;
  }>();
  const room = useRoom(areaId);
  const rooms = useRooms(inspectionId);
  const inspection = useInspection(inspectionId);
  const selectedUserId = useDemoStore((state) => state.selectedUserId);
  const draft = useDemoStore((state) =>
    state.draftRecording?.ownerUserId === selectedUserId ? state.draftRecording : null,
  );
  const setDraft = useDemoStore((state) => state.setDraftRecording);
  const save = useSaveRecording();
  const [note, setNote] = useState(draft?.note ?? '');
  const [confirmed, setConfirmed] = useState(false);
  const player = useVideoPlayer(draft?.uri ?? null, (instance) => {
    instance.loop = false;
  });

  if (!draft) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-background px-6">
        <Text className="text-xl font-bold text-foreground">No recording to review</Text>
        <Text className="mt-2 text-center text-muted-foreground">
          Return to the room and record a video first.
        </Text>
        <Pressable
          className="mt-5 rounded-xl bg-primary px-6 py-3"
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
          label: draft.label,
          category: draft.category,
          propertyAddress: inspection.data?.property.address ?? 'Assigned property',
          roomName: room.data?.name ?? 'Room evidence',
          uri: draft.uri,
          durationSeconds: draft.durationSeconds,
          estimatedSizeMb: draft.estimatedSizeMb,
          note,
          captureSummary: draft.captureSummary,
        },
      },
      {
        onSuccess: () => {
          if (draft.recordingType === 'ADDITIONAL_ISSUE') {
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

  return (
    <SafeAreaView edges={['top', 'bottom']} className="flex-1 bg-background">
      <ScrollView className="flex-1" contentContainerStyle={{ padding: 20, paddingBottom: 130 }}>
        <Text className="text-2xl font-bold text-foreground">Review recording</Text>
        <Text className="mt-1 text-sm text-muted-foreground">
          {room.data?.name ?? 'Room'} · Stored on this device
        </Text>
        <VideoView
          player={player}
          nativeControls
          contentFit="contain"
          style={{ height: 300, marginTop: 20, borderRadius: 18, backgroundColor: '#000' }}
        />
        <View className="mt-5 rounded-2xl bg-card p-5">
          <Text className="font-semibold text-foreground">Technician note</Text>
          <TextInput
            className="mt-3 min-h-24 rounded-xl border border-border bg-muted px-4 py-3 text-foreground"
            value={note}
            onChangeText={setNote}
            multiline
            textAlignVertical="top"
            placeholder="Add context for the reviewer"
            placeholderTextColor="#9a9484"
          />
        </View>
        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: confirmed }}
          className={`mt-4 flex-row items-start gap-3 rounded-2xl border p-4 ${
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
            I confirm this recording captures the required room evidence.
          </Text>
        </Pressable>
        {save.isError ? (
          <Text className="mt-3 text-sm text-destructive">
            {save.error instanceof Error ? save.error.message : 'Could not queue the recording.'}
          </Text>
        ) : null}
        <View className="mt-5 flex-row gap-3">
          <Pressable
            className="flex-1 items-center rounded-xl border border-border bg-card py-3"
            onPress={() => {
              deleteDraftRecording(draft.uri);
              setDraft(null);
              router.replace(`/camera/${inspectionId}/${areaId}`);
            }}
          >
            <Text className="font-semibold text-foreground">Retake</Text>
          </Pressable>
          <Pressable
            className="flex-1 items-center rounded-xl bg-destructive/10 py-3"
            onPress={() => {
              deleteDraftRecording(draft.uri);
              setDraft(null);
              router.replace(`/areas/${areaId}`);
            }}
          >
            <Text className="font-semibold text-destructive">Discard</Text>
          </Pressable>
        </View>
      </ScrollView>
      <View className="absolute bottom-0 left-0 right-0 border-t border-border bg-background px-5 pb-8 pt-3">
        <Pressable
          className={`items-center rounded-xl py-4 ${
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
              : nextRoom
                ? `Save & continue to ${nextRoom.name}`
                : 'Save & return to inspection'}
          </Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}
