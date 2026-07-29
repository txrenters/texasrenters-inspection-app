import { router, useLocalSearchParams } from 'expo-router';
import { cssInterop } from 'nativewind';
import {
  AlertTriangleIcon,
  ArrowLeftIcon,
  CheckCircle2Icon,
  Clock3Icon,
} from 'lucide-react-native';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { InspectionReportRoom } from '@/src/domain/models';
import { useInspectionActions, useInspectionReport } from '@/src/features/queries';

for (const icon of [AlertTriangleIcon, ArrowLeftIcon, CheckCircle2Icon, Clock3Icon]) {
  cssInterop(icon, { className: { target: 'style', nativeStyleToProp: { color: true } } });
}

const finishedStatuses = new Set(['COMPLETED', 'SKIPPED', 'RECORDING_SAVED']);

function readable(value: string) {
  return value
    .toLowerCase()
    .replaceAll('_', ' ')
    .replace(/^\w/, (letter) => letter.toUpperCase());
}

function RoomReport({ room }: { room: InspectionReportRoom }) {
  const finished = finishedStatuses.has(room.completionStatus);
  return (
    <View className="mt-3 rounded-2xl border border-border bg-card p-4">
      <View className="flex-row items-start justify-between gap-3">
        <View className="min-w-0 flex-1">
          <Text className="text-base font-bold text-foreground">{room.name}</Text>
          <Text className="mt-0.5 text-xs text-muted-foreground">{room.floorName}</Text>
        </View>
        <View
          className={`rounded-full px-3 py-1 ${
            finished ? 'bg-green-500/10' : 'bg-amber-500/10'
          }`}
        >
          <Text
            className={`text-xs font-bold ${
              finished ? 'text-green-600' : 'text-amber-600'
            }`}
          >
            {readable(room.completionStatus)}
          </Text>
        </View>
      </View>
      {room.completionStatus === 'SKIPPED' && room.skipReason ? (
        <Text className="mt-3 text-sm text-muted-foreground">Skipped: {room.skipReason}</Text>
      ) : null}
      <Text className="mt-4 text-xs font-bold uppercase tracking-wider text-primary">
        AI condition summary
      </Text>
      <Text className="mt-2 text-sm leading-6 text-foreground">
        {room.summary ??
          (room.processingStatus === 'READY_FOR_REVIEW'
            ? 'No summary was produced for this room.'
            : 'The recording is still being transcribed and summarized.')}
      </Text>
      {room.findings.length ? (
        <View className="mt-4 gap-2">
          {room.findings.map((finding) => (
            <View key={finding.id} className="rounded-xl bg-muted p-3">
              <View className="flex-row items-start justify-between gap-3">
                <Text className="min-w-0 flex-1 text-sm font-bold text-foreground">
                  {finding.title}
                </Text>
                <Text
                  className={`text-xs font-bold ${
                    finding.severity === 'HIGH' ? 'text-destructive' : 'text-muted-foreground'
                  }`}
                >
                  {finding.severity}
                </Text>
              </View>
              <Text className="mt-1 text-xs leading-5 text-muted-foreground">
                {finding.description}
              </Text>
              <Text className="mt-2 text-xs font-semibold text-primary">
                {readable(finding.reviewStatus)}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

export default function InspectionReviewScreen() {
  const { id = '' } = useLocalSearchParams<{ id: string }>();
  const report = useInspectionReport(id);
  const actions = useInspectionActions(id);

  if (report.isLoading) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-background px-6">
        <Clock3Icon size={34} className="text-primary" />
        <Text className="mt-4 font-semibold text-foreground">
          Preparing the inspection report…
        </Text>
      </SafeAreaView>
    );
  }

  if (!report.data) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-background px-6">
        <AlertTriangleIcon size={36} className="text-destructive" />
        <Text className="mt-4 text-xl font-bold text-foreground">Report unavailable</Text>
        <Text className="mt-2 text-center text-sm text-muted-foreground">
          {report.error instanceof Error ? report.error.message : 'The report could not be loaded.'}
        </Text>
        <Pressable
          className="mt-5 rounded-xl bg-primary px-6 py-3"
          onPress={() => void report.refetch()}
        >
          <Text className="font-bold text-primary-foreground">Try again</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  const { inspection, property, rooms, totals, generatedAt } = report.data;
  const allRequiredFinished = rooms
    .filter((room) => room.isRequired)
    .every((room) => finishedStatuses.has(room.completionStatus));
  const canSubmit = inspection.status === 'IN_PROGRESS' && allRequiredFinished;

  return (
    <SafeAreaView edges={['top']} className="flex-1 bg-background">
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingBottom: canSubmit ? 126 : 32 }}
        showsVerticalScrollIndicator={false}
      >
        <View className="flex-row items-center gap-3 px-5 pb-3 pt-2">
          <Pressable
            className="h-10 w-10 items-center justify-center rounded-full bg-card"
            onPress={() => router.back()}
          >
            <ArrowLeftIcon size={20} className="text-foreground" />
          </Pressable>
          <View className="min-w-0 flex-1">
            <Text className="text-xl font-bold text-foreground">Inspection report</Text>
            <Text numberOfLines={1} className="text-xs text-muted-foreground">
              {property.address} · {readable(inspection.type)}
            </Text>
          </View>
        </View>

        <View className="mx-5 mt-3 rounded-2xl bg-card p-5">
          <View className="flex-row items-start justify-between gap-3">
            <View className="min-w-0 flex-1">
              <Text className="text-xs font-bold uppercase tracking-wider text-primary">
                Consolidated evidence
              </Text>
              <Text className="mt-1 text-lg font-bold text-foreground">
                {totals.finishedRooms} of {totals.rooms} rooms finished
              </Text>
            </View>
            <CheckCircle2Icon size={24} className="text-green-600" />
          </View>
          <Text className="mt-3 text-sm leading-6 text-muted-foreground">
            {totals.summaries} AI summaries · {totals.defectFindings} reviewable findings ·{' '}
            {totals.pendingReviewCount} pending human review
          </Text>
          <Text className="mt-2 text-xs text-muted-foreground">
            Generated {new Date(generatedAt).toLocaleString()}
          </Text>
          {totals.pendingReviewCount ? (
            <View className="mt-4 rounded-xl bg-amber-500/10 p-3">
              <Text className="text-xs leading-5 text-amber-700">
                AI findings remain suggestions until an authorized person reviews them. They do not
                determine tenant responsibility or charges.
              </Text>
            </View>
          ) : null}
        </View>

        <View className="px-5 pt-6">
          <Text className="text-lg font-bold text-foreground">Room evidence</Text>
          {rooms.map((room) => (
            <RoomReport key={room.id} room={room} />
          ))}
        </View>

        {!allRequiredFinished && inspection.status === 'IN_PROGRESS' ? (
          <View className="mx-5 mt-5 rounded-xl bg-amber-500/10 p-4">
            <Text className="text-sm font-semibold text-amber-700">
              Finish or skip every required room before submitting this inspection.
            </Text>
          </View>
        ) : null}
      </ScrollView>

      {canSubmit ? (
        <View className="absolute inset-x-0 bottom-0 border-t border-border bg-background px-5 pb-8 pt-3">
          <Pressable
            className="items-center rounded-xl bg-primary py-4"
            disabled={actions.complete.isPending}
            onPress={() =>
              actions.complete.mutate(undefined, {
                onSuccess: () => void report.refetch(),
              })
            }
          >
            <Text className="font-bold text-primary-foreground">
              {actions.complete.isPending ? 'Submitting inspection…' : 'Submit inspection'}
            </Text>
          </Pressable>
          {actions.complete.isError ? (
            <Text className="mt-2 text-center text-xs text-destructive">
              {actions.complete.error instanceof Error
                ? actions.complete.error.message
                : 'The inspection could not be submitted.'}
            </Text>
          ) : null}
        </View>
      ) : null}
    </SafeAreaView>
  );
}
