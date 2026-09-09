import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CameraView,
  type CameraMode,
  type CameraType,
  useCameraPermissions,
  useMicrophonePermissions,
} from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import {
  CameraIcon,
  FocusIcon,
  ImageIcon,
  ListChecksIcon,
  RotateCcwIcon,
  SquareIcon,
  ZapIcon,
  ZapOffIcon,
} from 'lucide-react-native';
import {
  ActivityIndicator,
  Image,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BackGlyph } from '@/src/components/ui/BackGlyph';
import { PRESS_SURFACE } from '@/src/components/ui';
import { goBack } from '@/src/lib/navigation';
import { HomeButton } from '@/src/components/HomeButton';
import { AreaChecklistSheet } from '@/src/capture/AreaChecklistSheet';
import { checklistProgress } from '@/src/capture/area-checklist';
import { useAreaChecklist } from '@/src/capture/use-area-checklist';
import { GuidedCaptureOverlay } from '@/src/capture/GuidedCaptureOverlay';
import { ShutterFlash } from '@/src/capture/ShutterFlash';
import { StopRecordingSheet } from '@/src/capture/StopRecordingSheet';
import { initialCameraMode, snapshotMode, stopRequestOutcome } from '@/src/capture/capture-intents';
import {
  GUIDED_CAPTURE_POLICY,
  clampRotationDegrees,
  evaluateCapture,
  guidedCaptureState,
  rotationProgress,
  type GuidedCaptureSummary,
} from '@/src/capture/guided-capture';
import { ConditionPromptSheet } from '@/src/capture/ConditionPromptSheet';
import { SweepPromptSheet } from '@/src/capture/SweepPromptSheet';
import { useGuidedCaptureSensor } from '@/src/capture/use-guided-capture';
import type { PhotoCaptureType, RoomSnapshot } from '@/src/domain/models';
import {
  useInspection,
  useInspectionActions,
  useRecordChecklistItem,
  useRoom,
  useRoomChecklist,
} from '@/src/features/queries';
import { inspectionRequiresAreaRecording } from '@texasrenters/shared';
import { announce } from '@/src/lib/announce';
import { buildRecordingDraft, persistRecording } from '@/src/media/local-recordings';
import {
  buildRoomSnapshot,
  deleteRoomSnapshot,
  persistRoomSnapshot,
} from '@/src/media/local-snapshots';
import { extractMarkerStills, pairMarkers } from '@/src/media/marker-stills';
import { pickPictureSize } from '@/src/media/picture-size';
import { PHOTO_REVIEW_WINDOW_MS, reviewWindowEnd } from '@/src/media/snapshot-upload';
import { useDemoStore } from '@/src/stores/demo.store';
import { registerIcons } from '@/src/lib/icons';

registerIcons(
  CameraIcon,
  FocusIcon,
  ImageIcon,
  ListChecksIcon,
  RotateCcwIcon,
  SquareIcon,
  ZapIcon,
  ZapOffIcon,
);

const MAX_RECORDING_SECONDS = 10 * 60;

/**
 * How long to wait for the camera to rebind between stills and video.
 *
 * Only ever waited on when the two differ, which is an occupied visit whose
 * technician has chosen to film. Generous because it is the pause before a
 * recording rather than during one, and bounded because `onCameraReady` firing
 * again after a mode change is the native module's business, not a promise.
 */
const CAMERA_REBIND_TIMEOUT_MS = 1_500;

// A stable empty array: returning a fresh [] from the selector would give
// zustand a new reference every render and loop on "getSnapshot should be
// cached".
const EMPTY_CHECKED: string[] = [];

function formatDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function newCaptureSessionId() {
  return `capture-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export default function RoomCameraScreen() {
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
  /**
   * Put the inspection in progress before any evidence is captured.
   *
   * The backend refuses evidence for an inspection that has not started —
   * `409 INSPECTION_NOT_IN_PROGRESS` — and until now nothing stopped a
   * technician reaching this screen first. Adding an area is allowed while an
   * inspection is still SCHEDULED, and doing so navigates straight here, so the
   * common path was: add a room, film it, and have every upload refused
   * forever. One technician did exactly that and ended up with 162 MB of
   * recordings that could never leave the phone.
   *
   * Started here rather than guarded here because this screen is the choke
   * point every route into capture passes through, and because opening the
   * camera on a room *is* starting the job. Refusing instead would send someone
   * who just added a room back to press a button to be allowed to film it.
   *
   * Idempotent in effect: the mutation only fires for a SCHEDULED inspection,
   * and `startedRef` keeps a re-render from firing it twice while the first
   * request is in flight.
   */
  const inspection = useInspection(inspectionId);
  const inspectionActions = useInspectionActions(inspectionId);
  const startedRef = useRef(false);
  const startInspection = inspectionActions.start;
  useEffect(() => {
    if (inspection.data?.status !== 'SCHEDULED' || startedRef.current) return;
    startedRef.current = true;
    startInspection.mutate(undefined, {
      // Let it retry on the next mount rather than stranding the technician in
      // a screen that silently cannot save what they record.
      onError: () => {
        startedRef.current = false;
      },
    });
  }, [inspection.data?.status, startInspection]);

  const [camera, setCamera] = useState<CameraView | null>(null);
  const secondsRef = useRef(0);
  const mountedRef = useRef(true);
  // 360° walkthrough telemetry. The refs feed the capture summary attached to
  // the recording; none of them drive the visible chrome below.
  const captureSessionIdRef = useRef(newCaptureSessionId());
  const sessionStartedAtRef = useRef(new Date().toISOString());
  const snapshotTypesRef = useRef<PhotoCaptureType[]>([]);
  // Video offsets the technician marked while recording. Turned into photos on
  // this device once recording stops — Android cannot photograph mid-video, and
  // a Stream recording never reaches the backend for server-side extraction.
  const frameMarkersRef = useRef<number[]>([]);
  const guidanceMilestoneRef = useRef(0);
  const previousGuidanceRef = useRef<string | null>(null);
  /**
   * Whether the condition prompt has already been offered for this sweep.
   *
   * The change-guard above dedupes on the raw guidance state, but the branch
   * that opens the prompt accepts COMPLETE *or* LIKELY_COMPLETE. A sweep
   * hovering around the finish oscillates between the two, and each oscillation
   * is a genuine state change landing in the same branch — so the sheet reopened
   * itself moments after the technician dismissed it with "Later", and the
   * completion announcement replayed with it. Latched per sweep instead, and
   * reset when the next recording starts.
   */
  const conditionPromptedRef = useRef(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [microphonePermission, requestMicrophonePermission] = useMicrophonePermissions();
  const [ready, setReady] = useState(false);
  /**
   * Which use case the camera has bound: stills or video, never both.
   *
   * This screen hard-coded `video`, so the image-capture use case was never
   * bound and a technician who had not started recording could not photograph
   * at all — on Android `takePictureAsync` has nothing to shoot with. It read
   * as a rule ("film before you can photograph") and was a default nobody had
   * revisited.
   *
   * An occupied visit therefore opens on `picture`, because it is often only
   * photographs; every other visit opens on `video`, which is what its
   * technician does first. `bindCamera` moves between them.
   */
  const requiresRecording = inspectionRequiresAreaRecording(room.data?.inspectionType);
  const [cameraMode, setCameraMode] = useState<CameraMode>(() =>
    initialCameraMode(requiresRecording),
  );
  // Read inside async work, where the state value would be the one captured
  // when the callback was created.
  const cameraModeRef = useRef(cameraMode);
  /**
   * Resolvers waiting for the camera to finish re-configuring.
   *
   * Changing `mode` rebinds the use case, and `recordAsync` on a camera still
   * bound to stills fails. `onCameraReady` fires again once the new binding is
   * live, which is the only signal available that it is safe to proceed.
   */
  const readyWaiters = useRef<(() => void)[]>([]);
  /**
   * Which of the camera's offered sizes stills are captured at.
   *
   * Undefined until the camera is mounted and has answered, and undefined for
   * good on a device that reports presets by name rather than by resolution.
   * Both leave the prop unset and the device at its default, which is what this
   * screen did before any of this existed.
   */
  const [pictureSize, setPictureSize] = useState<string | undefined>(undefined);
  const [recording, setRecording] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [torch, setTorch] = useState(false);
  const [facing, setFacing] = useState<CameraType>('back');
  const [captureType, setCaptureType] = useState<PhotoCaptureType>('AREA_OVERVIEW');
  const [photoCount, setPhotoCount] = useState(0);
  /** The shot just taken, while it is still held from upload. */
  const [discardable, setDiscardable] = useState<RoomSnapshot | null>(null);
  const discardTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [capturingPhoto, setCapturingPhoto] = useState(false);
  // A count, not a flag: two shutter taps in a row have to be distinguishable
  // or the second renders the same value and nothing flashes.
  const [flashTrigger, setFlashTrigger] = useState(0);
  const [checklistOpen, setChecklistOpen] = useState(false);
  const [conditionOpen, setConditionOpen] = useState(false);
  const [sweepPromptOpen, setSweepPromptOpen] = useState(false);
  const [confirmStopOpen, setConfirmStopOpen] = useState(false);

  /**
   * Authored items only, straight from `useRoomChecklist`.
   *
   * `useAreaChecklist` falls back to a *generated* list for areas nobody has
   * configured, and those synthetic ids do not exist on the server — scoring
   * one would 404. Only authored items can be assessed, so only those are asked.
   */
  const conditionItems = useRoomChecklist(areaId);
  const recordCondition = useRecordChecklistItem(areaId);
  const conditionAssessments = useMemo(
    () => new Map((conditionItems.data ?? []).map((item) => [item.id, item])),
    [conditionItems.data],
  );
  const [error, setError] = useState<string | null>(null);
  const setDraft = useDemoStore((state) => state.setDraftRecording);
  const addSnapshot = useDemoStore((state) => state.addSnapshot);
  const removeSnapshots = useDemoStore((state) => state.removeSnapshots);
  const ownerUserId = useDemoStore((state) => state.selectedUserId ?? undefined);
  // Persisted per area rather than held on this screen: coverage used to be
  // component state, so stepping out to review a recording and coming back lost
  // every tick the technician had made.
  const checkedItems = useDemoStore((state) => state.areaChecklist[areaId]) ?? EMPTY_CHECKED;
  const toggleChecklistItem = useDemoStore((state) => state.toggleChecklistItem);
  const isAdditional = recordingType === 'ADDITIONAL_ISSUE';
  /**
   * No rotation target on this capture.
   *
   * Two different reasons land here. An additional-issue clip is a close-up of
   * one defect, and an HVAC visit is filmed standing at a unit — neither is a
   * lap of the room, and asking for 360° of rotation to finish either one is a
   * gate the technician cannot honestly satisfy.
   */
  const skipsRoomSweep = isAdditional || room.data?.inspectionType === 'HVAC';
  const hasPermissions = Boolean(cameraPermission?.granted && microphonePermission?.granted);
  const guidedSensor = useGuidedCaptureSensor(recording && !skipsRoomSweep);
  const checklist = useAreaChecklist(areaId, {
    name: room.data?.name,
    environment: room.data?.environment,
    // Was dropped on the way in, so the device-side fallback ignored the
    // category an administrator had set and could disagree with the
    // server-generated list for the same area.
    category: room.data?.category,
    inspectionType: room.data?.inspectionType,
  });
  const checklistCoverage = checklistProgress(checklist, checkedItems);
  const guidanceState = guidedCaptureState({
    tracker: guidedSensor.tracker,
    recording,
    sensorSupported: guidedSensor.supported,
    durationSeconds: seconds,
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      camera?.stopRecording();
    };
  }, [camera]);

  /**
   * Ask the camera what sizes it offers, once it is mounted and ready.
   *
   * Never fatal. A device that refuses the question, or answers with presets
   * this cannot read, keeps its default capture size — a photograph that is
   * larger than we wanted is worth far more than one that was never taken.
   */
  useEffect(() => {
    if (!camera || !ready) return;
    let cancelled = false;
    void camera
      .getAvailablePictureSizesAsync()
      .then((sizes) => {
        if (!cancelled && mountedRef.current) setPictureSize(pickPictureSize(sizes));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [camera, ready]);

  // Haptic tick at each quarter of the clockwise loop, heavy at completion —
  // progress a technician can feel without looking away from the room.
  useEffect(() => {
    if (!recording || skipsRoomSweep || !guidedSensor.supported) return;
    const milestone =
      [100, 75, 50, 25].find(
        (value) => Math.round(rotationProgress(guidedSensor.tracker) * 100) >= value,
      ) ?? 0;
    if (milestone <= guidanceMilestoneRef.current) return;
    guidanceMilestoneRef.current = milestone;
    void Haptics.impactAsync(
      milestone >= 100 ? Haptics.ImpactFeedbackStyle.Heavy : Haptics.ImpactFeedbackStyle.Light,
    ).catch(() => undefined);
  }, [guidedSensor.supported, guidedSensor.tracker, recording, skipsRoomSweep]);

  // Spoken guidance on state *changes* only, so a screen reader hears the
  // correction once rather than on every sensor sample.
  useEffect(() => {
    if (!recording || skipsRoomSweep || previousGuidanceRef.current === guidanceState) return;
    previousGuidanceRef.current = guidanceState;
    if (guidanceState === 'WRONG_DIRECTION') {
      announce('Turn the other way and continue clockwise.');
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(
        () => undefined,
      );
    } else if (guidanceState === 'TOO_FAST') {
      announce('Slow down for a clear room walkthrough.');
    } else if (guidanceState === 'RETURN_TO_START') {
      announce('Return to Wall 1 to complete the walkthrough.');
    } else if (guidanceState === 'COMPLETE' || guidanceState === 'LIKELY_COMPLETE') {
      // Both states, not COMPLETE alone. A sweep that reaches 92% and returns
      // to the start settles on LIKELY_COMPLETE and never advances, so gating
      // on COMPLETE left the prompt unopened for a large share of real
      // walkthroughs — the room had been filmed and nothing happened.
      //
      // The sensor confirming the sweep is the cue to move on: the next thing
      // is assessing what was just filmed, while the technician is still
      // standing in it. Only prompted when there is something to ask — an
      // unconfigured area would open an empty sheet.
      // Once per sweep. Dismissing the prompt is a decision the technician is
      // allowed to make and have stick — they may want to film a detail before
      // answering — and the checklist button reopens it whenever they choose.
      if (conditionPromptedRef.current) return;
      conditionPromptedRef.current = true;
      announce('Walkthrough complete. Start the detailed checklist.');
      if (conditionItems.data?.length) setConditionOpen(true);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
        () => undefined,
      );
    }
  }, [conditionItems.data, guidanceState, recording, skipsRoomSweep]);

  // A new recording is a new sweep, so the prompt is owed again.
  useEffect(() => {
    if (recording) conditionPromptedRef.current = false;
  }, [recording]);

  useEffect(() => {
    if (!recording || stopping) return;
    const timer = setInterval(() => {
      secondsRef.current += 1;
      setSeconds(secondsRef.current);
    }, 1000);
    return () => clearInterval(timer);
  }, [recording, stopping]);

  const requestPermissions = async () => {
    const cameraResult = cameraPermission?.granted
      ? cameraPermission
      : await requestCameraPermission();
    const microphoneResult = microphonePermission?.granted
      ? microphonePermission
      : await requestMicrophonePermission();
    if (!cameraResult.granted || !microphoneResult.granted) {
      setError('Camera and microphone access are required to record room evidence.');
      return false;
    }
    return true;
  };

  const createCaptureSummary = (durationSeconds: number): GuidedCaptureSummary | undefined => {
    if (skipsRoomSweep) return undefined;
    const evaluation = evaluateCapture({
      tracker: guidedSensor.trackerRef.current,
      durationSeconds,
      sensorSupported: guidedSensor.supported,
    });
    const hasOverview = snapshotTypesRef.current.includes('AREA_OVERVIEW');
    return {
      sessionId: captureSessionIdRef.current,
      policyVersion: GUIDED_CAPTURE_POLICY.version,
      startedAt: sessionStartedAtRef.current,
      completedAt: new Date().toISOString(),
      durationSeconds,
      // Clamped to the upload contract's ceiling. The tracker accumulates every
      // accepted degree of turn without bound, so a technician who circles the
      // room more than twice — or backtracks a lot — produced a value the API
      // rejects outright, failing the whole upload after the video had already
      // been sent. Coverage is judged against 330–420 degrees, so anything past
      // two full turns carries no further meaning anyway.
      clockwiseRotationDegrees: clampRotationDegrees(
        guidedSensor.trackerRef.current.clockwiseRotationDegrees,
      ),
      counterClockwiseRotationDegrees: clampRotationDegrees(
        guidedSensor.trackerRef.current.counterClockwiseRotationDegrees,
      ),
      startHeadingDegrees: guidedSensor.trackerRef.current.startHeadingDegrees,
      endHeadingDegrees: guidedSensor.trackerRef.current.endHeadingDegrees,
      returnedToStart: evaluation.returnedToStart,
      sensorSupported: guidedSensor.supported,
      sensorConfidence: evaluation.confidence,
      coverageStatus: evaluation.status,
      manualConfirmation: false,
      evidenceComplete: hasOverview,
      snapshotCount: snapshotTypesRef.current.length,
      findingMarkerCount: 0,
    };
  };

  /** The camera has finished configuring — release anything waiting on it. */
  const markCameraReady = () => {
    setReady(true);
    const waiting = readyWaiters.current;
    readyWaiters.current = [];
    for (const resolve of waiting) resolve();
  };

  /**
   * Rebinds the camera to `next`, resolving once it reports ready again.
   *
   * Returns immediately when it is already bound that way, so a visit that
   * opens on `video` — every kind but occupied — reaches `recordAsync` by
   * exactly the path it did before, with no wait and no new failure mode.
   *
   * On timeout it resolves anyway rather than refusing. Whether
   * `onCameraReady` fires a second time after a mode change is a detail of the
   * native module, and betting a technician's ability to record on it would
   * turn a missing callback into "the record button does nothing". Proceeding
   * is no worse than before: if the binding really has not applied,
   * `recordAsync` reports it through the error path that already exists.
   */
  const bindCamera = (next: CameraMode) =>
    new Promise<void>((resolve) => {
      if (cameraModeRef.current === next) return resolve();
      cameraModeRef.current = next;
      setReady(false);
      setCameraMode(next);
      const timer = setTimeout(resolve, CAMERA_REBIND_TIMEOUT_MS);
      readyWaiters.current.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });

  const beginRecording = async () => {
    if (!(await requestPermissions())) return;
    if (!camera || !ready || recording) return;
    setError(null);
    // Stills and video are separate bindings, so a screen that opened ready to
    // photograph has to become a video camera before it can record.
    await bindCamera('video');
    if (!mountedRef.current) return;
    secondsRef.current = 0;
    setSeconds(0);
    sessionStartedAtRef.current = new Date().toISOString();
    guidanceMilestoneRef.current = 0;
    frameMarkersRef.current = [];
    previousGuidanceRef.current = null;

    if (!skipsRoomSweep) {
      guidedSensor.reset();
      // Prompts, but nothing here waits on the answer or on a capability
      // check — the hook reports guidance as unavailable only if the sensor
      // actually sends nothing. See use-guided-capture.
      await guidedSensor.requestAccess();
    }

    setRecording(true);
    // The first instruction of the area: film the room before assessing it.
    // Only for the primary walkthrough — an additional clip is a follow-up on
    // something already found and has no sweep to perform.
    if (!skipsRoomSweep) setSweepPromptOpen(true);
    setStopping(false);
    announce(
      isAdditional
        ? 'Additional evidence recording started.'
        : skipsRoomSweep
          ? 'Recording started.'
          : 'Wall 1 registered. Begin one slow clockwise walkthrough.',
    );
    try {
      const result = await camera.recordAsync({
        maxDuration: MAX_RECORDING_SECONDS,
        ...(Platform.OS === 'ios' ? { codec: 'avc1' as const } : {}),
      });
      if (!result || !mountedRef.current) return;
      const stored = persistRecording(result.uri, inspectionId, areaId);

      // Turn the moments marked during the walkthrough into real photos.
      //
      // Only Android reaches this with markers pending: iOS took a native still
      // at each one already. The server used to cut these frames with ffmpeg,
      // but a Cloudflare Stream recording never reaches the backend, so doing it
      // here is what keeps the two platforms producing the same evidence.
      //
      // Runs now, while the file is still on the device — after cleanup the
      // frames are unrecoverable. Failures are reported, never fatal: a frame
      // that will not decode must not cost a finished walkthrough.
      if (frameMarkersRef.current.length) {
        const { stills, failures } = await extractMarkerStills(
          stored.uri,
          pairMarkers(frameMarkersRef.current, snapshotTypesRef.current),
        );
        for (const [index, still] of stills.entries()) {
          const persisted = persistRoomSnapshot(still.uri, inspectionId, areaId);
          addSnapshot(
            buildRoomSnapshot({
              ownerUserId,
              inspectionId,
              roomId: areaId,
              uri: persisted.uri,
              width: still.width,
              height: still.height,
              sizeBytes: persisted.sizeBytes,
              captureType: still.captureType,
              recordingSessionId: captureSessionIdRef.current,
              videoTimestampMs: still.videoTimestampMs,
              captureSource: 'VIDEO_FRAME_EXTRACTION',
              sequenceNumber: photoCount + index + 1,
            }),
          );
        }
        if (failures.length)
          announce(
            `${failures.length} marked moment${failures.length === 1 ? '' : 's'} could not be saved as a photo. The recording is unaffected.`,
          );
      }
      setDraft(
        buildRecordingDraft({
          ownerUserId,
          inspectionId,
          roomId: areaId,
          uri: stored.uri,
          durationSeconds: Math.max(1, secondsRef.current),
          sizeBytes: stored.sizeBytes,
          recordingType: isAdditional ? 'ADDITIONAL_ISSUE' : 'PRIMARY_AREA',
          frameMarkersMs: frameMarkersRef.current,
          // The same id every snapshot in this take carries, so review can find
          // them again — discarding a walkthrough has to take its photographs
          // with it, and they are already uploaded by then.
          recordingSessionId: captureSessionIdRef.current,
          // Rotation coverage travels with the recording so the backend can
          // judge walkthrough completeness alongside the video itself.
          captureSummary: createCaptureSummary(Math.max(1, secondsRef.current)),
        }),
      );
      router.replace({
        pathname: '/(app)/recording-review/[inspectionId]/[areaId]',
        params: { inspectionId, areaId },
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The video could not be recorded.');
      /**
       * Give the shutter back.
       *
       * The success path leaves through `router.replace`, so the screen is
       * gone and the next one opens bound correctly. A failure keeps the
       * technician here — on a camera now bound to video, unable to photograph
       * the room they came to photograph. That would turn one failed recording
       * into an area they cannot finish at all.
       */
      if (mountedRef.current) void bindCamera(initialCameraMode(requiresRecording));
    } finally {
      if (mountedRef.current) {
        setRecording(false);
        setStopping(false);
      }
    }
  };

  const stopRecording = () => {
    if (!recording || stopping) return;
    setStopping(true);
    announce('Recording stopped. Saving.');
    camera?.stopRecording();
  };

  /**
   * Both stop controls route through here, so neither ends a take outright.
   *
   * A walkthrough cannot be resumed — stopping closes the recording and moves
   * on to review — and the header arrow that doubles as stop sits exactly where
   * a thumb reaches to go back. The second tap costs a second; refilming a room
   * costs the visit.
   */
  const requestStopRecording = () => {
    if (stopRequestOutcome({ recording, stopping }) === 'ignore') return;
    setConfirmStopOpen(true);
  };

  /**
   * There is no send-from-here any more.
   *
   * This screen used to fire the upload itself as a head start. It cannot now:
   * a photograph is held for the review window so a test shot can be discarded
   * before it leaves the device, and `UploadQueueRunner` is what sends it once
   * it comes due. Sending from two places would defeat the hold from one of
   * them.
   */

  /**
   * Offers the shot just taken back, for as long as it is held from upload.
   *
   * A second photograph replaces the offer rather than stacking one. The
   * control is about the shot in front of the technician; anything older is the
   * area screen's business, and a growing row of thumbnails over a live camera
   * is the opposite of what a fifteen-minute visit needs.
   */
  const showDiscardable = (snapshot: RoomSnapshot) => {
    if (discardTimer.current) clearTimeout(discardTimer.current);
    setDiscardable(snapshot);
    discardTimer.current = setTimeout(() => {
      // Only clears the offer. The photograph is already in the store and the
      // queue sends it the moment it comes due, whether this screen is still
      // open or not.
      if (mountedRef.current) setDiscardable(null);
    }, PHOTO_REVIEW_WINDOW_MS);
  };

  /**
   * Throws the held photograph away, before anything has been sent.
   *
   * Local in every sense: the row leaves the store and the JPEG leaves the
   * device. Nothing has reached the server yet — which is the point of holding
   * it — so there is nothing to un-send and no round trip to wait on.
   *
   * The counters go back too. `photoCount` drives the capture summary attached
   * to the recording, and `snapshotTypesRef` feeds `evidenceComplete`; leaving
   * either would tell the reviewer about a photograph that does not exist.
   */
  const discardPhoto = () => {
    const snapshot = discardable;
    if (!snapshot) return;
    if (discardTimer.current) clearTimeout(discardTimer.current);
    setDiscardable(null);
    removeSnapshots([snapshot.id]);
    deleteRoomSnapshot(snapshot.uri);
    setPhotoCount((count) => Math.max(0, count - 1));
    const types = snapshotTypesRef.current;
    const last = types.lastIndexOf(snapshot.captureType ?? 'AREA_OVERVIEW');
    if (last >= 0) types.splice(last, 1);
    announce('Photo discarded.');
  };

  const takeSnapshot = async () => {
    if (!camera || !ready || !hasPermissions || capturingPhoto) return;

    // Everything the technician perceives when the shutter fires, shared by
    // both capture modes. It used to hang off the still path alone, so on
    // Android mid-recording — where no still is possible — a tap produced a
    // haptic and nothing else.
    const confirmCapture = (announcement: string) => {
      setFlashTrigger((count) => count + 1);
      void Haptics.selectionAsync().catch(() => undefined);
      announce(announcement);
    };

    if (snapshotMode(Platform.OS, recording) === 'marker') {
      // Android cannot photograph mid-recording: expo-camera binds either the
      // image-capture or the video-capture use case, never both, so
      // takePictureAsync has nothing to shoot with while a video is running.
      // Rather than making the technician stop the walkthrough — the one thing
      // a continuous 360° capture must not do — the shutter records the moment
      // and extractMarkerStills cuts that frame out of the finished video.
      const atMs = secondsRef.current * 1000;
      frameMarkersRef.current = [...frameMarkersRef.current, atMs];
      snapshotTypesRef.current.push(captureType);
      setPhotoCount((count) => count + 1);
      if (captureType === 'AREA_OVERVIEW') setCaptureType('FINDING_CONTEXT');
      confirmCapture(`Moment marked at ${formatDuration(secondsRef.current)}. Keep recording.`);
      return;
    }
    setCapturingPhoto(true);
    setError(null);
    try {
      const photo = await camera.takePictureAsync({
        quality: 0.82,
        shutterSound: false,
      });
      const stored = persistRoomSnapshot(photo.uri, inspectionId, areaId);
      const snapshot = buildRoomSnapshot({
        ownerUserId,
        inspectionId,
        roomId: areaId,
        uri: stored.uri,
        width: photo.width,
        height: photo.height,
        sizeBytes: stored.sizeBytes,
        captureType,
        recordingSessionId: captureSessionIdRef.current,
        videoTimestampMs: recording ? secondsRef.current * 1000 : undefined,
        captureSource:
          recording && Platform.OS === 'ios'
            ? 'NATIVE_STILL_DURING_VIDEO'
            : 'SEPARATE_PHOTO_CAPTURE',
        sequenceNumber: photoCount + 1,
        /**
         * Not due to send yet.
         *
         * The shutter and the upload used to be the same act, so a test shot —
         * checking the light, checking the lens — was filed as evidence before
         * the technician had looked at it. `snapshotsAwaitingUpload` already
         * skips anything not yet due, so the hold needs no new state and the
         * queue needs no new rule.
         */
        nextAttemptAt: reviewWindowEnd(),
      });
      addSnapshot(snapshot);
      // Offer it back for as long as it is held. A second photograph replaces
      // the offer rather than stacking one: the control is about the shot just
      // taken, and anything older belongs to the area screen.
      showDiscardable(snapshot);
      // Feeds evidenceComplete/snapshotCount in the capture summary.
      snapshotTypesRef.current.push(captureType);
      setPhotoCount((count) => count + 1);
      // Capturing an overview advances the selector to finding context.
      const advancedToFindingContext = captureType === 'AREA_OVERVIEW';
      if (advancedToFindingContext) setCaptureType('FINDING_CONTEXT');
      // Haptics alone do not say *what* happened, and the shutter is muted so
      // it never lands on the inspection audio. Announce the count, and the new
      // selection when it just changed underneath the technician.
      confirmCapture(
        `Photo ${photoCount + 1} saved.${
          advancedToFindingContext ? ' Next snapshot: finding context.' : ''
        }`,
      );
      /**
       * Deliberately not uploaded here.
       *
       * `UploadQueueRunner` picks it up once the review window passes, which is
       * what makes the discard control mean anything — sending it now and
       * deleting it afterwards would put a test shot on the server and take a
       * round trip to remove it.
       */
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The snapshot could not be saved.');
    } finally {
      setCapturingPhoto(false);
    }
  };

  if (!hasPermissions) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-black px-8">
        <CameraIcon size={44} className="text-white" />
        <Text className="mt-5 text-xl font-bold text-white">Camera access required</Text>
        <Text className="mt-2 text-center text-sm leading-6 text-white/70">
          Allow camera and microphone access to capture this room with narration.
        </Text>
        {error ? (
          <Text accessibilityRole="alert" className="mt-3 text-center text-sm text-red-300">
            {error}
          </Text>
        ) : null}
        <Pressable
          accessibilityRole="button"
          className="mt-6 min-h-12 rounded-xl bg-primary px-6 py-4"
          onPress={() =>
            cameraPermission?.canAskAgain === false || microphonePermission?.canAskAgain === false
              ? void Linking.openSettings()
              : void requestPermissions()
          }
        >
          <Text className="font-bold text-primary-foreground">
            {cameraPermission?.canAskAgain === false || microphonePermission?.canAskAgain === false
              ? 'Open device settings'
              : 'Enable camera & microphone'}
          </Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  return (
    <View className="flex-1 bg-black">
      <StatusBar style="light" />
      <CameraView
        ref={setCamera}
        style={StyleSheet.absoluteFill}
        facing={facing}
        enableTorch={torch && facing === 'back'}
        mode={cameraMode}
        mute={false}
        videoQuality="720p"
        /**
         * Capture at roughly 2048 on the long edge, not at the sensor's full
         * twelve megapixels. Undefined until the camera has told us what it
         * offers, and undefined for ever on a device whose sizes we cannot
         * read — both of which leave the prop unset, which is the behaviour
         * this screen had before.
         */
        pictureSize={pictureSize}
        onCameraReady={markCameraReady}
        onMountError={(event) => setError(event.message)}
      />
      <View className="absolute inset-x-0 top-0 h-44 bg-black/45" />
      <View className="absolute inset-x-0 bottom-0 h-64 bg-black/60" />
      <View
        style={{ ...StyleSheet.absoluteFillObject, pointerEvents: 'none' }}
        // Padded rather than centred on the whole screen. The chrome is not
        // symmetrical — the control stack is far taller than the header — so a
        // true centre put the framing grid underneath the bottom overlay, with
        // its corner running through the shutter row. Centring inside the
        // padded band keeps the guides over live picture only.
        className="items-center justify-center pb-60 pt-36"
      >
        <View className="h-[42%] w-[84%] rounded-3xl border border-white/30">
          <View className="absolute left-1/3 top-0 h-full w-px bg-white/15" />
          <View className="absolute right-1/3 top-0 h-full w-px bg-white/15" />
          <View className="absolute left-0 top-1/3 h-px w-full bg-white/15" />
          <View className="absolute bottom-1/3 left-0 h-px w-full bg-white/15" />
        </View>
      </View>
      <SafeAreaView edges={['top', 'bottom']} className="flex-1 justify-between">
        {/* Top group: identity first, then live coaching directly beneath it.
            Guidance used to sit at the bottom among the controls, where the one
            thing a technician reads while turning was furthest from their eye
            line and competing with the shutter row. */}
        <View>
          <View className="flex-row items-center gap-3 px-5 py-3">
            <Pressable
              // While recording this button ends the take rather than leaving, so
              // the label must not say "Back" — that would read as discarding. It
              // asks before ending anything; see requestStopRecording.
              accessibilityLabel={recording ? 'Stop recording' : 'Back to area'}
              accessibilityRole="button"
              className="h-10 w-10 items-center justify-center rounded-full bg-black/40"
              // 40pt visual, 44pt target: hitSlop keeps the design and still
              // clears the minimum for a gloved or unsteady hand.
              hitSlop={8}
              onPress={() => (recording ? requestStopRecording() : goBack())}
            >
              <BackGlyph size={21} className="text-white" />
            </Pressable>
            <View className="min-w-0 flex-1">
              <Text numberOfLines={1} className="text-xl font-bold text-white">
                {room.data?.name ?? 'Room'}
              </Text>
              <Text className="text-xs text-white/70">
                {isAdditional ? 'Additional evidence clip' : 'Primary room walkthrough'}
              </Text>
            </View>
            {/* Hidden mid-take: a technician one turn into a walkthrough must not
              lose it to a mistap, and the back control already doubles as stop
              while recording. */}
            {recording ? null : <HomeButton tone="overlay" />}
            <Pressable
              accessibilityLabel="Flashlight"
              accessibilityRole="switch"
              accessibilityState={{ checked: torch, disabled: facing !== 'back' }}
              className="h-10 w-10 items-center justify-center rounded-full bg-black/40"
              hitSlop={8}
              onPress={() => setTorch((value) => !value)}
            >
              {torch ? (
                <ZapIcon size={20} className="text-white" />
              ) : (
                <ZapOffIcon size={20} className="text-white" />
              )}
            </Pressable>
            <Pressable
              accessibilityLabel={
                facing === 'back' ? 'Switch to front camera' : 'Switch to rear camera'
              }
              accessibilityRole="button"
              className="h-10 w-10 items-center justify-center rounded-full bg-black/40"
              hitSlop={8}
              onPress={() => setFacing((value) => (value === 'back' ? 'front' : 'back'))}
            >
              <RotateCcwIcon size={20} className="text-white" />
            </Pressable>
          </View>

          {/* Live 360° guidance. Only while recording a primary walkthrough, so
              the idle screen keeps its uncluttered layout; additional evidence
              clips are free-form and get no rotation coaching.

              `pt-7` drops it clear of the header: flush against the room name
              the banner read as part of the title bar, and sat high enough to
              crowd the status bar. */}
          {recording && !skipsRoomSweep ? (
            <View className="px-5 pt-7" pointerEvents="none">
              <GuidedCaptureOverlay state={guidanceState} tracker={guidedSensor.tracker} />
            </View>
          ) : null}
        </View>

        <View className="items-center px-5 pb-4">
          {/* Elapsed time is the only signal that recording is actually running.
              Kept below the guidance banner: the coaching is what changes
              moment to moment, the clock is reassurance. */}
          <View
            accessibilityLabel={
              recording ? `Recording, ${formatDuration(seconds)} elapsed` : 'Ready to record'
            }
            accessibilityRole="timer"
            className="mb-6 rounded-full bg-black/65 px-5 py-2"
          >
            <Text className="text-lg font-bold text-white">
              {formatDuration(seconds)} {recording ? 'REC' : 'READY'}
            </Text>
          </View>
          <View className="mb-6 w-full">
            <View className="mb-2.5 flex-row items-end justify-between">
              <View>
                <Text className="text-[10px] font-bold uppercase tracking-[2px] text-white/60">
                  Next snapshot
                </Text>
                <Text className="mt-0.5 text-sm font-bold text-white">
                  {captureType === 'AREA_OVERVIEW' ? 'Area overview' : 'Finding context'}
                </Text>
              </View>
              <Text className="text-xs text-white/60">
                {photoCount} photo{photoCount === 1 ? '' : 's'}
              </Text>
            </View>
            {/* Two mutually exclusive choices, so radio rather than button:
                it tells the technician one is already selected instead of
                reading them as two independent actions. */}
            <View accessibilityRole="radiogroup" className="flex-row gap-2">
              <Pressable
                accessibilityLabel="Next snapshot: area overview"
                accessibilityRole="radio"
                accessibilityState={{ selected: captureType === 'AREA_OVERVIEW' }}
                className={`min-h-11 flex-1 flex-row items-center justify-center gap-2 rounded-xl px-3 py-2.5 ${
                  captureType === 'AREA_OVERVIEW'
                    ? 'bg-white'
                    : 'border border-white/25 bg-black/30'
                }`}
                onPress={() => setCaptureType('AREA_OVERVIEW')}
              >
                <ImageIcon
                  size={15}
                  className={captureType === 'AREA_OVERVIEW' ? 'text-black' : 'text-white'}
                />
                <Text
                  className={`text-xs font-bold ${
                    captureType === 'AREA_OVERVIEW' ? 'text-black' : 'text-white'
                  }`}
                >
                  Area overview
                </Text>
              </Pressable>
              <Pressable
                accessibilityLabel="Next snapshot: finding context"
                accessibilityRole="radio"
                accessibilityState={{ selected: captureType === 'FINDING_CONTEXT' }}
                className={`min-h-11 flex-1 flex-row items-center justify-center gap-2 rounded-xl px-3 py-2.5 ${
                  captureType === 'FINDING_CONTEXT'
                    ? 'bg-white'
                    : 'border border-white/25 bg-black/30'
                }`}
                onPress={() => setCaptureType('FINDING_CONTEXT')}
              >
                <FocusIcon
                  size={15}
                  className={captureType === 'FINDING_CONTEXT' ? 'text-black' : 'text-white'}
                />
                <Text
                  className={`text-xs font-bold ${
                    captureType === 'FINDING_CONTEXT' ? 'text-black' : 'text-white'
                  }`}
                >
                  Finding context
                </Text>
              </Pressable>
            </View>
          </View>
          {error ? (
            <View
              accessibilityLiveRegion="assertive"
              accessibilityRole="alert"
              className="mb-5 w-full rounded-xl bg-red-950/80 px-4 py-3"
            >
              <Text className="text-center text-xs text-red-100">{error}</Text>
            </View>
          ) : null}
          {/* One row for the three actions, each with its own caption beneath.
              Previously the shutter shared a row with a bare photo tally while
              the record button sat alone underneath — two stacked rows that
              read as unrelated groups and pushed the controls into the framing
              grid. Equal thirds keep record optically centred whatever the side
              captions say. */}
          {/*
            The shot just taken, while it is still held from upload.
            
            Above the controls rather than beside them: it is a transient offer,
            and putting it in the row would move the shutter every time a
            photograph is taken. Absent once the photograph is committed, which
            is also the only signal that it has been.
          */}
          {discardable ? (
            <View className="mb-3 w-full flex-row items-center gap-3 rounded-xl bg-black/55 p-2">
              <Image
                accessibilityIgnoresInvertColors
                className="h-12 w-12 rounded-lg"
                resizeMode="cover"
                source={{ uri: discardable.uri }}
              />
              <Text className="min-w-0 flex-1 text-xs leading-4 text-white/85">
                Saved. Not sent yet — discard it if that was a test shot.
              </Text>
              <Pressable
                accessibilityHint="Deletes it from this device. Nothing has been sent."
                accessibilityLabel="Discard the photo just taken"
                accessibilityRole="button"
                className={`min-h-11 justify-center rounded-lg border border-white/40 px-3 ${PRESS_SURFACE}`}
                onPress={discardPhoto}
              >
                <Text className="text-xs font-semibold text-white">Discard</Text>
              </Pressable>
            </View>
          ) : null}

          <View className="w-full flex-row items-start justify-between">
            <View className="flex-1 items-center">
              <Pressable
                accessibilityHint={
                  captureType === 'AREA_OVERVIEW'
                    ? 'Captures a wide shot of the area'
                    : 'Captures a close-up for a finding'
                }
                accessibilityLabel={capturingPhoto ? 'Saving photo' : 'Take photo'}
                accessibilityRole="button"
                accessibilityState={{ busy: capturingPhoto, disabled: !ready || capturingPhoto }}
                className={`h-14 w-14 items-center justify-center rounded-full border-2 border-white/80 bg-white/10 ${PRESS_SURFACE}`}
                onPress={() => void takeSnapshot()}
                disabled={!ready || capturingPhoto}
              >
                {capturingPhoto ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <CameraIcon size={24} className="text-white" />
                )}
              </Pressable>
              {/* One accessible node, or VoiceOver reads the count and the word
                  "photos" as two separate stops. */}
              <Text
                accessible
                accessibilityLabel={`${photoCount} photo${photoCount === 1 ? '' : 's'} captured`}
                className="mt-2 text-xs font-medium text-white/70"
              >
                {photoCount} photo{photoCount === 1 ? '' : 's'}
              </Text>
            </View>

            <View className="flex-1 items-center">
              <Pressable
                accessibilityHint={
                  recording ? 'Ends the take and opens the review screen' : undefined
                }
                accessibilityLabel={
                  stopping ? 'Saving recording' : recording ? 'Stop recording' : 'Start recording'
                }
                accessibilityRole="button"
                accessibilityState={{ busy: stopping, disabled: !ready || stopping }}
                className="h-[72px] w-[72px] items-center justify-center rounded-full border-4 border-white bg-red-500"
                disabled={!ready || stopping}
                onPress={recording ? requestStopRecording : () => void beginRecording()}
              >
                {recording ? (
                  <SquareIcon size={26} className="text-white" />
                ) : (
                  <View className="h-14 w-14 rounded-full bg-red-500" />
                )}
              </Pressable>
              {/* importantForAccessibility="no": the button above already says
                  this, and leaving it focusable makes the technician swipe past
                  a duplicate of the control they just heard. */}
              <Text
                importantForAccessibility="no"
                className="mt-2 text-xs font-semibold text-white"
              >
                {stopping ? 'Saving…' : recording ? 'Stop & review' : 'Record'}
              </Text>
            </View>

            <View className="flex-1 items-center">
              {/* Long press opens the condition prompts by hand.
                  The sensor cue must never be the only route: a device with no
                  gyroscope reports SENSOR_UNAVAILABLE and reaches no complete
                  state at all, and a technician who dismissed the prompt with
                  "Later" would otherwise have no way back to it. */}
              <Pressable
                accessibilityHint="Opens the condition questions, which can be browsed in either direction without answering. Long press to see the whole checklist."
                accessibilityLabel={`Area checklist, ${checklistCoverage.covered} of ${checklistCoverage.total} covered`}
                accessibilityRole="button"
                className="h-14 w-14 items-center justify-center rounded-full border border-white/25 bg-black/30"
                // Tap asks the next question; long press opens the full list to
                // review or correct. The prompt is the fast path, so it gets the
                // tap — an area with no authored items falls back to the list,
                // which explains itself rather than opening an empty prompt.
                onLongPress={() => setChecklistOpen(true)}
                onPress={() =>
                  conditionItems.data?.length ? setConditionOpen(true) : setChecklistOpen(true)
                }
              >
                <ListChecksIcon size={22} className="text-white" />
              </Pressable>
              {/* The count is the point: a technician glancing down should see
                  how much of the area they still have to cover without opening
                  anything. */}
              <Text
                importantForAccessibility="no"
                className="mt-2 text-xs font-medium text-white/70"
              >
                {checklistCoverage.covered}/{checklistCoverage.total} list
              </Text>
            </View>
          </View>
        </View>
      </SafeAreaView>

      {/* Above the chrome so the blink covers the whole frame, below the sheets
          so it never fires over a question. */}
      <ShutterFlash trigger={flashTrigger} />

      <AreaChecklistSheet
        areaName={room.data?.name ?? 'Area'}
        // Keyed by item id so a row can read its own answers without scanning
        // the list once per render.
        assessments={conditionAssessments}
        checkedIds={checkedItems}
        items={checklist}
        onAssess={(itemId, axis, next) => {
          const current = conditionAssessments.get(itemId);
          recordCondition.mutate({
            itemId,
            assessment: {
              isClean: current?.isClean ?? null,
              isUndamaged: current?.isUndamaged ?? null,
              isWorking: current?.isWorking ?? null,
              comment: current?.comment ?? null,
              // The whole assessment every time: the API takes a complete
              // record, so sending one axis would clear the other two.
              [axis]: next,
              // Where in the recording it was answered, so the reviewer can
              // jump to the moment instead of scrubbing.
              videoTimestampSeconds: recording ? secondsRef.current : null,
            },
          });
        }}
        onClose={() => setChecklistOpen(false)}
        /**
         * A measurement, a line of text, or a chosen option.
         *
         * The whole assessment goes every time, exactly as `onAssess` does:
         * the API takes a complete record, so sending only the changed field
         * would clear everything else already answered about the item.
         */
        onRecord={(itemId, patch) => {
          const current = conditionAssessments.get(itemId);
          recordCondition.mutate({
            itemId,
            assessment: {
              isClean: current?.isClean ?? null,
              isUndamaged: current?.isUndamaged ?? null,
              isWorking: current?.isWorking ?? null,
              comment: current?.comment ?? null,
              numericValue: current?.numericValue ?? null,
              textValue: current?.textValue ?? null,
              ...patch,
              videoTimestampSeconds: recording ? secondsRef.current : null,
            },
          });
        }}
        onToggle={(id) => toggleChecklistItem(areaId, id)}
        recording={recording}
        visible={checklistOpen}
      />

      <ConditionPromptSheet
        items={conditionItems.data ?? []}
        onClose={() => setConditionOpen(false)}
        onRecord={(itemId, assessment) => {
          recordCondition.mutate({
            // Read from the ref, not the `seconds` state: the state lags by up
            // to a second behind the timer, and the whole point is the moment
            // the technician actually answered.
            itemId,
            assessment: { ...assessment, videoTimestampSeconds: secondsRef.current },
          });
        }}
        saving={recordCondition.isPending}
        visible={conditionOpen}
      />

      <SweepPromptSheet
        areaName={room.data?.name ?? 'this area'}
        onClose={() => setSweepPromptOpen(false)}
        visible={sweepPromptOpen}
      />

      <StopRecordingSheet
        elapsedLabel={formatDuration(seconds)}
        onFinish={() => {
          setConfirmStopOpen(false);
          stopRecording();
        }}
        onKeepRecording={() => setConfirmStopOpen(false)}
        photoCount={photoCount}
        visible={confirmStopOpen}
      />
    </View>
  );
}
