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
import { Badge, type BadgeTone } from '@/src/components/ui';
import { AreaAnalysisCard } from '@/src/areas/AreaAnalysisCard';
import { BaselineCard } from '@/src/areas/BaselineCard';
import { WalkthroughGuideCard } from '@/src/areas/WalkthroughGuideCard';
import { areaStage, deriveAreaStatus, type AreaStatusDescriptor } from '@/src/utils/area-status';
import { goBack } from '@/src/lib/navigation';
import { useAreaChecklist } from '@/src/capture/use-area-checklist';
import { useDemoStore } from '@/src/stores/demo.store';
import { useChecklistFromSummary } from '@/src/capture/useChecklistFromSummary';
import { AreaCompletionChecklist } from '@/src/components/AreaCompletionChecklist';
import { EvidenceRequestCard } from '@/src/components/EvidenceRequestCard';
import { BottomSheet } from '@/src/components/BottomSheet';
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

/**
 * The status ramp this screen shares with the inspection list, expressed as the
 * badge tones the design system actually ships. Mapped rather than renamed:
 * `AreaStatusTone` describes what a state means, `BadgeTone` describes how a
 * pill is drawn, and collapsing the two would put UI vocabulary into a module
 * that is deliberately free of it.
 */
const STATUS_BADGE_TONE: Record<AreaStatusDescriptor['tone'], BadgeTone> = {
  neutral: 'neutral',
  info: 'active',
  progress: 'active',
  success: 'done',
  warning: 'pending',
  danger: 'critical',
};

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
  const updateSnapshot = useDemoStore((state) => state.updateSnapshot);
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
  const [removeOpen, setRemoveOpen] = useState(false);

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
  // The same derivation the inspection list uses, rather than this screen's own
  // reading of `completionStatus`. The hand-rolled tone covered three of six
  // statuses and sent the rest to the amber warning branch, so a skipped or an
  // uploaded area was coloured as a problem.
  const status = deriveAreaStatus(item);
  const stage = areaStage(status.status, hasRecording);
  const alreadyFinished = stage === 'FINISHED';
  // Photographs can exist without a recording — a technician who shot stills
  // and no video still has evidence, and hiding it because there is no video
  // would be telling them nothing was saved.
  const hasEvidence = hasRecording || areaSnapshots.length > 0;
  /**
   * Anything at all recorded against this area, including on the server.
   *
   * Wider than `hasEvidence` above, which asks whether there is something to
   * *show on this screen* and reads local snapshots. This asks whether removal
   * would destroy somebody's work, so it counts the server's own photographs
   * and findings too — and mirrors the refusal `removeArea` applies, so the
   * control is not offered when the request would be refused.
   */
  const hasAnyEvidence =
    hasEvidence || Boolean(photos.data?.length) || roomFindings.length > 0;
  const strandedSnapshots = areaSnapshots.filter(
    (snapshot) => snapshot.uploadStatus !== 'UPLOADED',
  );

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
          {/* `deriveAreaStatus` already returns a cased label, which is also
              what stops a raw `RECORDING_SAVED` reaching the screen when the
              server sends a status outside the union. */}
          <Badge label={status.label} tone={STATUS_BADGE_TONE[status.tone]} />
        </View>

        {/* First thing in the area, above the baseline: an outstanding request
            is the reason the technician is standing here again. */}
        <EvidenceRequestCard
          onResolve={(requestId) => resolveRequest.mutate(requestId)}
          requests={areaRequests}
          resolving={resolveRequest.isPending}
        />

        {/* Before anything is filmed the screen is a briefing: what this room
            was like, and how to walk it. Both drop away once a recording
            exists — a technician returning to a room they had already walked
            was reading four steps of filming instructions above the evidence
            they came back to check. The baseline reappears below the evidence,
            where it is reference rather than preparation. */}
        {stage === 'NOT_FILMED' ? (
          <>
            {item.baseline ? <BaselineCard baseline={item.baseline} /> : null}
            <WalkthroughGuideCard isEquipmentVisit={isEquipmentVisit} />
          </>
        ) : null}

        {/* Only once something has been captured. An empty evidence card above
            a "Begin Walkthrough" button told the technician nothing they could
            not already see, and its own "No recording saved yet" row competed
            with the footer for the same tap. */}
        {hasEvidence ? (
          <View className="mx-5 mt-4 gap-3 rounded-2xl bg-card p-5">
            <View className="flex-row items-center justify-between">
              <Text className="text-base font-semibold text-foreground">Room Evidence</Text>
              {/* Counts both kinds. It read "N saved" off recordings alone, so a
                technician who had taken ten photos and no video was told
                nothing was saved. */}
              <Text className="text-xs text-muted-foreground">
                {recordingCount} video{recordingCount === 1 ? '' : 's'} · {areaSnapshots.length}{' '}
                photo
                {areaSnapshots.length === 1 ? '' : 's'}
              </Text>
            </View>
            <Text className="text-xs leading-relaxed text-muted-foreground">
              Capture one narrated room walkthrough. Snapshots can be taken before or during the
              recording and upload independently.
            </Text>
            {media.data?.length
              ? media.data.map((recording) => {
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
              : null}

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
                {areaSnapshots.map((snapshot) => {
                  const onServer = snapshot.uploadStatus === 'UPLOADED';
                  return (
                    <Pressable
                      accessibilityHint="Opens this photo full screen"
                      // The state belongs in the label, not only in the dot: a
                      // technician using VoiceOver has no other way to learn
                      // that a photograph is still sitting on the handset.
                      accessibilityLabel={`Photo taken ${new Date(snapshot.capturedAt).toLocaleTimeString()}${
                        onServer ? '' : ', not uploaded yet'
                      }`}
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
                      {/* A photograph still on the device looked exactly like
                          one safely on the server, which is how they went
                          unnoticed. */}
                      {onServer ? null : (
                        <View className="absolute right-2 top-1 h-3 w-3 rounded-full border border-background bg-chart-4" />
                      )}
                    </Pressable>
                  );
                })}
              </ScrollView>
            ) : null}

            {/* Automatic retry gives up on a refusal the server will repeat, and
                after enough attempts. Without a way back by hand, those
                photographs would stay on the handset for good. */}
            {strandedSnapshots.length ? (
              <Button
                accessibilityHint="Queues them to send again"
                className="mt-1"
                label={`Retry ${strandedSnapshots.length} photo${strandedSnapshots.length === 1 ? '' : 's'}`}
                onPress={() => {
                  for (const snapshot of strandedSnapshots)
                    updateSnapshot(snapshot.id, {
                      uploadStatus: 'PENDING',
                      attempts: 0,
                      nextAttemptAt: undefined,
                      lastError: undefined,
                    });
                }}
                variant="secondary"
              />
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
        ) : null}

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

        {/* One card for the analysis and its findings. They are the same
            subject at two moments and were never both on screen, so the second
            heading only ever made a reader work out which one applied. Shown
            only with a recording, because there is nothing else to analyse. */}
        {hasRecording ? (
          <AreaAnalysisCard
            analysisPending={item.analysisPending}
            findings={roomFindings}
            onOpenFinding={(findingId) =>
              router.push({
                pathname: '/(app)/findings/[id]',
                params: { id: findingId, inspectionId },
              })
            }
            onRetry={(mediaId) => uploadActions.retryProcessing.mutate(mediaId)}
            primaryMediaId={primaryMediaId}
            processingStatus={item.processingStatus}
            retryError={uploadActions.retryProcessing.error}
            retrying={uploadActions.retryProcessing.isPending}
          />
        ) : null}

        {/* Reference rather than preparation once the room is filmed: this is
            what a technician checks a finding against, so it belongs under the
            evidence rather than above the instructions. */}
        {stage !== 'NOT_FILMED' && item.baseline ? <BaselineCard baseline={item.baseline} /> : null}

        {/* There is no "Mark Complete" here any more.

            Completion is the upload succeeding. The technician already decided
            when they submitted the walkthrough, and a second button afterwards
            could only be forgotten — leaving an area that blocks submission of
            an inspection whose evidence is safely stored. The status line above
            says where the upload has got to instead.

            Adding more video stays available at every stage, including after
            the area completes: noticing something else in a room is normal, and
            an extra clip does not undo the walkthrough. The footer is the one
            place that offers it — a second button here pushed the identical
            route and was pure duplication. */}
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

        {/*
          Removal, for a room the property does not have.

          Distinct from skipping, and the distinction is the point. Skipping
          says "this room exists and was not inspected"; removing says "this is
          not a room here" — which a standard-template layout gets wrong on
          every property that is not a three-bed, and which the technician
          standing in the hall can see and an administrator cannot.

          Offered on the same terms as skipping: only while the area holds
          nothing. The server refuses a removal with evidence anyway, but a
          control that is going to be refused should not be offered — and
          hiding it keeps the two actions from looking interchangeable.
        */}
        {hasAnyEvidence || alreadyFinished ? null : (
          <Button
            accessibilityHint="Asks to confirm, then takes this area off the inspection"
            accessibilityLabel="Remove this area from the inspection"
            className="mx-5 mt-2"
            label="Remove Area"
            onPress={() => setRemoveOpen(true)}
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
        {/*
          A confirmation, not a form.

          This asked for a written reason and refused to proceed without one.
          Field feedback, 2026-09-09: an occupied inspection is walked in about
          fifteen minutes, and the commonest skip — a bedroom the tenant has
          locked, a room in use — is fully described by the fact that it was
          skipped. A required free-text box mid-walkthrough is answered with
          whatever clears it, and "n/a" forty times a week tells an
          administrator less than an empty column, because an empty column does
          not look like an answer.

          The skip is still recorded, and is still a decision with the
          technician's name on it: `completionStatus: SKIPPED` with a
          `completedAt`, which is what the report and the review screen read.
          What is gone is the toll, not the record.
        */}
        <Text className="text-xl font-bold text-foreground">Skip this room?</Text>
        <Text className="mt-2 text-sm leading-5 text-muted-foreground">
          It will be recorded as skipped and counted as finished, so you can submit the inspection
          without it. No photograph or recording is kept for this room.
        </Text>
        <Text className="mt-2 text-sm leading-5 text-muted-foreground">
          You can come back and inspect it while this inspection is still open.
        </Text>
        <View className="mt-5 flex-row gap-3">
          <Button
            className="flex-1"
            label="Cancel"
            onPress={() => setSkipOpen(false)}
            variant="secondary"
          />
          <Button
            busy={updates.skip.isPending}
            busyLabel="Saving…"
            className="flex-1"
            label="Skip Room"
            onPress={() =>
              updates.skip.mutate(undefined, {
                onSuccess: () => {
                  setSkipOpen(false);
                  goBack();
                },
              })
            }
          />
        </View>
      </BottomSheet>

      {/*
        Removal, confirmed rather than justified.

        Deliberately worded to separate it from skipping, which sits two lines
        above it in the same screen: skipping records a room that exists and was
        not inspected, removal says the room is not there. Confusing the two
        would either lose a real room from a report or file an invented one as
        deliberately uninspected.
      */}
      <BottomSheet
        accessibilityRole="alert"
        animationType="fade"
        onClose={() => setRemoveOpen(false)}
        visible={removeOpen}
      >
        <Text className="text-xl font-bold text-foreground">Remove {item.name}?</Text>
        <Text className="mt-2 text-sm leading-5 text-muted-foreground">
          Use this when the property does not have this room. It comes off this inspection and
          stops counting toward finishing it.
        </Text>
        <Text className="mt-2 text-sm leading-5 text-muted-foreground">
          If the room exists but you cannot inspect it, skip it instead — that keeps it on the
          report with your reason.
        </Text>
        {updates.remove.isError ? (
          <Text accessibilityRole="alert" className="mt-3 text-sm text-destructive">
            {updates.remove.error instanceof Error
              ? updates.remove.error.message
              : 'The area could not be removed.'}
          </Text>
        ) : null}
        <View className="mt-5 flex-row gap-3">
          <Button
            className="flex-1"
            label="Cancel"
            onPress={() => setRemoveOpen(false)}
            variant="secondary"
          />
          <Button
            busy={updates.remove.isPending}
            busyLabel="Removing…"
            className="flex-1"
            label="Remove Area"
            onPress={() =>
              updates.remove.mutate(undefined, {
                // Back to the inspection: the screen behind this sheet is about
                // a room that no longer exists.
                onSuccess: () => {
                  setRemoveOpen(false);
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
