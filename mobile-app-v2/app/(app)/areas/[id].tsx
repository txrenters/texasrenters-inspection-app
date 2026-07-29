import { useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { cssInterop, useColorScheme } from 'nativewind';
import {
  ArrowLeftIcon,
  CameraIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  CircleIcon,
  Edit3Icon,
  FileTextIcon,
  PlayCircleIcon,
  SaveIcon,
} from 'lucide-react-native';
import {
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useFindings, useRoom, useRoomMedia, useUpdateRoom } from '@/src/features/queries';

for (const icon of [
  ArrowLeftIcon,
  CameraIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  CircleIcon,
  Edit3Icon,
  FileTextIcon,
  PlayCircleIcon,
  SaveIcon,
]) {
  cssInterop(icon, { className: { target: 'style', nativeStyleToProp: { color: true } } });
}

export default function AreaDetailScreen() {
  const { id = '' } = useLocalSearchParams<{ id: string }>();
  const room = useRoom(id);
  const inspectionId = room.data?.inspectionId ?? '';
  const media = useRoomMedia(id);
  const findings = useFindings(inspectionId);
  const updates = useUpdateRoom(inspectionId, id);
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const [note, setNote] = useState<string | null>(null);
  const [skipOpen, setSkipOpen] = useState(false);
  const [skipReason, setSkipReason] = useState('');

  if (room.isLoading || !room.data) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-background">
        <Text className="text-muted-foreground">Loading room…</Text>
      </SafeAreaView>
    );
  }

  const item = room.data;
  const displayedNote = note ?? item.note ?? '';
  const roomFindings = (findings.data ?? []).filter((finding) => finding.roomId === item.id);
  const hasRecording = Boolean(media.data?.length);
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
            refreshing={room.isRefetching || media.isRefetching || findings.isRefetching}
            onRefresh={() => void Promise.all([room.refetch(), media.refetch(), findings.refetch()])}
            tintColor={isDark ? '#2dd4bf' : '#145347'}
          />
        }
      >
        <View className="flex-row items-center gap-3 px-5 pb-3 pt-2">
          <Pressable
            className="h-9 w-9 items-center justify-center rounded-full bg-card active:scale-[0.95]"
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
            media.data.map((recording) => (
              <View
                key={recording.id}
                className="flex-row items-center justify-between rounded-xl bg-muted p-3"
              >
                <View className="flex-1">
                  <Text className="text-sm font-semibold text-foreground">
                    {recording.label || 'Primary room walkthrough'}
                  </Text>
                  <Text className="mt-0.5 text-xs text-muted-foreground">
                    {recording.durationSeconds}s · stored on device
                  </Text>
                </View>
                <CheckCircle2Icon size={18} className="text-chart-3" />
              </View>
            ))
          ) : (
            <Pressable
              className="flex-row items-center gap-3 rounded-xl bg-muted p-4 active:opacity-70"
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
          <Text className="text-base font-semibold text-foreground">Technician Note</Text>
          <TextInput
            className="mt-3 min-h-24 rounded-xl border border-border bg-muted px-4 py-3 text-base text-foreground"
            multiline
            textAlignVertical="top"
            placeholder="Add an observation or reminder"
            placeholderTextColor={isDark ? '#5e6b78' : '#9a9484'}
            value={displayedNote}
            onChangeText={setNote}
          />
          <Pressable
            className="mt-3 flex-row items-center justify-center gap-2 rounded-xl bg-muted py-3"
            disabled={updates.note.isPending || displayedNote === (item.note ?? '')}
            onPress={() => updates.note.mutate(displayedNote)}
          >
            <SaveIcon size={16} className="text-primary" />
            <Text className="font-semibold text-primary">
              {updates.note.isPending ? 'Saving…' : 'Save Note'}
            </Text>
          </Pressable>
        </View>

        <View className="mx-5 mt-4 rounded-2xl bg-card p-5">
          <Text className="text-base font-semibold text-foreground">Room Status</Text>
          {[
            ['Baseline reviewed', true],
            ['Recording saved', hasRecording],
            ['Upload confirmed', item.uploadStatus === 'COMPLETED'],
            ['AI findings ready', item.processingStatus === 'READY_FOR_REVIEW'],
          ].map(([label, done]) => (
            <View key={String(label)} className="mt-4 flex-row items-center gap-3">
              {done ? (
                <CheckCircle2Icon size={21} className="text-chart-3" />
              ) : (
                <CircleIcon size={21} className="text-muted-foreground" />
              )}
              <Text className={done ? 'text-foreground' : 'text-muted-foreground'}>
                {String(label)}
              </Text>
            </View>
          ))}
          {roomFindings.length ? (
            <View className="mt-4 rounded-xl bg-primary/10 p-3">
              <Text className="text-sm font-semibold text-primary">
                {roomFindings.length} finding{roomFindings.length === 1 ? '' : 's'} ready for review
              </Text>
            </View>
          ) : null}
        </View>

        {hasRecording ? (
          <View className="mx-5 mt-4 flex-row gap-3">
            <Pressable
              className="flex-1 items-center rounded-xl border border-border bg-card py-3"
              onPress={() =>
                router.push(`/camera/${inspectionId}/${id}?recordingType=ADDITIONAL_ISSUE`)
              }
            >
              <Text className="font-semibold text-foreground">Add Additional Video</Text>
            </Pressable>
            <Pressable
              className="flex-1 items-center rounded-xl bg-card py-3"
              disabled={updates.complete.isPending}
              onPress={() => updates.complete.mutate()}
            >
              <Text className="font-semibold text-foreground">Mark Complete</Text>
            </Pressable>
          </View>
        ) : null}
        <Pressable className="mx-5 mt-4 items-center py-3" onPress={() => setSkipOpen(true)}>
          <Text className="font-semibold text-muted-foreground">Mark as Skipped</Text>
        </Pressable>
      </ScrollView>

      <View className="absolute bottom-0 left-0 right-0 border-t border-border bg-background px-5 pb-8 pt-3">
        <Pressable
          className="items-center rounded-xl bg-primary py-3.5 active:scale-[0.98]"
          onPress={() => router.push(`/camera/${inspectionId}/${id}`)}
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

      <Modal
        animationType="fade"
        transparent
        visible={skipOpen}
        onRequestClose={() => setSkipOpen(false)}
      >
        <View className="flex-1 justify-end bg-black/55">
          <View className="rounded-t-3xl bg-background px-5 pb-10 pt-6">
            <Text className="text-xl font-bold text-foreground">Skip this room?</Text>
            <Text className="mt-2 text-sm leading-5 text-muted-foreground">
              Provide a reason for the administrator and audit trail.
            </Text>
            <TextInput
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
                className="flex-1 items-center rounded-xl border border-border py-3"
                onPress={() => setSkipOpen(false)}
              >
                <Text className="font-semibold text-foreground">Cancel</Text>
              </Pressable>
              <Pressable
                className={`flex-1 items-center rounded-xl py-3 ${
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
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}
