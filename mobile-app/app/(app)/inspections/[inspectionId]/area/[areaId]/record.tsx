import { type ComponentProps, useEffect, useRef, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import {
  CameraView,
  type CameraType,
  useCameraPermissions,
  useMicrophonePermissions,
} from 'expo-camera';
import * as DocumentPicker from 'expo-document-picker';
import * as Haptics from 'expo-haptics';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import {
  ActivityIndicator,
  Image,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppButton, ConfirmationModal } from '../../../../../../src/components/ui';
import { Label } from '../../../../../../src/components/ui/label';
import {
  RadioGroup,
  RadioGroupItem,
} from '../../../../../../src/components/ui/radio-group';
import { GuidedCaptureOverlay } from '../../../../../../src/capture/GuidedCaptureOverlay';
import {
  evaluateCapture,
  GUIDED_CAPTURE_POLICY,
  returnedToStart,
  type FindingMarker,
  type GuidedCaptureSummary,
} from '../../../../../../src/capture/guided-capture';
import { useGuidedCaptureSensor } from '../../../../../../src/capture/use-guided-capture';
import { environment, isDemoMode } from '../../../../../../src/config/environment';
import { useRoom } from '../../../../../../src/features/queries';
import {
  buildRecordingDraft,
  persistRecording,
} from '../../../../../../src/media/local-recordings';
import {
  buildRoomSnapshot,
  persistRoomSnapshot,
} from '../../../../../../src/media/local-snapshots';
import { uploadRoomPhoto } from '../../../../../../src/media/photo-upload';
import { videoStepsForEnvironment } from '../../../../../../src/utils/video-capture-guide';
import type { PhotoCaptureType, RoomSnapshot } from '../../../../../../src/domain/models';
import { useDemoStore } from '../../../../../../src/stores/demo.store';
import {
  type AppColors,
  radius,
  spacing,
  typography,
  useThemedStyles,
} from '../../../../../../src/theme';

const MAX_RECORDING_SECONDS = 10 * 60;
const RECORDING_STOP_GRACE_MS = 1_500;
const RECORDING_FINALIZE_TIMEOUT_MS = 6_000;

const CAPTURE_TYPE_OPTIONS: ReadonlyArray<{ value: PhotoCaptureType; label: string }> = [
  { value: 'AREA_OVERVIEW', label: 'Area overview' },
  { value: 'FINDING_CONTEXT', label: 'Finding context' },
  { value: 'FINDING_CLOSE_UP', label: 'Finding close-up' },
  { value: 'SUPPORTING_ANGLE', label: 'Supporting angle' },
];
const CAPTURE_TYPE_LABELS: Partial<Record<PhotoCaptureType, string>> = {
  AREA_OVERVIEW: 'area overview',
  WALL_OVERVIEW: 'wall overview',
  FINDING_CONTEXT: 'finding context',
  FINDING_CLOSE_UP: 'finding close-up',
  SUPPORTING_ANGLE: 'supporting angle',
  SCALE_REFERENCE: 'scale reference',
  SERIAL_OR_LABEL: 'serial or label',
  VIDEO_FRAME_SNAPSHOT: 'video frame',
  OTHER: 'photo',
  FINDING_DETAIL: 'finding close-up',
  SUPPORTING_EVIDENCE: 'supporting photo',
};
// Snapshot guidance shown before/during capture (spec §8).
const PHOTO_GUIDANCE = [
  'Take a complete view of the whole wall, room, fixture, or outdoor area first.',
  'Then take a focused close-up of each identified issue.',
  'Include enough surrounding context to show where the issue is located.',
  'Take additional angles when one image does not show the full condition.',
  'Avoid blurry, dark, obstructed, or extremely zoomed images.',
  'Include a scale reference when the size of the damage matters.',
  'Avoid photographing unrelated personal information where possible.',
];

export default function RecordRoomScreen() {
  const styles = useThemedStyles(createStyles);
  const {
    inspectionId = '',
    areaId = '',
    recordingType: recordingTypeParam,
  } = useLocalSearchParams<{
    inspectionId: string;
    areaId: string;
    recordingType?: string;
  }>();
  const isAdditionalVideo = recordingTypeParam === 'ADDITIONAL_ISSUE';
  const sessionIdRef = useRef(`capture-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`);
  const sessionStartedAtRef = useRef(new Date().toISOString());
  const snapshotSequenceRef = useRef(0);
  const snapshotTypesRef = useRef<PhotoCaptureType[]>([]);
  const snapshotBookmarksRef = useRef<
    Array<{
      captureType: PhotoCaptureType;
      videoTimestampMs: number;
      findingId?: string;
    }>
  >([]);
  const findingsRef = useRef<FindingMarker[]>([]);
  const hapticMilestoneRef = useRef(0);
  const room = useRoom(areaId);
  const setDraft = useDemoStore((state) => state.setDraftRecording);
  const addSnapshot = useDemoStore((state) => state.addSnapshot);
  const updateSnapshot = useDemoStore((state) => state.updateSnapshot);
  const snapshots = useDemoStore((state) => state.snapshots ?? []);
  const ownerUserId = useDemoStore((state) => state.selectedUserId ?? undefined);
  const roomSnapshots = snapshots.filter(
    (snapshot) =>
      snapshot.ownerUserId === ownerUserId &&
      snapshot.inspectionId === inspectionId &&
      snapshot.roomId === areaId,
  );
  const latestSnapshot = roomSnapshots[0];
  const failedPhotos = roomSnapshots.filter((snapshot) => snapshot.uploadStatus === 'FAILED');
  const videoSteps = videoStepsForEnvironment(room.data?.environment);
  const isOutdoorArea =
    room.data?.environment === 'OUTDOOR' || room.data?.environment === 'SEMI_OUTDOOR';
  const cameraRef = useRef<CameraView>(null);
  const secondsRef = useRef(0);
  const cancelRequestedRef = useRef(false);
  const mountedRef = useRef(true);
  const recordingSettledRef = useRef(true);
  const stopGraceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finalizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [microphonePermission, requestMicrophonePermission] = useMicrophonePermissions();
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraActive, setCameraActive] = useState(true);
  const [cameraGeneration, setCameraGeneration] = useState(0);
  const [recording, setRecording] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [paused, setPaused] = useState(false);
  const [pauseSupported, setPauseSupported] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [torch, setTorch] = useState(false);
  const [facing, setFacing] = useState<CameraType>('back');
  const [capturingSnapshot, setCapturingSnapshot] = useState(false);
  const [captureType, setCaptureType] = useState<PhotoCaptureType>('AREA_OVERVIEW');
  const [captureTypeOpen, setCaptureTypeOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [videoGuideOpen, setVideoGuideOpen] = useState(false);
  const [snapshotMessage, setSnapshotMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [prepared, setPrepared] = useState(isAdditionalVideo);
  const [preparing, setPreparing] = useState(false);
  const [sensorNotice, setSensorNotice] = useState<string | null>(null);
  const [findingCount, setFindingCount] = useState(0);
  const [sessionPhotoCount, setSessionPhotoCount] = useState(0);
  const guidedSensor = useGuidedCaptureSensor(recording && !isAdditionalVideo);
  const hasPermissions = Boolean(cameraPermission?.granted && microphonePermission?.granted);
  const canAskForPermissions =
    (!cameraPermission || cameraPermission.granted || cameraPermission.canAskAgain) &&
    (!microphonePermission || microphonePermission.granted || microphonePermission.canAskAgain);

  const clearRecordingTimers = () => {
    if (stopGraceTimerRef.current) clearTimeout(stopGraceTimerRef.current);
    if (finalizeTimerRef.current) clearTimeout(finalizeTimerRef.current);
    stopGraceTimerRef.current = null;
    finalizeTimerRef.current = null;
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelRequestedRef.current = true;
      clearRecordingTimers();
      cameraRef.current?.stopRecording();
    };
  }, []);

  useEffect(() => {
    if (!recording || paused || stopping) return;
    const timer = setInterval(() => {
      secondsRef.current += 1;
      setSeconds(secondsRef.current);
    }, 1000);
    return () => clearInterval(timer);
  }, [paused, recording, stopping]);

  useEffect(() => {
    if (!recording || isAdditionalVideo || !guidedSensor.authorized) return;
    const percent = Math.round(
      (guidedSensor.tracker.clockwiseRotationDegrees /
        GUIDED_CAPTURE_POLICY.targetClockwiseDegrees) *
        100,
    );
    const milestone = [100, 75, 50, 25].find((value) => percent >= value) ?? 0;
    if (milestone <= hapticMilestoneRef.current) return;
    hapticMilestoneRef.current = milestone;
    void Haptics.impactAsync(
      milestone >= 100 ? Haptics.ImpactFeedbackStyle.Heavy : Haptics.ImpactFeedbackStyle.Light,
    ).catch(() => undefined);
  }, [
    guidedSensor.authorized,
    guidedSensor.tracker.clockwiseRotationDegrees,
    isAdditionalVideo,
    recording,
  ]);

  const requestPermissions = async () => {
    setError(null);
    if (!canAskForPermissions) {
      await Linking.openSettings();
      return false;
    }

    const cameraResult = cameraPermission?.granted
      ? cameraPermission
      : await requestCameraPermission();
    const microphoneResult = microphonePermission?.granted
      ? microphonePermission
      : await requestMicrophonePermission();

    if (!cameraResult.granted || !microphoneResult.granted) {
      setError('Camera and microphone access are both required to record room evidence.');
      return false;
    }
    return true;
  };

  const prepareCapture = async () => {
    if (preparing) return;
    setPreparing(true);
    // Wall 1 is established by the technician's tap. Dismiss the one-time
    // guide immediately so native permission prompts never leave it looking stuck.
    setPrepared(true);
    try {
      const [sensorGranted] = await Promise.all([
        guidedSensor.requestAccess(),
        requestPermissions(),
      ]);
      setSensorNotice(
        sensorGranted
          ? 'Motion guidance enabled.'
          : 'Motion guidance unavailable. Confirm coverage manually after recording.',
      );
    } finally {
      if (mountedRef.current) setPreparing(false);
    }
  };

  const createCaptureSummary = (duration: number): GuidedCaptureSummary | undefined => {
    if (isAdditionalVideo) return undefined;
    const evaluation = evaluateCapture({
      tracker: guidedSensor.trackerRef.current,
      durationSeconds: duration,
      sensorSupported: guidedSensor.authorized,
    });
    const hasOverview = snapshotTypesRef.current.includes('AREA_OVERVIEW');
    const hasFocusedEvidence = snapshotTypesRef.current.some((type) =>
      ['FINDING_CONTEXT', 'FINDING_CLOSE_UP', 'SUPPORTING_ANGLE'].includes(type),
    );
    return {
      sessionId: sessionIdRef.current,
      policyVersion: GUIDED_CAPTURE_POLICY.version,
      startedAt: sessionStartedAtRef.current,
      completedAt: new Date().toISOString(),
      durationSeconds: duration,
      clockwiseRotationDegrees: Math.round(
        guidedSensor.trackerRef.current.clockwiseRotationDegrees,
      ),
      counterClockwiseRotationDegrees: Math.round(
        guidedSensor.trackerRef.current.counterClockwiseRotationDegrees,
      ),
      startHeadingDegrees: guidedSensor.trackerRef.current.startHeadingDegrees,
      endHeadingDegrees: guidedSensor.trackerRef.current.endHeadingDegrees,
      returnedToStart: evaluation.returnedToStart,
      sensorSupported: guidedSensor.authorized,
      sensorConfidence: evaluation.confidence,
      coverageStatus: evaluation.status,
      manualConfirmation: false,
      evidenceComplete: hasOverview && (findingCount === 0 || hasFocusedEvidence),
      snapshotCount: snapshotTypesRef.current.length,
      findingMarkerCount: findingsRef.current.length,
    };
  };

  const uploadSnapshot = async (snapshot: RoomSnapshot) => {
    if (isDemoMode) {
      updateSnapshot(snapshot.id, { uploadStatus: 'UPLOADED' });
      return;
    }
    updateSnapshot(snapshot.id, { uploadStatus: 'UPLOADING' });
    try {
      const uploaded = await uploadRoomPhoto({
        roomId: areaId,
        uri: snapshot.uri,
        captureType: snapshot.captureType ?? 'AREA_OVERVIEW',
        idempotencyKey: snapshot.id,
        width: snapshot.width,
        height: snapshot.height,
        recordingSessionId: snapshot.recordingSessionId,
        videoTimestampMs: snapshot.videoTimestampMs,
        captureSource: snapshot.captureSource,
        sequenceNumber: snapshot.sequenceNumber,
        findingId: snapshot.findingId,
      });
      updateSnapshot(snapshot.id, { uploadStatus: 'UPLOADED', serverPhotoId: uploaded.id });
    } catch {
      updateSnapshot(snapshot.id, { uploadStatus: 'FAILED' });
    }
  };

  const persistBookmarkedFrames = async (videoUri: string) => {
    for (const bookmark of snapshotBookmarksRef.current) {
      try {
        const frame = await VideoThumbnails.getThumbnailAsync(videoUri, {
          time: bookmark.videoTimestampMs,
          quality: 0.82,
        });
        const stored = persistRoomSnapshot(frame.uri, inspectionId, areaId);
        const snapshot = buildRoomSnapshot({
          ownerUserId,
          inspectionId,
          roomId: areaId,
          uri: stored.uri,
          width: frame.width,
          height: frame.height,
          sizeBytes: stored.sizeBytes,
          captureType: bookmark.captureType,
          recordingSessionId: sessionIdRef.current,
          videoTimestampMs: bookmark.videoTimestampMs,
          captureSource: 'VIDEO_FRAME_EXTRACTION',
          sequenceNumber: ++snapshotSequenceRef.current,
          findingId: bookmark.findingId,
        });
        addSnapshot(snapshot);
        void uploadSnapshot(snapshot);
      } catch {
        setSnapshotMessage(
          'The video was saved, but one bookmarked frame still needs a separate photo.',
        );
      }
    }
  };

  const storeDraft = async (temporaryUri: string, duration: number) => {
    const stored = persistRecording(temporaryUri, inspectionId, areaId);
    await persistBookmarkedFrames(stored.uri);
    setDraft(
      buildRecordingDraft({
        ownerUserId,
        inspectionId,
        roomId: areaId,
        uri: stored.uri,
        durationSeconds: duration,
        sizeBytes: stored.sizeBytes,
        recordingType: isAdditionalVideo ? 'ADDITIONAL_ISSUE' : 'PRIMARY_AREA',
        captureSummary: createCaptureSummary(duration),
      }),
    );
    router.replace({
      pathname: '/(app)/inspections/[inspectionId]/area/[areaId]/review',
      params: { inspectionId, areaId },
    });
  };

  const beginRecording = async () => {
    const camera = cameraRef.current;
    if (!camera || !cameraReady || !hasPermissions || recording) return;

    cancelRequestedRef.current = false;
    secondsRef.current = 0;
    setSeconds(0);
    setPaused(false);
    setStopping(false);
    setError(null);
    recordingSettledRef.current = false;
    setRecording(true);

    try {
      // iPhones default to HEVC (H.265), which browsers and Windows cannot
      // play without a paid codec. Force H.264 so reviewers can watch the
      // video anywhere. Android records H.264 by default.
      const result = await camera.recordAsync({
        maxDuration: MAX_RECORDING_SECONDS,
        ...(Platform.OS === 'ios' ? { codec: 'avc1' as const } : {}),
      });
      recordingSettledRef.current = true;
      clearRecordingTimers();
      if (!result || cancelRequestedRef.current || !mountedRef.current) return;
      await storeDraft(result.uri, Math.max(1, secondsRef.current));
    } catch (recordingError) {
      if (!cancelRequestedRef.current && mountedRef.current) {
        setError(
          errorMessage(recordingError, 'The video could not be recorded. Please try again.'),
        );
        setCameraReady(false);
      }
    } finally {
      recordingSettledRef.current = true;
      clearRecordingTimers();
      if (mountedRef.current) {
        setCameraActive(true);
        setRecording(false);
        setStopping(false);
        setPaused(false);
      }
    }
  };

  const startRecording = () => {
    if (!cameraReady || !hasPermissions || recording) return;
    setError(null);
    setSnapshotMessage(null);
    sessionStartedAtRef.current = new Date().toISOString();
    guidedSensor.reset();
    hapticMilestoneRef.current = 0;
    void beginRecording();
  };

  const takeSnapshot = async () => {
    const camera = cameraRef.current;
    if (!camera || !cameraReady || !hasPermissions || capturingSnapshot) return;

    setError(null);
    setSnapshotMessage(null);
    const timestamp = Math.max(0, secondsRef.current * 1000);
    if (recording && Platform.OS === 'android') {
      snapshotBookmarksRef.current.push({
        captureType,
        videoTimestampMs: timestamp,
        findingId: findingsRef.current.at(-1)?.id,
      });
      snapshotTypesRef.current.push(captureType);
      setSessionPhotoCount(snapshotTypesRef.current.length);
      if (captureType === 'AREA_OVERVIEW') setCaptureType('WALL_OVERVIEW');
      if (captureType === 'FINDING_CONTEXT') setCaptureType('FINDING_CLOSE_UP');
      if (captureType === 'FINDING_CLOSE_UP') setCaptureType('SUPPORTING_ANGLE');
      setSnapshotMessage(
        `${CAPTURE_TYPE_LABELS[captureType] ?? 'Photo'} marked at ${formatTimer(seconds)}. A video frame will be created after recording.`,
      );
      void Haptics.selectionAsync().catch(() => undefined);
      return;
    }

    setCapturingSnapshot(true);
    try {
      const captured = await camera.takePictureAsync({ quality: 0.82, shutterSound: false });
      const stored = persistRoomSnapshot(captured.uri, inspectionId, areaId);
      const snapshot = buildRoomSnapshot({
        ownerUserId,
        inspectionId,
        roomId: areaId,
        uri: stored.uri,
        width: captured.width,
        height: captured.height,
        sizeBytes: stored.sizeBytes,
        captureType,
        recordingSessionId: sessionIdRef.current,
        videoTimestampMs: recording ? timestamp : undefined,
        captureSource:
          recording && Platform.OS === 'ios'
            ? 'NATIVE_STILL_DURING_VIDEO'
            : 'SEPARATE_PHOTO_CAPTURE',
        sequenceNumber: ++snapshotSequenceRef.current,
        findingId: findingsRef.current.at(-1)?.id,
      });
      addSnapshot(snapshot);
      snapshotTypesRef.current.push(captureType);
      setSessionPhotoCount(snapshotTypesRef.current.length);
      if (captureType === 'AREA_OVERVIEW') setCaptureType('WALL_OVERVIEW');
      if (captureType === 'FINDING_CONTEXT') setCaptureType('FINDING_CLOSE_UP');
      if (captureType === 'FINDING_CLOSE_UP') setCaptureType('SUPPORTING_ANGLE');
      setSnapshotMessage(
        recording
          ? `${CAPTURE_TYPE_LABELS[captureType]} saved — recording continues.`
          : `${CAPTURE_TYPE_LABELS[captureType]} saved.`,
      );
      void uploadSnapshot(snapshot);
    } catch (snapshotError) {
      setError(errorMessage(snapshotError, 'The snapshot could not be saved. Please try again.'));
    } finally {
      if (mountedRef.current) setCapturingSnapshot(false);
    }
  };

  const markFinding = () => {
    const marker: FindingMarker = {
      id: `finding-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      videoTimestampMs: Math.max(0, secondsRef.current * 1000),
      rotationDegrees: Math.round(guidedSensor.trackerRef.current.clockwiseRotationDegrees),
      createdAt: new Date().toISOString(),
    };
    findingsRef.current.push(marker);
    setFindingCount(findingsRef.current.length);
    setCaptureType('FINDING_CONTEXT');
    setSnapshotMessage('Finding marked. Capture context first, then a close-up.');
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => undefined);
  };

  const stopRecording = () => {
    if (!recording || stopping) return;
    setStopping(true);
    cameraRef.current?.stopRecording();
    stopGraceTimerRef.current = setTimeout(() => {
      if (!recordingSettledRef.current && mountedRef.current) setCameraActive(false);
    }, RECORDING_STOP_GRACE_MS);
    finalizeTimerRef.current = setTimeout(() => {
      if (recordingSettledRef.current || !mountedRef.current) return;
      cancelRequestedRef.current = true;
      recordingSettledRef.current = true;
      setRecording(false);
      setStopping(false);
      setPaused(false);
      setCameraReady(false);
      setCameraActive(true);
      setCameraGeneration((value) => value + 1);
      setError('The camera could not finalize that video. Please record it again.');
    }, RECORDING_FINALIZE_TIMEOUT_MS);
  };

  const togglePause = async () => {
    if (!recording || stopping || !pauseSupported) return;
    try {
      await cameraRef.current?.toggleRecordingAsync();
      setPaused((value) => !value);
    } catch (pauseError) {
      setError(errorMessage(pauseError, 'This device could not pause the recording.'));
    }
  };

  const discardAndLeave = () => {
    cancelRequestedRef.current = true;
    setCancelOpen(false);
    cameraRef.current?.stopRecording();
    router.back();
  };

  const pickTestVideo = async () => {
    const result = await DocumentPicker.getDocumentAsync({
      type: 'video/*',
      copyToCacheDirectory: true,
    });
    if (!result.canceled && result.assets[0]) await storeDraft(result.assets[0].uri, 37);
  };

  return (
    <View style={styles.root}>
      <Stack.Screen options={{ headerShown: false }} />
      <StatusBar style="light" />
      {hasPermissions ? (
        <CameraView
          key={'video-' + cameraGeneration}
          ref={cameraRef}
          active={cameraActive}
          enableTorch={torch && facing === 'back'}
          facing={facing}
          mode="video"
          mute={false}
          onCameraReady={() => {
            setCameraReady(true);
            setPauseSupported(
              cameraRef.current?.getSupportedFeatures().toggleRecordingAsyncAvailable ?? false,
            );
          }}
          onMountError={(event) => setError(event.message)}
          style={StyleSheet.absoluteFill}
          videoQuality="720p"
        />
      ) : (
        <View style={styles.permissionPanel}>
          <Ionicons color="#FFFFFF" name="camera-outline" size={42} />
          <Text style={styles.permissionTitle}>Camera access required</Text>
          <Text style={styles.permissionText}>
            Allow camera and microphone access to record this room with narration.
          </Text>
          <AppButton
            label={canAskForPermissions ? 'Enable camera & microphone' : 'Open device settings'}
            onPress={() => void requestPermissions()}
          />
        </View>
      )}

      <View style={styles.topScrim} />
      <View style={styles.bottomScrim} />

      <SafeAreaView edges={['top', 'bottom']} style={styles.cameraChrome}>
        <View style={styles.topBar}>
          <CameraIconButton
            accessibilityLabel={recording ? 'Cancel recording' : 'Return to room details'}
            icon="chevron-back"
            onPress={() => (recording ? setCancelOpen(true) : router.back())}
          />
          <View style={styles.roomContext}>
            <Text numberOfLines={1} style={styles.room}>
              {room.data?.name ?? 'Room'}
            </Text>
            <Text style={styles.captureMode}>
              {isAdditionalVideo ? 'Additional evidence clip' : 'Primary room walkthrough'}
            </Text>
          </View>
          <CameraIconButton
            accessibilityLabel={torch ? 'Turn torch off' : 'Turn torch on'}
            disabled={!hasPermissions || facing === 'front'}
            icon={torch ? 'flash' : 'flash-off'}
            onPress={() => setTorch((value) => !value)}
            selected={torch}
          />
          <CameraIconButton
            accessibilityLabel="Switch camera"
            disabled={!hasPermissions || recording}
            icon="camera-reverse-outline"
            onPress={() => setFacing((value) => (value === 'back' ? 'front' : 'back'))}
          />
        </View>

        <View style={styles.captureViewport}>
          {hasPermissions ? (
            <View style={styles.recordingReadout}>
              <View style={[styles.statusDot, recording && !paused && styles.statusDotActive]} />
              <Text style={styles.timer}>{formatTimer(seconds)}</Text>
              <Text style={styles.recordStatus}>
                {stopping ? 'SAVING' : recording ? (paused ? 'PAUSED' : 'REC') : 'READY'}
              </Text>
            </View>
          ) : null}

          {recording && !isAdditionalVideo ? (
            <View style={styles.guidedOverlay}>
              <GuidedCaptureOverlay
                tracker={guidedSensor.tracker}
                sensorAvailable={guidedSensor.authorized}
                returnedToStart={returnedToStart(guidedSensor.tracker)}
              />
            </View>
          ) : null}

          {error ? (
            <View style={styles.errorToast}>
              <Ionicons color="#FFD1D1" name="alert-circle" size={18} />
              <Text accessibilityRole="alert" style={styles.error}>
                {error}
              </Text>
            </View>
          ) : null}
          {snapshotMessage ? (
            <View style={styles.messageToast}>
              <Ionicons color="#CFF5DE" name="checkmark-circle" size={18} />
              <Text accessibilityLiveRegion="polite" style={styles.snapshotMessage}>
                {snapshotMessage}
              </Text>
            </View>
          ) : null}
        </View>

        <View style={styles.controlDeck}>
          {isAdditionalVideo && !recording ? (
            <View style={styles.additionalStrip}>
              <Ionicons color="#FFE0A6" name="layers-outline" size={16} />
              <Text style={styles.additionalStripText}>Extra clip — label it after recording</Text>
            </View>
          ) : null}

          <View style={styles.evidenceBar}>
            <Pressable
              accessibilityLabel="Choose snapshot evidence type"
              accessibilityRole="button"
              onPress={() => setCaptureTypeOpen(true)}
              style={({ pressed }) => [styles.evidenceSelector, pressed && styles.pressed]}
            >
              <Ionicons color="#FFFFFF" name="images-outline" size={17} />
              <View style={styles.evidenceSelectorCopy}>
                <Text style={styles.evidenceEyebrow}>NEXT SNAPSHOT</Text>
                <Text numberOfLines={1} style={styles.evidenceType}>
                  {CAPTURE_TYPE_LABELS[captureType] ?? 'Evidence'}
                </Text>
              </View>
              <Ionicons color="#C6D2D0" name="chevron-down" size={15} />
            </Pressable>
            <View style={styles.evidenceCount}>
              <Text style={styles.evidenceCountValue}>{sessionPhotoCount}</Text>
              <Text style={styles.evidenceCountLabel}>photos</Text>
            </View>
            <View style={styles.evidenceCount}>
              <Text style={styles.evidenceCountValue}>{findingCount}</Text>
              <Text style={styles.evidenceCountLabel}>findings</Text>
            </View>
          </View>

          <View style={styles.mainControls}>
            <CameraControl
              disabled={!hasPermissions || !cameraReady || capturingSnapshot}
              icon="camera"
              label={capturingSnapshot ? 'Saving' : 'Snapshot'}
              loading={capturingSnapshot}
              onPress={() => void takeSnapshot()}
            />

            <View style={styles.recordControlWrap}>
              <Pressable
                accessibilityLabel={
                  stopping
                    ? 'Saving room video'
                    : recording
                      ? 'Stop and review video'
                      : 'Start recording'
                }
                accessibilityRole="button"
                accessibilityState={{
                  busy: stopping,
                  disabled: !hasPermissions || !cameraReady || capturingSnapshot || stopping,
                }}
                disabled={!hasPermissions || !cameraReady || capturingSnapshot || stopping}
                onPress={recording ? stopRecording : startRecording}
                style={({ pressed }) => [
                  styles.recordControl,
                  pressed && styles.recordControlPressed,
                  (!hasPermissions || !cameraReady || stopping) && styles.controlDisabled,
                ]}
              >
                {stopping ? (
                  <ActivityIndicator color="#FFFFFF" size="small" />
                ) : (
                  <View
                    style={[
                      styles.recordControlInner,
                      recording && styles.recordControlInnerRecording,
                    ]}
                  />
                )}
              </Pressable>
              <Text style={styles.cameraControlLabel}>
                {stopping ? 'Saving…' : recording ? 'Stop & review' : 'Record'}
              </Text>
            </View>

            {recording ? (
              <CameraControl icon="flag" label="Mark finding" onPress={markFinding} />
            ) : (
              <CameraControl
                icon="information-circle-outline"
                label="Guide"
                onPress={() => setVideoGuideOpen(true)}
              />
            )}
          </View>

          <View style={styles.utilityBar}>
            {latestSnapshot ? (
              <Image
                accessibilityLabel="Latest saved photo"
                source={{ uri: latestSnapshot.uri }}
                style={styles.snapshotThumbnail}
              />
            ) : (
              <View style={styles.snapshotPlaceholder}>
                <Ionicons color="#95A7A4" name="image-outline" size={17} />
              </View>
            )}
            <View style={styles.mic}>
              <View style={[styles.micDot, hasPermissions && styles.micDotActive]} />
              <Text style={styles.micText}>{hasPermissions ? 'Mic on' : 'Mic unavailable'}</Text>
            </View>
            {sensorNotice && !recording ? (
              <Text numberOfLines={1} style={styles.sensorNotice}>
                {sensorNotice}
              </Text>
            ) : null}
            {recording && pauseSupported ? (
              <Pressable
                accessibilityLabel={paused ? 'Resume recording' : 'Pause recording'}
                accessibilityRole="button"
                disabled={stopping}
                onPress={() => void togglePause()}
                style={({ pressed }) => [styles.utilityAction, pressed && styles.pressed]}
              >
                <Ionicons color="#FFFFFF" name={paused ? 'play' : 'pause'} size={16} />
                <Text style={styles.utilityActionText}>{paused ? 'Resume' : 'Pause'}</Text>
              </Pressable>
            ) : null}
            {!recording && failedPhotos.length ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => failedPhotos.forEach((photo) => void uploadSnapshot(photo))}
                style={({ pressed }) => [styles.utilityAction, pressed && styles.pressed]}
              >
                <Ionicons color="#FFD9A8" name="cloud-upload-outline" size={16} />
                <Text style={styles.retryText}>Retry {failedPhotos.length}</Text>
              </Pressable>
            ) : null}
            {environment.enableTestVideoPicker && !recording ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => void pickTestVideo()}
                style={({ pressed }) => [styles.utilityAction, pressed && styles.pressed]}
              >
                <Text style={styles.utilityActionText}>Test video</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      </SafeAreaView>

      <CaptureIntroModal
        isOutdoorArea={isOutdoorArea}
        onCancel={() => router.back()}
        onContinue={() => void prepareCapture()}
        preparing={preparing}
        roomName={room.data?.name ?? 'this room'}
        visible={!prepared}
      />
      <CaptureTypeModal
        onClose={() => setCaptureTypeOpen(false)}
        onPhotoGuide={() => {
          setCaptureTypeOpen(false);
          setGuideOpen(true);
        }}
        onSelect={(value) => {
          setCaptureType(value);
          setCaptureTypeOpen(false);
        }}
        selected={captureType}
        visible={captureTypeOpen}
      />
      <PhotoGuidanceModal visible={guideOpen} onClose={() => setGuideOpen(false)} />
      <VideoGuideModal
        visible={videoGuideOpen}
        onClose={() => setVideoGuideOpen(false)}
        title={isOutdoorArea ? 'Outdoor recording guide' : 'Indoor recording guide'}
        steps={videoSteps}
      />
      <ConfirmationModal
        confirmLabel="Discard"
        destructive
        message="The unsaved room video and timer will be discarded."
        onCancel={() => setCancelOpen(false)}
        onConfirm={discardAndLeave}
        title="Cancel this recording?"
        visible={cancelOpen}
      />
    </View>
  );
}

function formatTimer(seconds: number) {
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

type IoniconName = ComponentProps<typeof Ionicons>['name'];

function CameraIconButton({
  accessibilityLabel,
  disabled = false,
  icon,
  onPress,
  selected = false,
}: {
  accessibilityLabel: string;
  disabled?: boolean;
  icon: IoniconName;
  onPress: () => void;
  selected?: boolean;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.cameraIconButton,
        selected && styles.cameraIconButtonSelected,
        disabled && styles.controlDisabled,
        pressed && styles.pressed,
      ]}
    >
      <Ionicons color="#FFFFFF" name={icon} size={22} />
    </Pressable>
  );
}

function CameraControl({
  disabled = false,
  icon,
  label,
  loading = false,
  onPress,
}: {
  disabled?: boolean;
  icon: IoniconName;
  label: string;
  loading?: boolean;
  onPress: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.cameraControlWrap}>
      <Pressable
        accessibilityLabel={label}
        accessibilityRole="button"
        accessibilityState={{ busy: loading, disabled }}
        disabled={disabled}
        onPress={onPress}
        style={({ pressed }) => [
          styles.cameraControl,
          disabled && styles.controlDisabled,
          pressed && styles.pressed,
        ]}
      >
        {loading ? (
          <ActivityIndicator color="#FFFFFF" size="small" />
        ) : (
          <Ionicons color="#FFFFFF" name={icon} size={25} />
        )}
      </Pressable>
      <Text numberOfLines={1} style={styles.cameraControlLabel}>
        {label}
      </Text>
    </View>
  );
}

function CaptureIntroModal({
  isOutdoorArea,
  onCancel,
  onContinue,
  preparing,
  roomName,
  visible,
}: {
  isOutdoorArea: boolean;
  onCancel: () => void;
  onContinue: () => void;
  preparing: boolean;
  roomName: string;
  visible: boolean;
}) {
  const styles = useThemedStyles(createStyles);
  const steps = isOutdoorArea
    ? ['Start at your reference edge.', 'Sweep clockwise and narrate.', 'Snapshot visible issues.']
    : [
        'Start at the entrance facing Wall 1.',
        'Turn clockwise and narrate.',
        'Snapshot visible issues.',
      ];
  return (
    <Modal
      animationType="fade"
      onRequestClose={onCancel}
      statusBarTranslucent
      transparent
      visible={visible}
    >
      <View style={styles.introBackdrop}>
        <View style={styles.introCard}>
          <View style={styles.introHandle} />
          <Text style={styles.introEyebrow}>ONE-TIME CAPTURE GUIDE</Text>
          <Text style={styles.introTitle}>Ready to record {roomName}?</Text>
          <Text style={styles.introBody}>
            Keep the camera moving slowly. You can take snapshots without stopping the video.
          </Text>
          <View style={styles.introSteps}>
            {steps.map((step, index) => (
              <View key={step} style={styles.introStep}>
                <View style={styles.introStepNumber}>
                  <Text style={styles.introStepNumberText}>{index + 1}</Text>
                </View>
                <Text style={styles.introStepText}>{step}</Text>
              </View>
            ))}
          </View>
          <View style={styles.introNote}>
            <Ionicons color="#BFEA94" name="shield-checkmark-outline" size={18} />
            <Text style={styles.introNoteText}>
              Motion estimates coverage. Your photos and review confirm it.
            </Text>
          </View>
          <AppButton
            label={preparing ? 'Opening camera…' : 'Set Wall 1 & open camera'}
            loading={preparing}
            onPress={onContinue}
          />
          <AppButton disabled={preparing} label="Cancel" onPress={onCancel} variant="ghost" />
        </View>
      </View>
    </Modal>
  );
}

function CaptureTypeModal({
  onClose,
  onPhotoGuide,
  onSelect,
  selected,
  visible,
}: {
  onClose: () => void;
  onPhotoGuide: () => void;
  onSelect: (value: PhotoCaptureType) => void;
  selected: PhotoCaptureType;
  visible: boolean;
}) {
  const styles = useThemedStyles(createStyles);
  const [draft, setDraft] = useState<PhotoCaptureType>(selected);
  useEffect(() => {
    if (visible) setDraft(selected);
  }, [selected, visible]);
  return (
    <Modal animationType="slide" onRequestClose={onClose} transparent visible={visible}>
      <Pressable accessibilityRole="button" onPress={onClose} style={styles.guideBackdrop}>
        <SafeAreaView edges={['bottom']} style={styles.captureTypeSafeArea}>
          <Pressable style={styles.captureTypeSheet}>
            <View style={styles.sheetHandle} />
            <View style={styles.captureTypeHeader}>
              <View style={styles.captureTypeHeaderCopy}>
                <Text style={styles.guideTitle}>Snapshot type</Text>
                <Text style={styles.captureTypeDescription}>
                  Choose what the next snapshot documents.
                </Text>
              </View>
              <CameraIconButton accessibilityLabel="Close snapshot type" icon="close" onPress={onClose} />
            </View>
            <RadioGroup
              value={draft}
              onValueChange={(value) => setDraft(value as PhotoCaptureType)}
              className="gap-2"
            >
              {CAPTURE_TYPE_OPTIONS.map((option) => {
                const isSelected = draft === option.value;
                return (
                  <Pressable
                    key={option.value}
                    onPress={() => setDraft(option.value)}
                    style={[
                      styles.captureTypeOption,
                      isSelected && styles.captureTypeOptionSelected,
                    ]}
                  >
                    <RadioGroupItem
                      id={`snapshot-${option.value}`}
                      value={option.value}
                      accessibilityLabel={option.label}
                    />
                    <Label
                      nativeID={`snapshot-${option.value}`}
                      onPress={() => setDraft(option.value)}
                      className="flex-1 text-base font-extrabold"
                    >
                      {option.label}
                    </Label>
                  </Pressable>
                );
              })}
            </RadioGroup>
            <View style={styles.captureTypeActions}>
              <AppButton label="Photo tips" onPress={onPhotoGuide} variant="ghost" compact />
              <View style={styles.captureTypeActionButtons}>
                <AppButton label="Cancel" onPress={onClose} variant="outline" compact />
                <AppButton
                  label="Use selection"
                  onPress={() => onSelect(draft)}
                  compact
                />
              </View>
            </View>
          </Pressable>
        </SafeAreaView>
      </Pressable>
    </Modal>
  );
}

function VideoGuideModal({
  visible,
  onClose,
  title,
  steps,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  steps: readonly string[];
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.guideBackdrop}>
        <View style={styles.guideSheet}>
          <Text style={styles.guideTitle}>{title}</Text>
          <ScrollView contentContainerStyle={styles.guideList}>
            {steps.map((line, index) => (
              <View key={index} style={styles.guideItem}>
                <Text style={styles.guideBullet}>{index + 1}.</Text>
                <Text style={styles.guideText}>{line}</Text>
              </View>
            ))}
          </ScrollView>
          <AppButton label="Start when ready" onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}

function PhotoGuidanceModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const styles = useThemedStyles(createStyles);
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.guideBackdrop}>
        <View style={styles.guideSheet}>
          <Text style={styles.guideTitle}>How to photograph</Text>
          <ScrollView contentContainerStyle={styles.guideList}>
            {PHOTO_GUIDANCE.map((line, index) => (
              <View key={index} style={styles.guideItem}>
                <Text style={styles.guideBullet}>{index + 1}.</Text>
                <Text style={styles.guideText}>{line}</Text>
              </View>
            ))}
          </ScrollView>
          <AppButton label="Got it" onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}

const createStyles = (colors: AppColors) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: '#050A0A' },
    topScrim: {
      position: 'absolute',
      top: 0,
      right: 0,
      left: 0,
      height: 132,
      backgroundColor: 'rgba(3,9,9,0.58)',
    },
    bottomScrim: {
      position: 'absolute',
      right: 0,
      bottom: 0,
      left: 0,
      height: 260,
      backgroundColor: 'rgba(3,9,9,0.82)',
    },
    cameraChrome: {
      flex: 1,
      justifyContent: 'space-between',
    },
    topBar: {
      minHeight: 58,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs,
    },
    roomContext: { flex: 1, minWidth: 0, paddingHorizontal: spacing.xs },
    room: { ...typography.heading, color: colors.white, fontSize: 20 },
    captureMode: { ...typography.caption, color: '#C6D2D0', marginTop: 1 },
    cameraIconButton: {
      width: 44,
      height: 44,
      borderRadius: 22,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'rgba(6,16,15,0.56)',
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.18)',
    },
    cameraIconButtonSelected: {
      backgroundColor: 'rgba(134,210,57,0.25)',
      borderColor: 'rgba(166,229,103,0.75)',
    },
    captureViewport: {
      flex: 1,
      minHeight: 120,
      position: 'relative',
      alignItems: 'center',
    },
    permissionPanel: {
      ...StyleSheet.absoluteFillObject,
      zIndex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.md,
      padding: spacing.xl,
      backgroundColor: '#122321',
    },
    permissionTitle: { ...typography.heading, color: colors.white, textAlign: 'center' },
    permissionText: {
      ...typography.body,
      maxWidth: 360,
      color: '#D7E2E0',
      textAlign: 'center',
    },
    recordingReadout: {
      position: 'absolute',
      top: spacing.sm,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 7,
      borderRadius: radius.round,
      backgroundColor: 'rgba(5,12,12,0.68)',
      paddingHorizontal: spacing.md,
      paddingVertical: 7,
    },
    statusDot: {
      width: 7,
      height: 7,
      borderRadius: 4,
      backgroundColor: '#8C9B99',
    },
    statusDotActive: { backgroundColor: '#FF4A4A' },
    timer: {
      color: colors.white,
      fontSize: 17,
      fontWeight: '800',
      fontVariant: ['tabular-nums'],
    },
    recordStatus: {
      color: '#E5EFED',
      fontSize: 10,
      fontWeight: '900',
      letterSpacing: 1,
    },
    guidedOverlay: {
      position: 'absolute',
      top: 50,
      right: 0,
      bottom: spacing.sm,
      left: 0,
    },
    errorToast: {
      position: 'absolute',
      right: spacing.md,
      bottom: spacing.md,
      left: spacing.md,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      borderRadius: radius.md,
      backgroundColor: 'rgba(104,21,21,0.92)',
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
    error: { ...typography.caption, flex: 1, color: '#FFD1D1' },
    messageToast: {
      position: 'absolute',
      right: spacing.md,
      bottom: spacing.md,
      left: spacing.md,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      borderRadius: radius.md,
      backgroundColor: 'rgba(8,60,40,0.92)',
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
    snapshotMessage: { ...typography.caption, flex: 1, color: '#CFF5DE' },
    controlDeck: {
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      paddingTop: spacing.sm,
      paddingBottom: spacing.xs,
      backgroundColor: 'rgba(3,9,9,0.9)',
      borderTopWidth: 1,
      borderTopColor: 'rgba(255,255,255,0.12)',
    },
    additionalStrip: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.xs,
      borderRadius: radius.round,
      paddingVertical: 5,
      backgroundColor: 'rgba(245,158,11,0.18)',
    },
    additionalStripText: { ...typography.caption, color: '#FFE0A6', fontWeight: '700' },
    evidenceBar: {
      minHeight: 44,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    evidenceSelector: {
      minWidth: 0,
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      borderRadius: radius.md,
      paddingHorizontal: spacing.sm,
      paddingVertical: 6,
      backgroundColor: 'rgba(255,255,255,0.1)',
    },
    evidenceSelectorCopy: { flex: 1, minWidth: 0 },
    evidenceEyebrow: {
      color: '#AFC0BD',
      fontSize: 8,
      fontWeight: '900',
      letterSpacing: 0.9,
    },
    evidenceType: {
      color: colors.white,
      fontSize: 13,
      fontWeight: '800',
      textTransform: 'capitalize',
    },
    evidenceCount: { minWidth: 42, alignItems: 'center' },
    evidenceCountValue: {
      color: colors.white,
      fontSize: 15,
      fontWeight: '900',
      fontVariant: ['tabular-nums'],
    },
    evidenceCountLabel: { color: '#AFC0BD', fontSize: 9 },
    mainControls: {
      minHeight: 90,
      flexDirection: 'row',
      alignItems: 'flex-start',
      justifyContent: 'space-around',
      paddingHorizontal: spacing.md,
    },
    cameraControlWrap: { width: 82, alignItems: 'center', gap: 5 },
    cameraControl: {
      width: 54,
      height: 54,
      borderRadius: 27,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'rgba(255,255,255,0.12)',
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.24)',
    },
    cameraControlLabel: {
      maxWidth: 88,
      color: '#EEF5F3',
      fontSize: 10,
      fontWeight: '700',
      textAlign: 'center',
    },
    recordControlWrap: { width: 110, alignItems: 'center', gap: 5 },
    recordControl: {
      width: 68,
      height: 68,
      borderRadius: 34,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 4,
      borderColor: '#FFFFFF',
      backgroundColor: 'rgba(0,0,0,0.18)',
    },
    recordControlPressed: { transform: [{ scale: 0.96 }] },
    recordControlInner: {
      width: 52,
      height: 52,
      borderRadius: 26,
      backgroundColor: '#F04444',
    },
    recordControlInnerRecording: {
      width: 25,
      height: 25,
      borderRadius: 6,
    },
    controlDisabled: { opacity: 0.42 },
    pressed: { opacity: 0.72 },
    utilityBar: {
      minHeight: 32,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    snapshotThumbnail: {
      width: 32,
      height: 32,
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.45)',
    },
    snapshotPlaceholder: {
      width: 32,
      height: 32,
      borderRadius: radius.sm,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.16)',
      backgroundColor: 'rgba(255,255,255,0.06)',
    },
    mic: { flexDirection: 'row', alignItems: 'center', gap: 5 },
    micDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#7C8D8A' },
    micDotActive: { backgroundColor: '#86D239' },
    micText: { color: '#C6D2D0', fontSize: 10, fontWeight: '700' },
    sensorNotice: { flex: 1, color: '#C6D2D0', fontSize: 10 },
    utilityAction: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      marginLeft: 'auto',
      borderRadius: radius.round,
      paddingHorizontal: spacing.sm,
      paddingVertical: 6,
      backgroundColor: 'rgba(255,255,255,0.08)',
    },
    utilityActionText: { color: colors.white, fontSize: 10, fontWeight: '800' },
    retryText: { color: '#FFD9A8', fontSize: 10, fontWeight: '800' },
    introBackdrop: {
      flex: 1,
      justifyContent: 'flex-end',
      backgroundColor: 'rgba(0,0,0,0.62)',
    },
    introCard: {
      width: '100%',
      maxWidth: 560,
      alignSelf: 'center',
      gap: spacing.md,
      borderTopLeftRadius: 28,
      borderTopRightRadius: 28,
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.sm,
      paddingBottom: spacing.lg,
      backgroundColor: '#101D1C',
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.12)',
    },
    introHandle: {
      width: 42,
      height: 4,
      alignSelf: 'center',
      borderRadius: 2,
      backgroundColor: 'rgba(255,255,255,0.26)',
    },
    introEyebrow: {
      color: '#9FD665',
      fontSize: 10,
      fontWeight: '900',
      letterSpacing: 1.2,
    },
    introTitle: { ...typography.title, color: colors.white, fontSize: 25 },
    introBody: { ...typography.body, color: '#C9D6D4', lineHeight: 22 },
    introSteps: { gap: spacing.sm },
    introStep: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    introStepNumber: {
      width: 28,
      height: 28,
      borderRadius: 14,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'rgba(134,210,57,0.16)',
    },
    introStepNumberText: { color: '#BFEA94', fontSize: 12, fontWeight: '900' },
    introStepText: { ...typography.body, flex: 1, color: '#EEF5F3', fontWeight: '700' },
    introNote: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      borderRadius: radius.md,
      padding: spacing.sm,
      backgroundColor: 'rgba(134,210,57,0.1)',
    },
    introNoteText: { ...typography.caption, flex: 1, color: '#D4E8C0' },
    guideBackdrop: {
      flex: 1,
      justifyContent: 'flex-end',
      backgroundColor: 'rgba(0,0,0,0.62)',
    },
    guideSheet: {
      width: '100%',
      maxWidth: 620,
      maxHeight: '80%',
      alignSelf: 'center',
      gap: spacing.sm,
      borderTopLeftRadius: radius.lg,
      borderTopRightRadius: radius.lg,
      padding: spacing.lg,
      backgroundColor: colors.surface,
    },
    guideTitle: { ...typography.title, color: colors.textPrimary },
    guideList: { gap: spacing.sm, paddingBottom: spacing.sm },
    guideItem: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' },
    guideBullet: { ...typography.body, color: colors.primary, fontWeight: '800' },
    guideText: { ...typography.body, flex: 1, color: colors.textPrimary },
    captureTypeSheet: {
      width: '100%',
      maxWidth: 560,
      maxHeight: '88%',
      alignSelf: 'center',
      gap: spacing.sm,
      borderTopLeftRadius: radius.lg,
      borderTopRightRadius: radius.lg,
      padding: spacing.lg,
      backgroundColor: colors.surface,
    },
    captureTypeSafeArea: {
      width: '100%',
      maxWidth: 560,
      alignSelf: 'center',
      backgroundColor: colors.surface,
      borderTopLeftRadius: radius.lg,
      borderTopRightRadius: radius.lg,
    },
    captureTypeHeader: {
      minWidth: 0,
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.sm,
    },
    captureTypeHeaderCopy: { flex: 1, minWidth: 0, gap: spacing.xs },
    sheetHandle: {
      width: 42,
      height: 4,
      alignSelf: 'center',
      marginBottom: spacing.xs,
      borderRadius: 2,
      backgroundColor: colors.border,
    },
    captureTypeDescription: { ...typography.body, color: colors.textSecondary },
    captureTypeOption: {
      minHeight: 52,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: spacing.md,
      backgroundColor: colors.surfaceMuted,
    },
    captureTypeOptionSelected: {
      borderColor: colors.primary,
      backgroundColor: colors.primarySoft,
    },
    captureTypeActions: {
      gap: spacing.sm,
      paddingTop: spacing.xs,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
    },
    captureTypeActionButtons: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      gap: spacing.sm,
    },
  });
