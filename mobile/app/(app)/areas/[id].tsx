import { useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { useColorScheme } from 'nativewind';
import {
  ArrowLeftIcon,
  CameraIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  CircleIcon,
  Edit3Icon,
  FileTextIcon,
  PlayCircleIcon,
  RotateCwIcon,
  SaveIcon,
} from 'lucide-react-native';
import { Pressable, RefreshControl, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAreaChecklist } from '@/src/capture/use-area-checklist';
import { useChecklistFromSummary } from '@/src/capture/useChecklistFromSummary';
import { AiSummaryCard } from '@/src/components/AiSummaryCard';
import { AreaCompletionChecklist } from '@/src/components/AreaCompletionChecklist';
import { BottomSheet } from '@/src/components/BottomSheet';
import { FindingRow } from '@/src/components/FindingRow';
import {
  useFindings,
  useRoom,
  useRoomMedia,
  useRoomPhotos,
  useRoomSummaries,
  useUpdateRoom,
} from '@/src/features/queries';
import { HomeButton } from '@/src/components/HomeButton';
import { DetailSkeleton } from '@/src/components/ui/Skeleton';
import { usePullToRefresh } from '@/src/features/usePullToRefresh';
import { areaCompletionGate, deriveAreaRequirements } from '@/src/utils/area-requirements';
import { describeRecordingLocation } from '@/src/utils/upload-status';
import { registerIcons } from '@/src/lib/icons';

registerIcons(
  ArrowLeftIcon,
  CameraIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  CircleIcon,
  Edit3Icon,
  FileTextIcon,
  PlayCircleIcon,
  RotateCwIcon,
  SaveIcon,
);

export default function AreaDetailScreen() {
  const { id = '' } = useLocalSearchParams<{ id: string }>();
  const room = useRoom(id);
  const inspectionId = room.data?.inspectionId ?? '';
  const media = useRoomMedia(id);
  const photos = useRoomPhotos(id);
  const findings = useFindings(inspectionId);
  // Poll while this area is still processing so the summary lands on its own.
  const summaries = useRoomSummaries(
    inspectionId,
    room.data?.processingStatus !== 'READY_FOR_REVIEW',
  );
  const updates = useUpdateRoom(inspectionId, id);
  const pull = usePullToRefresh([room.refetch, media.refetch, photos.refetch, findings.refetch]);
  // The AI summary is transcript-derived, so what it mentions is what the
  // technician talked through. Ticks coverage automatically; never unticks.
  const areaChecklist = useAreaChecklist(id, {
    name: room.data?.name,
    environment: room.data?.environment,
  });
  useChecklistFromSummary(id, areaChecklist, summaries.byRoomId.get(id));
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const [note, setNote] = useState<string | null>(null);
  const [skipOpen, setSkipOpen] = useState(false);
  const [skipReason, setSkipReason] = useState('');

  if (room.isLoading || !room.data) {
    return (
      <SafeAreaView edges={['top']} className="flex-1 bg-background">
        <DetailSkeleton sections={3} />
      </SafeAreaView>
    );
  }

  const item = room.data;
  const displayedNote = note ?? item.note ?? '';
  const roomFindings = (findings.data ?? []).filter((finding) => finding.roomId === item.id);
  const hasRecording = Boolean(media.data?.length);
  const requirements = deriveAreaRequirements(item, {
    hasPrimaryRecording: hasRecording,
    photoCount: photos.data?.length ?? 0,
    findingCount: roomFindings.length,
    // Queued counts as settled: the durable queue will deliver it, and blocking
    // completion on a finished upload would strand a technician with no signal
    // in a property they are trying to leave.
    uploadSettled: hasRecording && item.uploadStatus !== 'FAILED',
  });
  const gate = areaCompletionGate(requirements);
  const alreadyFinished =
    item.completionStatus === 'COMPLETED' || item.completionStatus === 'SKIPPED';
  const completionTone =
    item.completionStatus === 'COMPLETED'
      ? 'chart-3'
      : item.completionStatus === 'RECORDING_SAVED'
        ? 'chart-2'
        : 'chart-4';

  return (
    <SafeAreaView edges={['top']} className="flex-1 bg-background">
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingBottom: 150 }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={pull.refreshing}
            onRefresh={pull.onRefresh}
            tintColor={isDark ? '#2dd4bf' : '#145347'}
          />
        }
      >
        <View className="flex-row items-center gap-3 px-5 pb-3 pt-2">
          <Pressable
            accessibilityLabel="Back"
            accessibilityRole="button"
            className="h-9 w-9 items-center justify-center rounded-full bg-card active:scale-[0.95]"
            hitSlop={8}
            onPress={() => router.back()}
          >
            <ArrowLeftIcon size={18} className="text-foreground" />
          </Pressable>
          <View className="min-w-0 flex-1">
            <Text className="text-lg font-bold text-foreground">{item.name}</Text>
            <Text className="text-xs text-muted-foreground">
              {item.floorName} · {item.isRequired ? 'Required' : 'Optional'} room
            </Text>
          </View>
          <HomeButton />
          <View
            className={`rounded-full px-3 py-1 ${
              completionTone === 'chart-3'
                ? 'bg-chart-3/15'
                : completionTone === 'chart-2'
                  ? 'bg-chart-2/15'
                  : 'bg-chart-4/15'
            }`}
          >
            <Text
              className={`text-xs font-semibold capitalize ${
                completionTone === 'chart-3'
                  ? 'text-chart-3'
                  : completionTone === 'chart-2'
                    ? 'text-chart-2'
                    : 'text-chart-4'
              }`}
            >
              {item.completionStatus.replaceAll('_', ' ').toLowerCase()}
            </Text>
          </View>
        </View>

        <View className="mx-5 mt-2 gap-3 rounded-2xl bg-card p-5">
          <View className="flex-row items-center justify-between gap-3">
            <View className="flex-row items-center gap-2">
              <FileTextIcon size={18} className="text-primary" />
              <Text className="text-base font-semibold text-foreground">Baseline Condition</Text>
            </View>
            <View className="rounded-full bg-muted px-3 py-1">
              <Text className="text-xs font-semibold capitalize text-muted-foreground">
                {item.baseline.condition.replaceAll('_', ' ').toLowerCase()}
              </Text>
            </View>
          </View>
          <Text className="text-sm leading-6 text-muted-foreground">
            {item.baseline.summary || 'No baseline condition is available for this room.'}
          </Text>
          <Text className="text-xs text-muted-foreground">
            {item.baseline.evidenceCount} reference photos available
          </Text>
          <Text className="mt-2 text-xs font-bold uppercase tracking-wider text-primary">
            Existing documented defects
          </Text>
          <Text className="text-sm text-muted-foreground">
            {item.baseline.existingDefects.length
              ? item.baseline.existingDefects.join(' · ')
              : 'No existing defects documented.'}
          </Text>
          <View className="mt-1 flex-row items-center gap-2 self-start rounded-lg bg-muted px-3 py-1.5">
            <Edit3Icon size={14} className="text-muted-foreground" />
            <Text className="text-xs font-semibold text-muted-foreground">
              Baseline is read-only
            </Text>
          </View>
        </View>

        <View className="mx-5 mt-4 rounded-2xl bg-card p-5">
          <View className="flex-row items-start gap-3">
            <View className="h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
              <RotateCwIcon size={19} className="text-primary" />
            </View>
            <View className="min-w-0 flex-1">
              <Text className="text-base font-semibold text-foreground">Clockwise Walkthrough</Text>
              <Text className="mt-1 text-xs leading-5 text-muted-foreground">
                Narrate one slow pass around the room. Use snapshots to document the overview and
                focused finding context without interrupting the video.
              </Text>
            </View>
          </View>
          <View className="mt-4 overflow-hidden rounded-xl bg-muted">
            {[
              ['1', 'Room overview', 'Capture the full room and primary circulation path'],
              ['2', 'Walls & surfaces', 'Move clockwise and narrate visible conditions'],
              ['3', 'Fixtures & details', 'Pause briefly on appliances, doors, and windows'],
              ['4', 'Exit pass', 'Confirm the room name before ending the recording'],
            ].map(([number, title, description], index) => (
              <View
                key={number}
                className={`flex-row items-center gap-3 px-3 py-3 ${
                  index === 3 ? '' : 'border-b border-border'
                }`}
              >
                <View className="h-7 w-7 items-center justify-center rounded-full bg-primary/10">
                  <Text className="text-xs font-bold text-primary">{number}</Text>
                </View>
                <View className="min-w-0 flex-1">
                  <Text className="text-sm font-semibold text-foreground">{title}</Text>
                  <Text className="mt-0.5 text-xs text-muted-foreground">{description}</Text>
                </View>
              </View>
            ))}
          </View>
        </View>

        <View className="mx-5 mt-4 gap-3 rounded-2xl bg-card p-5">
          <View className="flex-row items-center justify-between">
            <Text className="text-base font-semibold text-foreground">Room Evidence</Text>
            <Text className="text-xs text-muted-foreground">{media.data?.length ?? 0} saved</Text>
          </View>
          <Text className="text-xs leading-relaxed text-muted-foreground">
            Capture one narrated room walkthrough. Snapshots can be taken before or during the
            recording and upload independently.
          </Text>
          {media.data?.length ? (
            media.data.map((recording) => {
              // A recording that only exists on this device has nothing on the
              // server to stream, so it stays a plain row rather than offering
              // playback that would fail.
              const uploaded = !recording.id.startsWith('local-media-');
              const label = recording.label || 'Primary room walkthrough';
              const body = (
                <>
                  <View className="flex-1">
                    <Text className="text-sm font-semibold text-foreground">{label}</Text>
                    <Text className="mt-0.5 text-xs text-muted-foreground">
                      {recording.durationSeconds}s · {describeRecordingLocation(recording.id)}
                    </Text>
                  </View>
                  {uploaded ? (
                    <PlayCircleIcon size={20} className="text-primary" />
                  ) : (
                    <CheckCircle2Icon size={18} className="text-chart-3" />
                  )}
                </>
              );
              return uploaded ? (
                <Pressable
                  accessibilityLabel={`Play ${label}`}
                  accessibilityRole="button"
                  className="flex-row items-center justify-between rounded-xl bg-muted p-3 active:scale-[0.99]"
                  key={recording.id}
                  onPress={() =>
                    router.push({
                      pathname: '/(app)/playback/[mediaId]',
                      params: { mediaId: recording.id, title: label },
                    })
                  }
                >
                  {body}
                </Pressable>
              ) : (
                <View
                  className="flex-row items-center justify-between rounded-xl bg-muted p-3"
                  key={recording.id}
                >
                  {body}
                </View>
              );
            })
          ) : (
            <Pressable
              accessibilityHint="Opens the camera for the primary room walkthrough"
              accessibilityLabel="No recording saved yet. Start the primary room walkthrough."
              accessibilityRole="button"
              className="min-h-14 flex-row items-center gap-3 rounded-xl bg-muted p-4 active:opacity-70"
              onPress={() => router.push(`/camera/${inspectionId}/${id}`)}
            >
              <View className="h-9 w-9 items-center justify-center rounded-full bg-primary/10">
                <CameraIcon size={18} className="text-primary" />
              </View>
              <View className="min-w-0 flex-1">
                <Text className="text-sm font-semibold text-foreground">
                  No recording saved yet
                </Text>
                <Text className="mt-0.5 text-xs text-muted-foreground">
                  Start the primary room walkthrough
                </Text>
              </View>
              <ChevronRightIcon size={16} className="text-muted-foreground" />
            </Pressable>
          )}
        </View>

        <View className="mx-5 mt-4 rounded-2xl bg-card p-5">
          <Text nativeID="area-note-label" className="text-base font-semibold text-foreground">
            Technician Note
          </Text>
          <TextInput
            accessibilityLabel="Technician note"
            accessibilityLabelledBy="area-note-label"
            className="mt-3 min-h-24 rounded-xl border border-border bg-muted px-4 py-3 text-base text-foreground"
            multiline
            textAlignVertical="top"
            placeholder="Add an observation or reminder"
            placeholderTextColor={isDark ? '#5e6b78' : '#9a9484'}
            value={displayedNote}
            onChangeText={setNote}
          />
          <Pressable
            accessibilityLabel={updates.note.isPending ? 'Saving note' : 'Save note'}
            accessibilityRole="button"
            accessibilityState={{
              busy: updates.note.isPending,
              disabled: updates.note.isPending || displayedNote === (item.note ?? ''),
            }}
            className="mt-3 min-h-12 flex-row items-center justify-center gap-2 rounded-xl bg-muted py-3"
            disabled={updates.note.isPending || displayedNote === (item.note ?? '')}
            onPress={() => updates.note.mutate(displayedNote)}
          >
            <SaveIcon size={16} className="text-primary" />
            <Text className="font-semibold text-primary">
              {updates.note.isPending ? 'Saving…' : 'Save Note'}
            </Text>
          </Pressable>
        </View>

        {/* Replaces a hard-coded four-item list whose first row ("Baseline
            reviewed") was literally `true` and whose contents had no bearing on
            whether the area could actually be completed.

            Hidden once the area is finished: outstanding requirements on an
            already-completed or skipped area read as an unresolved problem. */}
        {alreadyFinished ? null : (
          <AreaCompletionChecklist requirements={requirements} blockedReason={gate.reason} />
        )}

        <AiSummaryCard
          summary={summaries.byRoomId.get(item.id)}
          processingStatus={item.processingStatus}
          confirmedAt={item.summaryConfirmedAt}
          confirming={updates.confirmSummary.isPending}
          onConfirm={() => updates.confirmSummary.mutate()}
        />
        {/* Offline is the expected case here, and its message already says the
            confirmation is safe on the device — so this reads as reassurance
            rather than a failure the technician has to act on. */}
        {updates.confirmSummary.error ? (
          <Text className="mx-5 mt-2 text-xs leading-5 text-muted-foreground">
            {updates.confirmSummary.error.message}
          </Text>
        ) : null}

        {/* Only shown once analysis has produced something. An empty "Findings"
            card during processing reads as "nothing wrong", which is a
            different and much more dangerous claim than "not analyzed yet". */}
        {roomFindings.length ? (
          <View className="mx-5 mt-4 rounded-2xl bg-card p-5">
            <View className="flex-row items-center justify-between">
              <Text className="text-base font-semibold text-foreground">AI findings</Text>
              <View className="rounded-full bg-muted px-2.5 py-1">
                <Text className="text-xs font-semibold text-muted-foreground">
                  {roomFindings.length}
                </Text>
              </View>
            </View>
            {roomFindings.map((finding, index) => (
              <FindingRow
                finding={finding}
                key={finding.id}
                last={index === roomFindings.length - 1}
                onPress={() =>
                  router.push({
                    pathname: '/(app)/findings/[id]',
                    params: { id: finding.id, inspectionId },
                  })
                }
              />
            ))}
          </View>
        ) : null}

        {/* There is no "Mark Complete" here any more.

            Completion is the upload succeeding. The technician already decided
            when they submitted the walkthrough, and a second button afterwards
            could only be forgotten — leaving an area that blocks submission of
            an inspection whose evidence is safely stored. The status line above
            says where the upload has got to instead.

            Adding more video stays available at every stage, including after
            the area completes: noticing something else in a room is normal, and
            an extra clip does not undo the walkthrough. */}
        {hasRecording ? (
          <View className="mx-5 mt-4">
            <Pressable
              accessibilityHint="Records an extra clip without replacing the main walkthrough"
              accessibilityLabel="Add additional video"
              accessibilityRole="button"
              className="min-h-12 items-center justify-center rounded-xl border border-border bg-card py-3"
              onPress={() =>
                router.push(`/camera/${inspectionId}/${id}?recordingType=ADDITIONAL_ISSUE`)
              }
            >
              <Text className="font-semibold text-foreground">Add Additional Video</Text>
            </Pressable>
          </View>
        ) : null}
        <Pressable
          accessibilityHint="Asks for a reason, then records this area as not inspected"
          accessibilityLabel="Mark area as skipped"
          accessibilityRole="button"
          className="mx-5 mt-4 min-h-12 items-center justify-center py-3"
          onPress={() => setSkipOpen(true)}
        >
          <Text className="font-semibold text-muted-foreground">Mark as Skipped</Text>
        </Pressable>
      </ScrollView>

      <View className="absolute bottom-0 left-0 right-0 border-t border-border bg-background px-5 pb-8 pt-3">
        <Pressable
          className="items-center rounded-xl bg-primary py-3.5 active:scale-[0.98]"
          onPress={() =>
            router.push(
              hasRecording
                ? `/camera/${inspectionId}/${id}?recordingType=ADDITIONAL_ISSUE`
                : `/camera/${inspectionId}/${id}`,
            )
          }
        >
          <View className="flex-row items-center gap-2">
            {hasRecording ? (
              <CameraIcon size={18} className="text-primary-foreground" />
            ) : (
              <PlayCircleIcon size={18} className="text-primary-foreground" />
            )}
            <Text className="font-bold text-primary-foreground">
              {hasRecording ? 'Record Additional Video' : 'Begin Walkthrough'}
            </Text>
          </View>
        </Pressable>
      </View>

      {/* 'alert' so a screen reader reports the context switch instead of
          silently moving focus into a new layer. */}
      <BottomSheet
        accessibilityRole="alert"
        animationType="fade"
        onClose={() => setSkipOpen(false)}
        visible={skipOpen}
      >
        <Text className="text-xl font-bold text-foreground">Skip this room?</Text>
        <Text nativeID="skip-reason-label" className="mt-2 text-sm leading-5 text-muted-foreground">
          Provide a reason for the administrator and audit trail.
        </Text>
        <TextInput
          accessibilityLabel="Reason for skipping this room"
          accessibilityLabelledBy="skip-reason-label"
          className="mt-4 min-h-24 rounded-xl border border-border bg-card px-4 py-3 text-foreground"
          multiline
          textAlignVertical="top"
          placeholder="Why can this room not be inspected?"
          placeholderTextColor={isDark ? '#5e6b78' : '#9a9484'}
          value={skipReason}
          onChangeText={setSkipReason}
        />
        <View className="mt-4 flex-row gap-3">
          <Pressable
            accessibilityLabel="Cancel"
            accessibilityRole="button"
            className="min-h-12 flex-1 items-center justify-center rounded-xl border border-border py-3"
            onPress={() => setSkipOpen(false)}
          >
            <Text className="font-semibold text-foreground">Cancel</Text>
          </Pressable>
          <Pressable
            accessibilityHint={skipReason.trim() ? undefined : 'Enter a reason before skipping'}
            accessibilityLabel={updates.skip.isPending ? 'Saving' : 'Skip room'}
            accessibilityRole="button"
            accessibilityState={{
              busy: updates.skip.isPending,
              disabled: !skipReason.trim() || updates.skip.isPending,
            }}
            className={`min-h-12 flex-1 items-center justify-center rounded-xl py-3 ${
              skipReason.trim() ? 'bg-primary' : 'bg-muted'
            }`}
            disabled={!skipReason.trim() || updates.skip.isPending}
            onPress={() =>
              updates.skip.mutate(skipReason.trim(), {
                onSuccess: () => {
                  setSkipOpen(false);
                  setSkipReason('');
                  router.back();
                },
              })
            }
          >
            <Text
              className={`font-bold ${
                skipReason.trim() ? 'text-primary-foreground' : 'text-muted-foreground'
              }`}
            >
              {updates.skip.isPending ? 'Saving…' : 'Skip Room'}
            </Text>
          </Pressable>
        </View>
      </BottomSheet>
    </SafeAreaView>
  );
}
