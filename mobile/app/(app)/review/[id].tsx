import { router, useLocalSearchParams } from 'expo-router';
import {
  AlertTriangleIcon,
  ArrowLeftIcon,
  CameraIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  CircleIcon,
  Clock3Icon,
  FileTextIcon,
  Loader2Icon,
  MapPinIcon,
  SendIcon,
  ShieldCheckIcon,
  SparklesIcon,
} from 'lucide-react-native';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { InspectionReportRoom } from '@/src/domain/models';
import { useInspectionActions, useInspectionReport } from '@/src/features/queries';
import { useDemoStore } from '@/src/stores/demo.store';
import { AI_REVIEW_DISCLAIMER } from '@/src/utils/ai-review';
import { FINISHED_STATUSES, evaluateSubmissionGate } from '@/src/utils/submission-gate';
import { HomeButton } from '@/src/components/HomeButton';
import { registerIcons } from '@/src/lib/icons';

registerIcons(
  AlertTriangleIcon,
  ArrowLeftIcon,
  CameraIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  CircleIcon,
  Clock3Icon,
  FileTextIcon,
  Loader2Icon,
  MapPinIcon,
  SendIcon,
  ShieldCheckIcon,
  SparklesIcon,
);

function readable(value: string) {
  return value
    .toLowerCase()
    .replaceAll('_', ' ')
    .replace(/^\w/, (letter) => letter.toUpperCase());
}

