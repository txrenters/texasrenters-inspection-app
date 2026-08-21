import { useMemo, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import {
  CameraIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  CircleIcon,
  Edit3Icon,
  FileTextIcon,
  PlayCircleIcon,
  RotateCwIcon,
} from 'lucide-react-native';
import {
  Image,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BackGlyph } from '@/src/components/ui/BackGlyph';
import { goBack } from '@/src/lib/navigation';
import { useAreaChecklist } from '@/src/capture/use-area-checklist';
import { useDemoStore } from '@/src/stores/demo.store';
import { useChecklistFromSummary } from '@/src/capture/useChecklistFromSummary';
import { AreaCompletionChecklist } from '@/src/components/AreaCompletionChecklist';
import { EvidenceRequestCard } from '@/src/components/EvidenceRequestCard';
import { BottomSheet } from '@/src/components/BottomSheet';
import { FindingRow } from '@/src/components/FindingRow';
import {
  useEvidenceRequests,
  useFindings,
  useResolveEvidenceRequest,
  useRoom,
  useRoomMedia,
  useRoomPhotos,
  useRoomSummaries,
  useUpdateArea,
  useUpdateRoom,
  useUploadActions,
} from '@/src/features/queries';
import { HomeButton } from '@/src/components/HomeButton';
import { DetailSkeleton } from '@/src/components/ui/Skeleton';
import { usePullToRefresh } from '@/src/features/usePullToRefresh';
import { areaCompletionGate, deriveAreaRequirements } from '@/src/utils/area-requirements';
import { describeRecordingLocation } from '@/src/utils/upload-status';
import { registerIcons } from '@/src/lib/icons';
import { useThemeColors } from '@/src/lib/theme-colors';
import { Button } from '@/src/components/ui';

registerIcons(
  CameraIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  CircleIcon,
  Edit3Icon,
  FileTextIcon,
  PlayCircleIcon,
  RotateCwIcon,
);

export default function AreaDetailScreen() {
  const { id = '' } = useLocalSearchParams<{ id: string }>();
  const room = useRoom(id);
  const inspectionId = room.data?.inspectionId ?? '';
  const media = useRoomMedia(id);
  const photos = useRoomPhotos(id);
  const findings = useFindings(inspectionId);
  /**
   * Poll only while a summary is genuinely on its way.
   *
   * This asked `processingStatus !== 'READY_FOR_REVIEW'`, which is true forever
   * for an area whose analysis failed and for one that was never recorded — so
   * an open area screen issued a request every five seconds, indefinitely. On a
   * mobile connection any one of those can time out, which is where the
   * "did not respond in time" errors came from.
   *
   * `analysisPending` is the server's own answer to the same question and is
   * bounded there: a pipeline that dies mid-run stops reporting pending, so
   * this cannot spin forever the way the status comparison did.
   */
  const summaries = useRoomSummaries(inspectionId, room.data?.analysisPending ?? false);
  const updates = useUpdateRoom(inspectionId, id);
  const pull = usePullToRefresh([room.refetch, media.refetch, photos.refetch, findings.refetch]);
  // The AI summary is transcript-derived, so what it mentions is what the
  // technician talked through. Ticks coverage automatically; never unticks.
  const areaChecklist = useAreaChecklist(id, {
    name: room.data?.name,
    environment: room.data?.environment,
  });
  useChecklistFromSummary(id, areaChecklist, summaries.byRoomId.get(id));
  // Scoped to this area: a request about the kitchen is not this room's problem,
  // and showing it here would send the technician to the wrong place.
  const uploadActions = useUploadActions();
  const updateArea = useUpdateArea(inspectionId, id);
  const evidenceRequests = useEvidenceRequests(inspectionId);
  const resolveRequest = useResolveEvidenceRequest(inspectionId);
  const areaRequests = (evidenceRequests.data ?? []).filter((request) => request.roomId === id);
  const theme = useThemeColors();
  /**
   * The photos taken on this device for this area, newest first.
   *
   * The selector returns the store's own array and the filtering happens in a
   * memo. Filtering *inside* the selector allocates a new array on every call,
   * which `useSyncExternalStore` reads as the store having changed — it then
   * re-renders, re-selects, and loops until React gives up.
   *
   * Read from the local store rather than the API: these are `file://` URIs
   * written by `persistRoomSnapshot`, so they render with no network and no
   * bearer token. The server's own photo rows carry an authenticated
   * `contentPath` that a bare <Image> cannot load, and nothing in the app
   * resolves one yet — so this shows what the technician captured, which is
   * what they come back to this screen to check.
   */
  const snapshots = useDemoStore((state) => state.snapshots);
  const areaSnapshots = useMemo(
    () => (snapshots ?? []).filter((snapshot) => snapshot.roomId === id),
    [snapshots, id],
  );
  /**
   * The photo open full screen, by uri.
   *
   * A thumbnail strip with nothing behind the tap is worse than no strip: the
   * technician is checking whether a shot came out, and 80px tells them very
   * little.
   */
  const [viewedPhoto, setViewedPhoto] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editedName, setEditedName] = useState('');
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
  /**
   * An equipment visit, not a condition walkthrough.
   *
   * Drives the guidance copy and the capture steps below. The room script asks
   * for a slow clockwise pass; servicing an air conditioner is the opposite
   * shape of job, filmed standing at one unit.
   */
  const isEquipmentVisit = item.inspectionType === 'HVAC';
  const roomFindings = (findings.data ?? []).filter((finding) => finding.roomId === item.id);
  const hasRecording = Boolean(media.data?.length);
  // The primary walkthrough is what the pipeline analyses, so it is the one to
  // re-run. Additional clips ride along with it.
  const primaryMediaId = media.data?.[0]?.id ?? null;
  const recordingCount = media.data?.length ?? 0;
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
            tintColor={theme.primary}
          />
        }
      >
        <View className="flex-row items-center gap-3 px-5 pb-3 pt-2">
          <Pressable
            accessibilityLabel="Back"
            accessibilityRole="button"
            className="h-9 w-9 items-center justify-center rounded-full bg-card active:scale-[0.98]"
            hitSlop={8}
            onPress={() => goBack()}
          >
            <BackGlyph size={18} className="text-foreground" />
          </Pressable>
          <View className="min-w-0 flex-1">
            <View className="flex-row items-center gap-2">
              <Text className="min-w-0 shrink text-lg font-bold text-foreground">{item.name}</Text>
              {/* Offered only for an area this technician added. One from a
                  floor plan is the office's catalog record, reused by every
                  future inspection of the property, so renaming it from the
                  field would change work nobody here is responsible for — the
                  server refuses it, and a button that always errors is worse
                  than none. */}
              {item.source === 'TECHNICIAN' ? (
                <Pressable
                  accessibilityLabel={`Rename ${item.name}`}
                  accessibilityRole="button"
                  hitSlop={8}
                  onPress={() => {
                    setEditedName(item.name);
                    setEditOpen(true);
                  }}
                >
                  <Edit3Icon size={15} className="text-muted-foreground" />
                </Pressable>
              ) : null}
            </View>
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

        {/* First thing in the area, above the baseline: an outstanding request
            is the reason the technician is standing here again. */}
        <EvidenceRequestCard
          onResolve={(requestId) => resolveRequest.mutate(requestId)}
          requests={areaRequests}
          resolving={resolveRequest.isPending}
        />

        {/* Absent on a visit that does not deal in baselines. An HVAC job is
            outside the move-in chain, so the whole card goes rather than
            showing "No move-in baseline is available" — which read as a gap in
            the record instead of a question that does not apply. */}
        {item.baseline ? (
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
        ) : null}

        <View className="mx-5 mt-4 rounded-2xl bg-card p-5">
          <View className="flex-row items-start gap-3">
            <View className="h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
              <RotateCwIcon size={19} className="text-primary" />
            </View>
            <View className="min-w-0 flex-1">
              <Text className="text-base font-semibold text-foreground">
                {isEquipmentVisit ? 'Equipment Walkthrough' : 'Clockwise Walkthrough'}
              </Text>
              <Text className="mt-1 text-xs leading-5 text-muted-foreground">
                {isEquipmentVisit
                  ? 'Cover the unit itself. There is no room sweep to complete: film what you are working on and narrate what you find.'
                  : 'Narrate one slow pass around the room. Use snapshots to document the overview and focused finding context without interrupting the video.'}
              </Text>
            </View>
          </View>
          <View className="mt-4 overflow-hidden rounded-xl bg-muted">
            {(isEquipmentVisit
              ? ([
                  ['1', 'Indoor unit', 'Film the head unit, its filter and the coil behind it'],
                  ['2', 'Drain and tray', 'Show the condensate path and any standing water'],
                  ['3', 'Running check', 'Narrate airflow, noise and vibration with it running'],
                  ['4', 'Outdoor unit', 'Capture the condenser and the refrigerant lines'],
                ] as const)
              : ([
                  ['1', 'Room overview', 'Capture the full room and primary circulation path'],
                  ['2', 'Walls & surfaces', 'Move clockwise and narrate visible conditions'],
                  ['3', 'Fixtures & details', 'Pause briefly on appliances, doors, and windows'],
                  ['4', 'Exit pass', 'Confirm the room name before ending the recording'],
                ] as const)
            ).map(([number, title, description], index) => (
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
            {/* Counts both kinds. It read "N saved" off recordings alone, so a
                technician who had taken ten photos and no video was told
                nothing was saved. */}
            <Text className="text-xs text-muted-foreground">
              {recordingCount} video{recordingCount === 1 ? '' : 's'} · {areaSnapshots.length} photo
              {areaSnapshots.length === 1 ? '' : 's'}
            </Text>
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
                  className="flex-row items-center justify-between rounded-xl bg-muted p-3 active:scale-[0.98]"
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
          ) : null}

          {/* Photos, below the recordings in the same card. They were captured
              here and counted toward completion but never shown, so a technician
              had no way to check what they had actually shot without leaving the
              app. Horizontal because a room can hold twenty and a grid would
              push everything below it off the screen. */}
          {areaSnapshots.length ? (
            <ScrollView
              accessibilityLabel={`${areaSnapshots.length} photos in this area`}
              className="-mx-1"
              horizontal
              showsHorizontalScrollIndicator={false}
            >
              {areaSnapshots.map((snapshot) => (
                <Pressable
                  accessibilityHint="Opens this photo full screen"
                  accessibilityLabel={`Photo taken ${new Date(snapshot.capturedAt).toLocaleTimeString()}`}
                  accessibilityRole="imagebutton"
                  key={snapshot.id}
                  onPress={() => setViewedPhoto(snapshot.uri)}
                >
                  <Image
                    accessibilityIgnoresInvertColors
                    className="mx-1 h-20 w-20 rounded-xl bg-muted"
                    resizeMode="cover"
                    source={{ uri: snapshot.uri }}
                  />
                </Pressable>
              ))}
            </ScrollView>
          ) : null}

          {!recordingCount ? (
            <Pressable
              accessibilityHint="Opens the camera for the primary room walkthrough"
              accessibilityLabel="No recording saved yet. Start the primary room walkthrough."
              accessibilityRole="button"
              className="min-h-14 flex-row items-center gap-3 rounded-xl bg-muted p-4 active:scale-[0.98]"
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
          ) : null}
        </View>


        {/* Replaces a hard-coded four-item list whose first row ("Baseline
            reviewed") was literally `true` and whose contents had no bearing on
            whether the area could actually be completed.

            Hidden once the area is finished: outstanding requirements on an
            already-completed or skipped area read as an unresolved problem. */}
        {alreadyFinished ? null : (
          <AreaCompletionChecklist requirements={requirements} blockedReason={gate.reason} />
        )}

        {/* The Clean / Undamaged / Working checklist used to sit here. It is now
            scored by the office during review, against the same items: the
            reviewer is the one reading the recording and the photographs, and
            each axis is a judgement about that evidence. The technician's job on
            site is to capture it. */}


        {/* Where analysis stands, and a way to run it again.
            Shown only when there is a recording but nothing came back from it:
            with findings on screen the state is self-evident, and with no
            recording there is nothing to analyse. Until now this screen said
            nothing at all in that case — a technician whose analysis had failed
            saw an area that simply looked empty, with no way to retry. */}
        {hasRecording && !roomFindings.length ? (
          <View className="mx-5 mt-4 rounded-2xl bg-card p-5">
            <Text className="text-base font-semibold text-foreground">AI analysis</Text>
            <Text className="mt-1 text-sm leading-6 text-muted-foreground">
              {item.analysisPending
                ? 'Running now. Findings appear here on their own, usually within a minute.'
                : item.processingStatus === 'FAILED'
                  ? 'Analysis could not be completed for this recording. Your video and photos are still saved.'
                  : 'No findings were produced from this recording.'}
            </Text>
            {/* Offered only once analysis has stopped: asking to re-run
                something already running would queue a second pass over the
                same recording. */}
            {!item.analysisPending && primaryMediaId ? (
              <Button
                busy={uploadActions.retryProcessing.isPending}
                busyLabel="Starting…"
                className="mt-4"
                icon={<RotateCwIcon size={16} className="text-primary" />}
                label="Run analysis again"
                onPress={() => uploadActions.retryProcessing.mutate(primaryMediaId)}
                variant="ghost"
              />
            ) : null}
            {uploadActions.retryProcessing.error ? (
              <Text className="mt-2 text-xs leading-5 text-muted-foreground">
                {uploadActions.retryProcessing.error.message}
              </Text>
            ) : null}
          </View>
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
            <Button
              accessibilityHint="Records an extra clip without replacing the main walkthrough"
              label="Add Additional Video"
              onPress={() =>
                router.push(`/camera/${inspectionId}/${id}?recordingType=ADDITIONAL_ISSUE`)
              }
              variant="secondary"
            />
          </View>
        ) : null}
        {/* Only while there is nothing to skip.
            Skipping means "this area was not inspected", which is a claim the
            evidence contradicts once a walkthrough has been recorded — and
            offering it there invites a technician to file a recorded area as
            uninspected. Finished areas lose it for the same reason. */}
        {hasRecording || alreadyFinished ? null : (
          // Deliberately the quietest control on the screen: skipping is a
          // claim about the property, not a shortcut, and it should take a
          // moment to find.
          <Button
            accessibilityHint="Asks for a reason, then records this area as not inspected"
            accessibilityLabel="Mark area as skipped"
            className="mx-5 mt-4"
            label="Mark as Skipped"
            onPress={() => setSkipOpen(true)}
            variant="quiet"
          />
        )}
      </ScrollView>

      <View className="absolute bottom-0 left-0 right-0 border-t border-border bg-background px-5 pb-8 pt-3">
        {/* This carried no accessible label of its own, so a screen reader read
            the button's own text — which is right, but only by accident, and it
            said nothing about where the button goes. */}
        <Button
          accessibilityHint="Opens the camera"
          icon={
            hasRecording ? (
              <CameraIcon size={18} className="text-primary-foreground" />
            ) : (
              <PlayCircleIcon size={18} className="text-primary-foreground" />
            )
          }
          label={hasRecording ? 'Record Additional Video' : 'Begin Walkthrough'}
          onPress={() =>
            router.push(
              hasRecording
                ? `/camera/${inspectionId}/${id}?recordingType=ADDITIONAL_ISSUE`
                : `/camera/${inspectionId}/${id}`,
            )
          }
        />
      </View>

      {/* 'alert' so a screen reader reports the context switch instead of
          silently moving focus into a new layer. */}
      {/* Fills the screen rather than sitting in a card: the point is to see
          the photograph, and `contain` keeps the whole frame visible whatever
          shape it was shot in. Tapping anywhere closes it — there is nothing
          else to do here, so a dedicated close button would be one more thing
          to aim at one-handed. */}
      <Modal
        animationType="fade"
        onRequestClose={() => setViewedPhoto(null)}
        transparent
        visible={viewedPhoto !== null}
      >
        <Pressable
          accessibilityHint="Closes the photo"
          accessibilityLabel="Close photo"
          accessibilityRole="button"
          className="flex-1 items-center justify-center bg-black/95"
          onPress={() => setViewedPhoto(null)}
        >
          {viewedPhoto ? (
            <Image
              accessibilityIgnoresInvertColors
              className="h-full w-full"
              resizeMode="contain"
              source={{ uri: viewedPhoto }}
            />
          ) : null}
        </Pressable>
      </Modal>

      <BottomSheet
        accessibilityRole="alert"
        animationType="fade"
        onClose={() => setEditOpen(false)}
        visible={editOpen}
      >
        <Text className="text-xl font-bold text-foreground">Rename this area</Text>
        <Text nativeID="area-name-label" className="mt-2 text-sm leading-5 text-muted-foreground">
          Correct the name you gave this area. The office sees the change straight away.
        </Text>
        <TextInput
          accessibilityLabel="Area name"
          accessibilityLabelledBy="area-name-label"
          autoFocus
          className="mt-4 min-h-12 rounded-xl border border-border bg-card px-4 py-3 text-foreground"
          onChangeText={setEditedName}
          placeholder="Area name"
          placeholderTextColor={theme.mutedForeground}
          value={editedName}
        />
        {updateArea.error ? (
          <Text className="mt-2 text-xs leading-5 text-destructive">
            {updateArea.error.message}
          </Text>
        ) : null}
        <View className="mt-4 flex-row gap-3">
          <Button
            className="flex-1"
            label="Cancel"
            onPress={() => setEditOpen(false)}
            variant="secondary"
          />
          {/* Was `bg-primary/40` when unavailable, which faded the label along
              with the fill. The disabled state is a `muted` surface now, so the
              word "Save" stays readable while clearly reading as inert. */}
          <Button
            accessibilityLabel="Save the area name"
            busy={updateArea.isPending}
            busyLabel="Saving…"
            className="flex-1"
            disabled={!editedName.trim() || editedName.trim() === item.name}
            label="Save"
            onPress={() =>
              updateArea.mutate(
                { name: editedName.trim() },
                { onSuccess: () => setEditOpen(false) },
              )
            }
          />
        </View>
      </BottomSheet>

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
          placeholderTextColor={theme.mutedForeground}
          value={skipReason}
          onChangeText={setSkipReason}
        />
        <View className="mt-4 flex-row gap-3">
          <Button
            className="flex-1"
            label="Cancel"
            onPress={() => setSkipOpen(false)}
            variant="secondary"
          />
          <Button
            accessibilityHint={skipReason.trim() ? undefined : 'Enter a reason before skipping'}
            busy={updates.skip.isPending}
            busyLabel="Saving…"
            className="flex-1"
            disabled={!skipReason.trim()}
            label="Skip Room"
            onPress={() =>
              updates.skip.mutate(skipReason.trim(), {
                onSuccess: () => {
                  setSkipOpen(false);
                  setSkipReason('');
                  goBack();
                },
              })
            }
          />
        </View>
      </BottomSheet>
    </SafeAreaView>
  );
}
