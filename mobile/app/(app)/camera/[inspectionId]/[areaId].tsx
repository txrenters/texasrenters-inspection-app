import { useEffect, useRef, useState } from 'react';
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
  CheckIcon,
  FocusIcon,
  ImageIcon,
  RotateCcwIcon,
  VideoIcon,
  ZapIcon,
  ZapOffIcon,
} from 'lucide-react-native';
import {
  ActivityIndicator,
  Animated,
  BackHandler,
  Image,
  Linking,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BackGlyph } from '@/src/components/ui/BackGlyph';
import { Button, PRESS_SURFACE } from '@/src/components/ui';
import { BottomSheet } from '@/src/components/BottomSheet';
import { goBack } from '@/src/lib/navigation';
import { HomeButton } from '@/src/components/HomeButton';
import { GuidedCaptureOverlay } from '@/src/capture/GuidedCaptureOverlay';
import { ShutterFlash } from '@/src/capture/ShutterFlash';
import { StopRecordingSheet } from '@/src/capture/StopRecordingSheet';
import {
  initialCameraMode,
  primaryCapture,
  snapshotMode,
  stopRequestOutcome,
} from '@/src/capture/capture-intents';
import { RECORDING_RED, captureControlLook } from '@/src/capture/capture-controls';
import { cameraZoomFor, pickBackLenses, pinchLevel, type BackLenses } from '@/src/capture/camera-zoom';
import { useIconRotation } from '@/src/capture/use-icon-rotation';
import {
  GUIDED_CAPTURE_POLICY,
  clampRotationDegrees,
  evaluateCapture,
  guidedCaptureState,
  rotationProgress,
  type GuidedCaptureSummary,
} from '@/src/capture/guided-capture';
import { SweepPromptSheet } from '@/src/capture/SweepPromptSheet';
import { useGuidedCaptureSensor } from '@/src/capture/use-guided-capture';
import type { PhotoCaptureType, RoomSnapshot } from '@/src/domain/models';
import { useInspection, useInspectionActions, useRoom } from '@/src/features/queries';
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
  CheckIcon,
  FocusIcon,
  ImageIcon,
  RotateCcwIcon,
  VideoIcon,
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
   * Whether this sweep's completion has already been announced.
   *
   * The change-guard above dedupes on the raw guidance state, but the branch
   * that announces completion accepts COMPLETE *or* LIKELY_COMPLETE. A sweep
   * hovering around the finish oscillates between the two, and each oscillation
   * is a genuine state change landing in the same branch — so the announcement
   * and its haptic replayed every time. Latched per sweep instead, and reset
   * when the next recording starts.
   */
  const sweepAnnouncedRef = useRef(false);
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
  /**
   * Photos or video on the big button -- see `primaryCapture`. Chosen for this
   * area on the area screen, the first time its camera is opened
   * (`asksCaptureChoice`); an occupied area reached without an answer
   * photographs first, and a visit that must be filmed always records.
   */
  const chosenCapture = useDemoStore((state) => state.captureModeByArea[areaId]);
  const primary = primaryCapture(requiresRecording, chosenCapture);
  const restingMode = initialCameraMode(primary === 'VIDEO');
  const [cameraMode, setCameraMode] = useState<CameraMode>(() => restingMode);
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
  /**
   * Whether leaving should ask first.
   *
   * Capturing anything starts the area, and walking out of a started area with
   * a single tap of the back arrow is how a technician loses their place —
   * they meant to keep going and the screen simply left. Reported from the
   * field 2026-09-10.
   */
  const [exitOpen, setExitOpen] = useState(false);
  const discardTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [capturingPhoto, setCapturingPhoto] = useState(false);
  // A count, not a flag: two shutter taps in a row have to be distinguishable
  // or the second renders the same value and nothing flashes.
  const [flashTrigger, setFlashTrigger] = useState(0);
  const [sweepPromptOpen, setSweepPromptOpen] = useState(false);
  const [confirmStopOpen, setConfirmStopOpen] = useState(false);

  /*
   * There is no checklist on this screen any more.
   *
   * It carried two: a yes/no prompt that opened itself when the sweep
   * completed, and the full list behind a button beside the shutter. Demoed to
   * the product owner, both read as a second copy of the checklist on the area
   * screen -- on an occupied visit the list was exactly that, the same two
   * questions in two places. The checklist now lives on the area screen alone:
   * the occupied condition questions, or the full list for every other kind of
   * visit. "Done" below returns there already scrolled to it. This screen
   * captures.
   */
  const [error, setError] = useState<string | null>(null);
  const setDraft = useDemoStore((state) => state.setDraftRecording);
  const addSnapshot = useDemoStore((state) => state.addSnapshot);
  const removeSnapshots = useDemoStore((state) => state.removeSnapshots);
  const ownerUserId = useDemoStore((state) => state.selectedUserId ?? undefined);
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
  /** Icons turn to face the technician when the phone is held sideways; see `useIconRotation`. */
  const { style: iconTurn } = useIconRotation(hasPermissions);

  /**
   * Zoom, as a pinch level from 0 to 1, and the ultra-wide lens behind 0.5x.
   *
   * See `camera-zoom.ts` for why the pinch is a level rather than a labelled
   * factor, and why 0.5x exists only where iOS names an ultra-wide lens.
   */
  const [zoomLevel, setZoomLevel] = useState(0);
  const zoomLevelRef = useRef(0);
  zoomLevelRef.current = zoomLevel;
  const [backLenses, setBackLenses] = useState<BackLenses>({});
  const [ultraWide, setUltraWide] = useState(false);
  /**
   * Whether a lens chip has been used on this screen.
   *
   * Until then no lens is passed at all, so the camera opens exactly as it
   * always has. Choosing a lens reconfigures the capture session, and doing it
   * unasked as the screen opened could land on top of a recording that had
   * just started.
   */
  const [lensChosen, setLensChosen] = useState(false);
  const selectedLens =
    Platform.OS === 'ios' && facing === 'back' && lensChosen
      ? ultraWide
        ? backLenses.ultraWide
        : backLenses.main
      : undefined;

  const chooseLens = (wide: boolean) => {
    if (recording || stopping) return;
    setLensChosen(true);
    setUltraWide(wide);
    setZoomLevel(0);
  };

  /** Two fingers zoom; one finger is left alone for every control on the screen. */
  const pinchStart = useRef<{ distance: number; level: number } | null>(null);
  const pinch = useRef(
    PanResponder.create({
      onStartShouldSetPanResponderCapture: (event) => event.nativeEvent.touches.length === 2,
      onMoveShouldSetPanResponderCapture: (event) => event.nativeEvent.touches.length === 2,
      onPanResponderGrant: () => {
        pinchStart.current = null;
      },
      onPanResponderMove: (event) => {
        const [first, second] = event.nativeEvent.touches;
        if (!first || !second || event.nativeEvent.touches.length !== 2) return;
        const distance = Math.hypot(first.pageX - second.pageX, first.pageY - second.pageY);
        if (!pinchStart.current) {
          pinchStart.current = { distance, level: zoomLevelRef.current };
          return;
        }
        setZoomLevel(pinchLevel(pinchStart.current.level, distance / pinchStart.current.distance));
      },
      onPanResponderRelease: () => {
        pinchStart.current = null;
      },
      onPanResponderTerminate: () => {
        pinchStart.current = null;
      },
    }),
  ).current;
  const guidedSensor = useGuidedCaptureSensor(recording && !skipsRoomSweep);
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
   * Android's hardware back asks the same question the arrow does.
   *
   * Without this it is a way around the prompt — and on Android it is the way
   * most people leave a screen, so the guard would be missing exactly where it
   * is needed most. Returning true means handled; false lets the navigator do
   * what it always did, which is what an untouched area still wants.
   */
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!recording && photoCount === 0) return false;
      requestExit();
      return true;
    });
    return () => subscription.remove();
  });

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
      // on COMPLETE left a large share of real walkthroughs unacknowledged —
      // the room had been filmed and nothing happened.
      //
      // Said and felt, and nothing opens. The sweep confirming used to open
      // the condition prompt over the camera; the questions are the area
      // screen's now, answered once the take is reviewed.
      if (sweepAnnouncedRef.current) return;
      sweepAnnouncedRef.current = true;
      announce('Walkthrough complete. Stop and review when you are ready.');
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
        () => undefined,
      );
    }
  }, [guidanceState, recording, skipsRoomSweep]);

  // A new recording is a new sweep, so its completion is owed again.
  useEffect(() => {
    if (recording) sweepAnnouncedRef.current = false;
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

  /**
   * Which back lenses this iPhone has, asked once the camera is up.
   *
   * Only decides whether the 0.5x chip is offered; nothing about the camera
   * changes until a chip is pressed.
   */
  const lensesAskedRef = useRef(false);
  useEffect(() => {
    if (Platform.OS !== 'ios' || !ready || !camera || facing !== 'back') return;
    // Once per screen. A phone whose lens names match nothing would otherwise
    // ask again on every render, since each answer is a fresh object.
    if (lensesAskedRef.current) return;
    lensesAskedRef.current = true;
    void camera
      .getAvailableLensesAsync()
      .then((names) => {
        if (mountedRef.current) setBackLenses(pickBackLenses(names));
      })
      .catch(() => undefined);
  }, [camera, facing, ready]);

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

  /**
   * Settles the camera on the right mode once the room is known.
   *
   * The initial state is computed on the first render, and until the room has
   * loaded an unknown type counts as one that must be filmed -- so an occupied
   * visit opened before its room was cached came up bound to video, and stayed
   * that way. Settled once, when the type arrives, and never mid-take.
   */
  const modeSettledRef = useRef(false);
  useEffect(() => {
    if (!room.data || modeSettledRef.current || recording || stopping) return;
    modeSettledRef.current = true;
    if (cameraModeRef.current !== restingMode) void bindCamera(restingMode);
    // bindCamera is left out on purpose: it is recreated every render and
    // reads only refs and setters.
  }, [room.data, restingMode, recording, stopping]);

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
      if (mountedRef.current) void bindCamera(restingMode);
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
   * What the back arrow means, which depends on what is under way.
   *
   * Three states, and they were two. Mid-recording it stops the take, as it
   * always has. On an untouched area it simply leaves — there is nothing to
   * lose and nothing worth asking about.
   *
   * The new one in the middle: an area where photographs have been taken is an
   * area the technician has *started*, and leaving it with one tap of an arrow
   * that sits exactly where a thumb rests is how somebody loses their place —
   * they meant to keep going and the screen simply left. Asked, not blocked:
   * both answers are one tap, and neither is hidden.
   */
  const requestExit = () => {
    if (recording) return requestStopRecording();
    if (photoCount > 0) return setExitOpen(true);
    goBack();
  };

  /**
   * Done photographing: straight to the questions about the room.
   *
   * Asked for from the field. Finishing meant the back arrow, then a sheet
   * asking whether to continue, then scrolling the area screen to find the
   * condition questions. This returns to the area already scrolled to them --
   * the occupied condition card, or the area's checklist on any other visit,
   * with "Finish this area" beneath. The only checklist there is, now that this
   * screen carries none.
   *
   * `dismissTo` rather than `push`: the area screen is already underneath, and
   * pushing a second copy would leave the back arrow returning to the camera.
   */
  const finishPhotos = () => {
    setExitOpen(false);
    router.dismissTo({ pathname: '/(app)/areas/[id]', params: { id: areaId, focus: 'condition' } });
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

  /**
   * The photo control: a white shutter when it leads, a ring when it does not.
   *
   * Written once and placed by `primary`, so the two layouts cannot drift apart
   * in what the button says or does -- only in how big it is. Never red; see
   * `captureControlLook`.
   */
  const renderPhotoControl = (large: boolean) => {
    const look = captureControlLook({ large, stopControl: false });
    const tone = look.glyph ?? undefined;
    const glyph = capturingPhoto ? (
      <ActivityIndicator className={tone} />
    ) : (
      <Animated.View style={iconTurn}>
        <CameraIcon size={large ? 26 : 24} className={tone} />
      </Animated.View>
    );
    return (
      <>
        <Pressable
          accessibilityHint={
            captureType === 'AREA_OVERVIEW'
              ? 'Captures a wide shot of the area'
              : 'Captures a close-up for a finding'
          }
          accessibilityLabel={capturingPhoto ? 'Saving photo' : 'Take photo'}
          accessibilityRole="button"
          accessibilityState={{ busy: capturingPhoto, disabled: !ready || capturingPhoto }}
          className={look.ring}
          onPress={() => void takeSnapshot()}
          disabled={!ready || capturingPhoto}
        >
          {look.disc ? <View className={look.disc}>{glyph}</View> : glyph}
        </Pressable>
        {/* One accessible node, or VoiceOver reads the count and the word
            "photos" as two separate stops. */}
        <Text
          accessible
          accessibilityLabel={`${photoCount} photo${photoCount === 1 ? '' : 's'} captured`}
          className={`mt-2 text-xs ${large ? 'font-semibold text-white' : 'font-medium text-white/70'}`}
        >
          {photoCount} photo{photoCount === 1 ? '' : 's'}
        </Text>
      </>
    );
  };

  /**
   * The record control: a white shutter when it leads, a ring when it does not.
   *
   * While its take runs it becomes the stop control, a red square in the same
   * ring -- the only red on the capture controls, and the conventional sign
   * that a camera is recording. Idle, it is as neutral as the photo shutter.
   */
  const renderRecordControl = (large: boolean) => {
    const look = captureControlLook({ large, stopControl: recording });
    const glyph = look.glyph ? (
      <Animated.View style={iconTurn}>
        <VideoIcon size={large ? 26 : 22} className={look.glyph} />
      </Animated.View>
    ) : null;
    return (
      <>
        <Pressable
          accessibilityHint={recording ? 'Ends the take and opens the review screen' : undefined}
          accessibilityLabel={
            stopping ? 'Saving recording' : recording ? 'Stop recording' : 'Start recording'
          }
          accessibilityRole="button"
          accessibilityState={{ busy: stopping, disabled: !ready || stopping }}
          className={look.ring}
          disabled={!ready || stopping}
          onPress={recording ? requestStopRecording : () => void beginRecording()}
        >
          {look.disc ? <View className={look.disc}>{glyph}</View> : glyph}
        </Pressable>
        {/* importantForAccessibility="no": the button above already says this,
            and leaving it focusable makes the technician swipe past a duplicate
            of the control they just heard. */}
        <Text
          importantForAccessibility="no"
          className={`mt-2 text-xs ${large ? 'font-semibold text-white' : 'font-medium text-white/70'}`}
        >
          {stopping ? 'Saving…' : recording ? 'Stop & review' : 'Record'}
        </Text>
      </>
    );
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
    <View className="flex-1 bg-black" {...pinch.panHandlers}>
      <StatusBar style="light" />
      <CameraView
        ref={setCamera}
        style={StyleSheet.absoluteFill}
        facing={facing}
        enableTorch={torch && facing === 'back'}
        mode={cameraMode}
        zoom={cameraZoomFor(zoomLevel, Platform.OS)}
        selectedLens={selectedLens}
        /**
         * Photographs follow how the phone is held even with iOS rotation lock
         * on. Without it a locked phone turned sideways saved a portrait photo
         * of a landscape room.
         */
        responsiveOrientationWhenOrientationLocked
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
              onPress={requestExit}
            >
              <BackGlyph size={21} className="text-white" />
            </Pressable>
            <View className="min-w-0 flex-1">
              <Text numberOfLines={1} className="text-xl font-bold text-white">
                {room.data?.name ?? 'Room'}
              </Text>
              <Text className="text-xs text-white/70">
                {isAdditional
                  ? 'Additional evidence clip'
                  : primary === 'PHOTO'
                    ? 'Room photos'
                    : 'Primary room walkthrough'}
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
              <Animated.View style={iconTurn}>
                {torch ? (
                  <ZapIcon size={20} className="text-white" />
                ) : (
                  <ZapOffIcon size={20} className="text-white" />
                )}
              </Animated.View>
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
              <Animated.View style={iconTurn}>
                <RotateCcwIcon size={20} className="text-white" />
              </Animated.View>
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
          {/* Not on a screen that photographs first: "00:00 READY" over a photo
              camera reads as though it were waiting to film. */}
          {recording || primary === 'VIDEO' ? (
            <View
              accessibilityLabel={
                recording ? `Recording, ${formatDuration(seconds)} elapsed` : 'Ready to record'
              }
              accessibilityRole="timer"
              className="mb-6 flex-row items-center gap-2 rounded-full bg-black/65 px-5 py-2"
            >
              {/* The recording dot, only while a take runs. Red here says what
                  it says on every camera, which is why the shutter is not. */}
              {recording ? <View className={`h-2.5 w-2.5 rounded-full ${RECORDING_RED}`} /> : null}
              <Text className="text-lg font-bold text-white">
                {formatDuration(seconds)} {recording ? 'REC' : 'READY'}
              </Text>
            </View>
          ) : null}
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

          {/* Zoom. 0.5x switches to the ultra-wide lens, on an iPhone that has
              one; pinching zooms in on whichever lens is showing. Lens chips
              are held still mid-take: changing lens rebuilds the capture
              session, which would end the recording. */}
          {backLenses.ultraWide && facing === 'back' ? (
            <View accessibilityRole="radiogroup" className="mb-3 flex-row items-center gap-2">
              {([true, false] as const).map((wide) => {
                const selected = ultraWide === wide;
                return (
                  <Pressable
                    accessibilityLabel={wide ? 'Ultra wide, 0.5 times' : 'Standard, 1 times'}
                    accessibilityRole="radio"
                    accessibilityState={{ selected, disabled: recording || stopping }}
                    className={`h-9 min-w-12 items-center justify-center rounded-full px-3 ${
                      selected ? 'bg-white' : 'border border-white/25 bg-black/30'
                    }`}
                    disabled={recording || stopping}
                    key={String(wide)}
                    onPress={() => chooseLens(wide)}
                  >
                    <Animated.View style={iconTurn}>
                      <Text className={`text-xs font-bold ${selected ? 'text-black' : 'text-white'}`}>
                        {wide ? '0.5×' : '1×'}
                      </Text>
                    </Animated.View>
                  </Pressable>
                );
              })}
            </View>
          ) : null}
          {zoomLevel > 0 ? (
            <Pressable
              accessibilityHint="Resets the zoom"
              accessibilityLabel={`Zoomed in, ${Math.round(zoomLevel * 100)} percent`}
              accessibilityRole="button"
              className="mb-3 h-8 w-32 flex-row items-center gap-2 rounded-full bg-black/55 px-3"
              onPress={() => setZoomLevel(0)}
            >
              <Text className="text-[11px] font-bold text-white">Zoom</Text>
              <View className="h-1 flex-1 overflow-hidden rounded-full bg-white/25">
                <View className="h-1 rounded-full bg-white" style={{ width: `${zoomLevel * 100}%` }} />
              </View>
            </Pressable>
          ) : null}

          {/* Photo and record swap places with the capture this area leads
              with: the big button is whichever gets pressed most. Neither is
              ever taken away. */}
          <View className="w-full flex-row items-start justify-between">
            <View className="flex-1 items-center">
              {primary === 'PHOTO' ? renderRecordControl(false) : renderPhotoControl(false)}
            </View>

            <View className="flex-1 items-center">
              {primary === 'PHOTO' ? renderPhotoControl(true) : renderRecordControl(true)}
            </View>

            {/* Empty on purpose. The checklist button sat here; the checklist
                is the area screen's now. The third keeps the shutter centred,
                where a thumb expects it, rather than sliding it right. */}
            <View className="flex-1" />
          </View>

          {photoCount > 0 && !recording && !stopping ? (
            <Pressable
              accessibilityHint="Returns to the area to answer its condition questions and submit"
              accessibilityLabel="Done taking photos"
              accessibilityRole="button"
              className={`mt-4 min-h-12 w-full flex-row items-center justify-center gap-2 rounded-xl bg-white px-4 ${PRESS_SURFACE}`}
              onPress={finishPhotos}
            >
              <CheckIcon size={18} className="text-black" />
              <Text className="text-sm font-bold text-black">
                {primary === 'PHOTO' ? 'Done — rate the room' : 'Done'}
              </Text>
            </Pressable>
          ) : null}
        </View>
      </SafeAreaView>

      {/* Above the chrome so the blink covers the whole frame, below the sheets
          so it never fires over a question. */}
      <ShutterFlash trigger={flashTrigger} />

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

      {/*
        Leaving a started area is a decision, so it is asked rather than
        assumed.

        Neither answer is hidden and neither costs more than a tap. "Keep
        inspecting" is listed first because it is the one a technician who hit
        the arrow by accident wants, and it is the answer that loses nothing.

        Finishing goes to the area screen rather than completing the area from
        here. Completion has a gate — evidence, and an upload that has at least
        reached the queue — and the area screen is where that gate explains
        itself. Refusing inside this sheet would be a dead end held one screen
        away from its own explanation.
      */}
      <BottomSheet
        accessibilityRole="alert"
        animationType="fade"
        onClose={() => setExitOpen(false)}
        visible={exitOpen}
      >
        <Text className="text-xl font-bold text-foreground">
          {photoCount === 1 ? '1 photo taken here' : `${photoCount} photos taken here`}
        </Text>
        <Text className="mt-2 text-sm leading-5 text-muted-foreground">
          This area is under way. Keep capturing, or go through what you have, add a note and
          submit it.
        </Text>
        <View className="mt-5 gap-3">
          <Button label="Keep Taking Evidence" onPress={() => setExitOpen(false)} />
          <Button
            accessibilityHint="Opens the area, where you can review the media, add a note and submit"
            label="Continue & Review"
            onPress={finishPhotos}
            variant="secondary"
          />
        </View>
      </BottomSheet>
    </View>
  );
}