function RoomReviewRow({
  inspectionId,
  room,
}: {
  inspectionId: string;
  room: InspectionReportRoom;
}) {
  const finished = FINISHED_STATUSES.has(room.completionStatus);
  const findingCount = room.findings?.length ?? 0;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Review ${room.name}`}
      className="flex-row items-center gap-3 border-b border-border py-3 last:border-b-0 active:opacity-60"
      onPress={() =>
        router.push({
          pathname: '/(app)/areas/[id]',
          params: { id: room.id, inspectionId },
        })
      }
    >
      <View
        className={`h-8 w-8 items-center justify-center rounded-full ${
          finished ? 'bg-chart-3/15' : 'bg-muted'
        }`}
      >
        {finished ? (
          <CheckCircle2Icon size={16} className="text-chart-3" />
        ) : (
          <CircleIcon size={16} className="text-muted-foreground" />
        )}
      </View>
      <View className="min-w-0 flex-1">
        <Text className="text-sm font-semibold text-foreground">{room.name}</Text>
        <Text className="mt-0.5 text-xs text-muted-foreground">
          {room.floorName} · {room.photoCount} photo{room.photoCount === 1 ? '' : 's'}
          {/* Same restored-cache caveat as the findings list below: a payload
              written by an older room shape can reach this card without the
              field. */}
          {findingCount ? ` · ${findingCount} finding${findingCount === 1 ? '' : 's'}` : ''}
        </Text>
        {/* One line of the AI's own words, so the pre-submit check is a real
            read-through rather than a count of rows. */}
        {room.summary ? (
          <Text className="mt-1 text-xs italic leading-5 text-muted-foreground" numberOfLines={2}>
            {room.summary}
          </Text>
        ) : null}
      </View>
      <Text
        className={`text-xs font-semibold ${finished ? 'text-chart-3' : 'text-muted-foreground'}`}
      >
        {readable(room.completionStatus)}
      </Text>
      <ChevronRightIcon size={15} className="text-muted-foreground" />
    </Pressable>
  );
}

export default function InspectionReviewScreen() {
  const { id = '' } = useLocalSearchParams<{ id: string }>();
  const report = useInspectionReport(id);
  const actions = useInspectionActions(id);
  // Only the *pending* count comes from the device: an item still in the
  // local queue is by definition not yet on the server. Everything else reads
  // from the report, so a reinstalled or replacement handset does not report
  // zero evidence at the moment of submission.
  const pendingSnapshots = useDemoStore(
    (state) =>
      (state.snapshots ?? []).filter(
        (snapshot) =>
          snapshot.inspectionId === id &&
          ['PENDING', 'UPLOADING', 'FAILED'].includes(snapshot.uploadStatus ?? 'PENDING'),
      ).length,
  );

  if (report.isLoading) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-background px-6">
        <View className="h-14 w-14 items-center justify-center rounded-2xl bg-primary/10">
          <Clock3Icon size={28} className="text-primary" />
        </View>
        <Text className="mt-4 text-base font-semibold text-foreground">
          Preparing final review…
        </Text>
        <Text className="mt-1 text-center text-sm text-muted-foreground">
          Verifying rooms, evidence, and AI processing status
        </Text>
      </SafeAreaView>
    );
  }

  if (!report.data) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-background px-6">
        <AlertTriangleIcon size={36} className="text-destructive" />
        <Text className="mt-4 text-xl font-bold text-foreground">Review unavailable</Text>
        <Text className="mt-2 text-center text-sm text-muted-foreground">
          {report.error instanceof Error ? report.error.message : 'The review could not be loaded.'}
        </Text>
        <Pressable
          accessibilityLabel="Try loading the review again"
          accessibilityRole="button"
          className="mt-5 min-h-12 justify-center rounded-xl bg-primary px-6 py-3"
          onPress={() => void report.refetch()}
        >
          <Text className="font-bold text-primary-foreground">Try again</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  const { inspection, property, rooms, totals, generatedAt } = report.data;
  const {
    canSubmit,
    blockedReason,
    incompleteRequiredRooms,
    unconfirmedSummaryRooms,
    analysisPendingRooms,
  } = evaluateSubmissionGate(rooms, inspection.status);
  // `findings` is required by the report schema, so a live response always has
  // it. A warm-start restore does not go through that schema — the persisted
  // react-query cache is written back as-is — so a payload stored by an older
  // shape can arrive here without the field and take the whole screen down with
  // it. The cache buster clears those on upgrade; this keeps a technician
  // standing in a unit from losing the review screen if one ever slips through.
  const findings = rooms.flatMap((room) =>
    (room.findings ?? []).map((finding) => ({ ...finding, roomName: room.name })),
  );
  const completedPercent = rooms.length
    ? Math.round((totals.finishedRooms / rooms.length) * 100)
    : 0;

  const submitInspection = () => {
    Alert.alert(
      'Submit Inspection?',
      'This closes field capture for the inspection. Evidence already queued will continue uploading in the background.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Submit',
          onPress: () =>
            actions.complete.mutate(undefined, {
              onSuccess: () =>
                Alert.alert(
                  'Inspection Submitted',
                  'The inspection is complete. Pending evidence remains safely queued.',
                  [
                    {
                      text: 'Done',
                      onPress: () => router.replace('/(app)/(tabs)/inspections'),
                    },
                  ],
                ),
            }),
        },
      ],
    );
  };

  return (
    <SafeAreaView edges={['top']} className="flex-1 bg-background">
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingBottom: inspection.status === 'IN_PROGRESS' ? 132 : 36 }}
        showsVerticalScrollIndicator={false}
      >
        <View className="flex-row items-center gap-3 px-5 pb-3 pt-2">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back"
            className="h-9 w-9 items-center justify-center rounded-full bg-card active:scale-95"
            onPress={() => router.back()}
          >
            <ArrowLeftIcon size={18} className="text-foreground" />
          </Pressable>
          <View className="min-w-0 flex-1">
            <Text className="text-lg font-bold text-foreground">Final Review</Text>
            <Text className="text-xs text-muted-foreground">
              Verify all evidence before submitting
            </Text>
          </View>
          <HomeButton />
        </View>

        {incompleteRequiredRooms.length > 0 && inspection.status === 'IN_PROGRESS' ? (
          <View className="mx-5 mt-2 flex-row items-center gap-3 rounded-2xl border border-chart-4/20 bg-chart-4/10 p-4">
            <AlertTriangleIcon size={20} className="text-chart-4" />
            <View className="min-w-0 flex-1">
              <Text className="text-sm font-semibold text-chart-4">Incomplete rooms</Text>
              <Text className="mt-0.5 text-xs leading-5 text-chart-4">
                {incompleteRequiredRooms.length} required room
                {incompleteRequiredRooms.length === 1 ? '' : 's'} still need documentation.
              </Text>
            </View>
          </View>
        ) : null}

        {/* Deliberately not tappable and not phrased as a task: nothing here is
            the technician's to do. The screen polls while this is showing, so
            it clears itself — saying how long it usually takes is what stops a
            short wait reading as a stuck button. */}
        {analysisPendingRooms.length > 0 && inspection.status === 'IN_PROGRESS' ? (
          <View className="mx-5 mt-2 flex-row items-center gap-3 rounded-2xl border border-border bg-card p-4">
            <Loader2Icon size={20} className="text-muted-foreground" />
            <View className="min-w-0 flex-1">
              <Text className="text-sm font-semibold text-foreground">
                Analyzing {analysisPendingRooms.length} area
                {analysisPendingRooms.length === 1 ? '' : 's'}
              </Text>
              <Text className="mt-0.5 text-xs leading-5 text-muted-foreground">
                Summaries usually arrive within a minute. This updates on its own — you do not need
                to do anything.
              </Text>
            </View>
          </View>
        ) : null}

        {/* Tappable, unlike the incomplete-rooms notice above: this one names a
            specific area the technician has to open and read, so the panel is
            the route there rather than a message about somewhere else. */}
        {unconfirmedSummaryRooms.length > 0 && inspection.status === 'IN_PROGRESS' ? (
          <View className="mx-5 mt-2 rounded-2xl border border-primary/20 bg-primary/5 p-4">
            <View className="flex-row items-center gap-3">
              <SparklesIcon size={20} className="text-primary" />
              <View className="min-w-0 flex-1">
                <Text className="text-sm font-semibold text-primary">
                  {unconfirmedSummaryRooms.length} AI summar
                  {unconfirmedSummaryRooms.length === 1 ? 'y' : 'ies'} to review
                </Text>
                <Text className="mt-0.5 text-xs leading-5 text-primary">
                  Open each area and confirm the summary matches what you saw.
                </Text>
              </View>
            </View>
            <View className="mt-3 gap-2">
              {unconfirmedSummaryRooms.map((room) => (
                <Pressable
                  accessibilityLabel={`Review the AI summary for ${room.name}`}
                  accessibilityRole="button"
                  className="min-h-12 flex-row items-center gap-2 rounded-xl bg-card px-3 py-3 active:opacity-70"
                  key={room.id}
                  onPress={() =>
                    router.push({
                      pathname: '/(app)/areas/[id]',
                      params: { id: room.id, inspectionId: inspection.id },
                    })
                  }
                >
                  <Text className="min-w-0 flex-1 text-sm font-semibold text-foreground">
                    {room.name}
                  </Text>
                  <ChevronRightIcon size={15} className="text-muted-foreground" />
                </Pressable>
              ))}
            </View>
          </View>
        ) : null}

        <View className="mx-5 mt-4 gap-3 rounded-2xl bg-card p-5">
          <View className="flex-row items-start gap-3">
            <View className="h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
              <MapPinIcon size={19} className="text-primary" />
            </View>
            <View className="min-w-0 flex-1">
              <Text className="text-base font-bold text-foreground">{property.address}</Text>
              <Text className="mt-0.5 text-sm text-muted-foreground">{property.cityStateZip}</Text>
            </View>
          </View>
          <View className="flex-row items-center gap-2">
            <Clock3Icon size={14} className="text-muted-foreground" />
            <Text className="text-xs text-muted-foreground">
              {readable(inspection.type)} ·{' '}
              {new Date(inspection.scheduledAt).toLocaleDateString('en-US', {
                month: 'long',
                day: 'numeric',
                year: 'numeric',
              })}
            </Text>
          </View>
        </View>

        <View className="mx-5 mt-4 rounded-2xl bg-card p-5">
          <View className="flex-row items-center justify-between">
            <Text className="text-base font-semibold text-foreground">
              Areas ({totals.finishedRooms}/{rooms.length})
            </Text>
            <Text className="text-xs font-bold text-primary">{completedPercent}%</Text>
          </View>
          <View className="mb-2 mt-3 h-2 overflow-hidden rounded-full bg-muted">
            <View
              className={`h-full rounded-full ${
                incompleteRequiredRooms.length ? 'bg-primary' : 'bg-chart-3'
              }`}
              style={{ width: `${completedPercent}%` }}
            />
          </View>
          {rooms.map((room) => (
            <RoomReviewRow key={room.id} inspectionId={id} room={room} />
          ))}
        </View>

        <View className="mx-5 mt-4 flex-row gap-3">
          <View className="flex-1 items-center rounded-2xl bg-card p-4">
            <View className="mb-2 h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
              <CameraIcon size={18} className="text-primary" />
            </View>
            <Text className="text-2xl font-bold text-foreground">{totals.photos}</Text>
            <Text className="mt-0.5 text-xs text-muted-foreground">Photos</Text>
          </View>
          <View className="flex-1 items-center rounded-2xl bg-card p-4">
            <View className="mb-2 h-10 w-10 items-center justify-center rounded-xl bg-chart-1/10">
              <FileTextIcon size={18} className="text-chart-1" />
            </View>
            <Text className="text-2xl font-bold text-foreground">{findings.length}</Text>
            <Text className="mt-0.5 text-xs text-muted-foreground">Findings</Text>
          </View>
          <View className="flex-1 items-center rounded-2xl bg-card p-4">
            <View
              className={`mb-2 h-10 w-10 items-center justify-center rounded-xl ${
                pendingSnapshots ? 'bg-chart-4/10' : 'bg-chart-3/10'
              }`}
            >
              <ShieldCheckIcon
                size={18}
                className={pendingSnapshots ? 'text-chart-4' : 'text-chart-3'}
              />
            </View>
            <Text
              className={`text-2xl font-bold ${
                pendingSnapshots ? 'text-chart-4' : 'text-foreground'
              }`}
            >
              {pendingSnapshots}
            </Text>
            <Text className="mt-0.5 text-xs text-muted-foreground">Pending</Text>
          </View>
        </View>

        <View className="mx-5 mt-4 rounded-2xl bg-card p-5">
          <View className="flex-row items-center justify-between">
            <Text className="text-base font-semibold text-foreground">Findings Summary</Text>
            <View className="rounded-full bg-muted px-2.5 py-1">
              <Text className="text-xs font-semibold text-muted-foreground">
                {findings.length} total
              </Text>
            </View>
          </View>
          {findings.length ? (
            findings.map((finding) => (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${finding.title}, ${finding.roomName}, ${readable(finding.severity)} severity`}
                accessibilityHint="Opens the full AI finding"
                key={finding.id}
                className="min-h-[52px] flex-row items-start gap-3 border-b border-border py-3 last:border-b-0 active:opacity-60"
                onPress={() =>
                  router.push({
                    pathname: '/(app)/findings/[id]',
                    params: { id: finding.id, inspectionId: id },
                  })
                }
              >
                <View
                  className={`mt-1.5 h-2 w-2 rounded-full ${
                    finding.severity === 'HIGH'
                      ? 'bg-destructive'
                      : finding.severity === 'MEDIUM'
                        ? 'bg-chart-1'
                        : 'bg-chart-4'
                  }`}
                />
                <View className="min-w-0 flex-1">
                  <View className="flex-row items-start justify-between gap-2">
                    <Text className="min-w-0 flex-1 text-sm font-semibold text-foreground">
                      {finding.title}
                    </Text>
                    <Text className="text-xs font-semibold text-muted-foreground">
                      {readable(finding.severity)}
                    </Text>
                  </View>
                  <Text className="mt-0.5 text-xs text-muted-foreground">
                    {finding.roomName} · {readable(finding.reviewStatus)}
                  </Text>
                </View>
                <ChevronRightIcon size={15} className="mt-1 text-muted-foreground" />
              </Pressable>
            ))
          ) : (
            <View className="items-center py-7">
              <CheckCircle2Icon size={28} className="text-chart-3" />
              <Text className="mt-2 text-sm font-semibold text-foreground">
                No findings generated
              </Text>
              <Text className="mt-1 text-center text-xs text-muted-foreground">
                AI summaries will appear after room evidence finishes processing.
              </Text>
            </View>
          )}
          {/* Shown whenever findings exist, not only while some are unreviewed:
              the caveat applies to the AI text itself, so it must not vanish
              once the office has worked through the queue. */}
          {findings.length ? (
            <View className="mt-3 rounded-xl bg-muted p-3">
              <Text className="text-xs leading-5 text-muted-foreground">
                {AI_REVIEW_DISCLAIMER}
              </Text>
            </View>
          ) : null}
          <Text className="mt-3 text-xs text-muted-foreground">
            Last prepared {new Date(generatedAt).toLocaleString()}
          </Text>
        </View>
      </ScrollView>

      {inspection.status === 'IN_PROGRESS' ? (
        <View className="absolute inset-x-0 bottom-0 border-t border-border bg-background px-5 pb-8 pt-3">
          <Pressable
            // Disabled with no stated reason reads as a bug, and this is the
            // last control before an inspection leaves the technician's hands.
            accessibilityHint={blockedReason}
            accessibilityLabel={
              actions.complete.isPending
                ? 'Submitting inspection'
                : canSubmit
                  ? 'Submit inspection'
                  : `Submit inspection, unavailable. ${blockedReason}`
            }
            accessibilityRole="button"
            accessibilityState={{
              busy: actions.complete.isPending,
              disabled: !canSubmit || actions.complete.isPending,
            }}
            className={`min-h-12 flex-row items-center justify-center gap-2 rounded-xl py-4 ${
              canSubmit ? 'bg-primary active:scale-[0.98]' : 'bg-primary/40'
            }`}
            disabled={!canSubmit || actions.complete.isPending}
            onPress={submitInspection}
          >
            <SendIcon size={18} className="text-primary-foreground" />
            <Text className="font-bold text-primary-foreground">
              {actions.complete.isPending
                ? 'Submitting inspection…'
                : (blockedReason ?? 'Submit inspection')}
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
