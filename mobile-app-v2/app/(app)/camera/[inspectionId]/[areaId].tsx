import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CameraView,
  type CameraType,
  useCameraPermissions,
  useMicrophonePermissions,
} from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { CameraIcon, CheckIcon } from 'lucide-react-native';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  CameraControls,
  CameraHeader,
  CameraStatusBar,
  CaptureInfoRow,
  FramingGuide,
  RecordingStatusPill,
} from '@/src/capture/camera-chrome';
import { computeCameraLayout, SPACING } from '@/src/capture/camera-layout';
import { GuideSheet, SNAPSHOT_TYPES, SnapshotTypeSheet } from '@/src/capture/CameraSheets';
import { deriveGuidance, shouldPulse, type GuidanceStep } from '@/src/capture/guidance-state';
import {
  evaluateCapture,
  GUIDED_CAPTURE_POLICY,
  returnedToStart,
  type FindingMarker,
  type GuidedCaptureSummary,
} from '@/src/capture/guided-capture';
import {
  isPrimaryWalkthrough,
  purposeByValue,
  RECORDING_TYPE_BY_MODE,
  resolveRecordingMode,
} from '@/src/capture/recording-mode';
import { RotationGuidance } from '@/src/capture/RotationGuidance';
import { useGuidedCaptureSensor } from '@/src/capture/use-guided-capture';
import type { AdditionalVideoCategory, PhotoCaptureType, RoomSnapshot } from '@/src/domain/models';
import { useRoom, useRoomMedia } from '@/src/features/queries';
import { announce } from '@/src/lib/announce';
import { registerIcons } from '@/src/lib/icons';
import { buildRecordingDraft, persistRecording } from '@/src/media/local-recordings';
import { buildRoomSnapshot, persistRoomSnapshot } from '@/src/media/local-snapshots';
import { uploadRoomPhoto } from '@/src/media/photo-upload';
import { useDemoStore } from '@/src/stores/demo.store';
import { useNetworkStore } from '@/src/stores/network.store';

registerIcons(CameraIcon, CheckIcon);

const MAX_RECORDING_SECONDS = 10 * 60;

function formatDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

const snapshotLabel = (value: PhotoCaptureType) =>
  SNAPSHOT_TYPES.find((type) => type.value === value)?.label ?? 'Area overview';

export default function RoomCameraScreen() {
  const {
    inspectionId = '',
    areaId = '',
    recordingType,
    purpose,
    findingId,
  } = useLocalSearchParams<{
    inspectionId: string;
    areaId: string;
    recordingType?: string;
    purpose?: string;
    findingId?: string;
  }>();
  const room = useRoom(areaId);
  const media = useRoomMedia(areaId);
  const insets = useSafeAreaInsets();
  const { height: screenHeight, width: screenWidth } = useWindowDimensions();

  const [camera, setCamera] = useState<CameraView | null>(null);
  const secondsRef = useRef(0);
  const mountedRef = useRef(true);
  const sessionIdRef = useRef(`capture-${Date.now()}`);
  const startedAtRef = useRef<string | null>(null);
  const lastStepRef = useRef<GuidanceStep | null>(null);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [microphonePermission, requestMicrophonePermission] = useMicrophonePermissions();
  const [ready, setReady] = useState(false);
  const [recording, setRecording] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [torch, setTorch] = useState(false);
  const [facing, setFacing] = useState<CameraType>('back');
  const [captureType, setCaptureType] = useState<PhotoCaptureType>('AREA_OVERVIEW');
  const [photoCount, setPhotoCount] = useState(0);
  const [findingMarkers, setFindingMarkers] = useState<FindingMarker[]>([]);
  const [capturingPhoto, setCapturingPhoto] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [startConfirmed, setStartConfirmed] = useState(false);
  const [typeSheetOpen, setTypeSheetOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [headerHeight, setHeaderHeight] = useState(64);
  const [bottomStackHeight, setBottomStackHeight] = useState(232);

  const setDraft = useDemoStore((state) => state.setDraftRecording);
  const addSnapshot = useDemoStore((state) => state.addSnapshot);
  const updateSnapshot = useDemoStore((state) => state.updateSnapshot);
  const ownerUserId = useDemoStore((state) => state.selectedUserId ?? undefined);
  const isOnline = useNetworkStore((state) => state.isOnline);

  // Mode comes from the route when explicit, otherwise from whether a primary
  // walkthrough already exists — never from a display label.
  const mode = useMemo(
    () => resolveRecordingMode({ routeRecordingType: recordingType, existingMedia: media.data }),
    [recordingType, media.data],
  );
  const primary = isPrimaryWalkthrough(mode);
  const purposeDetail = purposeByValue(purpose as AdditionalVideoCategory | undefined);
  const hasPermissions = Boolean(cameraPermission?.granted && microphonePermission?.granted);

  // Motion only runs for the primary walkthrough, and only while recording.
  const sensor = useGuidedCaptureSensor(primary && recording);
  const sensorSupported = primary && sensor.available !== false && sensor.authorized;

  const layout = useMemo(
    () =>
      computeCameraLayout({
        screenHeight,
        screenWidth,
        topInset: insets.top,
        bottomInset: insets.bottom,
        headerHeight,
        bottomStackHeight,
      }),
    [screenHeight, screenWidth, insets.top, insets.bottom, headerHeight, bottomStackHeight],
  );

  const guidance = useMemo(
    () =>
      deriveGuidance({
        tracker: sensor.tracker,
        sensorSupported,
        recording,
        startConfirmed: !primary || startConfirmed,
        durationSeconds: seconds,
        nowMs: sensor.tracker.lastSampleAtMs,
      }),
    [sensor.tracker, sensorSupported, recording, primary, startConfirmed, seconds],
  );

  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled()
      .then(setReduceMotion)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (primary) void sensor.requestAccess();
  }, [primary, sensor]);

  // One tap per notable transition, never a repeating buzz.
  useEffect(() => {
    if (!recording) return;
    if (shouldPulse(lastStepRef.current, guidance.step)) {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
    }
    lastStepRef.current = guidance.step;
  }, [guidance.step, recording]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      camera?.stopRecording();
    };
  }, [camera]);

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

  /** Summary persisted with the recording. Shape is fixed by the upload contract. */
  const buildCaptureSummary = useCallback((): GuidedCaptureSummary | undefined => {
    if (!primary) return undefined;
    const tracker = sensor.trackerRef.current;
    const durationSeconds = Math.max(1, secondsRef.current);
    const evaluation = evaluateCapture({ tracker, durationSeconds, sensorSupported });
    return {
      sessionId: sessionIdRef.current,
      policyVersion: GUIDED_CAPTURE_POLICY.version,
      startedAt: startedAtRef.current ?? new Date().toISOString(),
      completedAt: new Date().toISOString(),
      durationSeconds,
      clockwiseRotationDegrees: Math.round(tracker.clockwiseRotationDegrees),
      counterClockwiseRotationDegrees: Math.round(tracker.counterClockwiseRotationDegrees),
      startHeadingDegrees: tracker.startHeadingDegrees,
      endHeadingDegrees: tracker.endHeadingDegrees,
      returnedToStart: returnedToStart(tracker),
      sensorSupported,
      sensorConfidence: evaluation.confidence,
      coverageStatus: evaluation.status,
      manualConfirmation: false,
      // Rotation guidance is not evidence completeness — the review screen and
      // the area's own requirements decide that.
      evidenceComplete: false,
      snapshotCount: photoCount,
      findingMarkerCount: findingMarkers.length,
    };
  }, [primary, sensor.trackerRef, sensorSupported, photoCount, findingMarkers.length]);

  const beginRecording = async () => {
    if (!(await requestPermissions())) return;
    if (!camera || !ready || recording) return;
    setError(null);
    secondsRef.current = 0;
    setSeconds(0);
    sessionIdRef.current = `capture-${Date.now()}`;
    startedAtRef.current = new Date().toISOString();
    lastStepRef.current = null;
    sensor.reset();
    setRecording(true);
    setStopping(false);
    announce(
      primary
        ? 'Recording started. Move slowly clockwise and narrate as you go.'
        : 'Recording started. Narrate the evidence you are capturing.',
    );
    try {
      const result = await camera.recordAsync({
        maxDuration: MAX_RECORDING_SECONDS,
        ...(Platform.OS === 'ios' ? { codec: 'avc1' as const } : {}),
      });
      if (!result || !mountedRef.current) return;
      const stored = persistRecording(result.uri, inspectionId, areaId);
      setDraft(
        buildRecordingDraft({
          ownerUserId,
          inspectionId,
          roomId: areaId,
          uri: stored.uri,
          durationSeconds: Math.max(1, secondsRef.current),
          sizeBytes: stored.sizeBytes,
          recordingType: RECORDING_TYPE_BY_MODE[mode],
          label: purposeDetail?.label,
          category: purposeDetail?.value,
          relatedFindingId: findingId,
          captureSummary: buildCaptureSummary(),
        }),
      );
      router.replace({
        pathname: '/(app)/recording-review/[inspectionId]/[areaId]',
        params: { inspectionId, areaId },
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The video could not be recorded.');
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

  const uploadSnapshot = async (snapshot: RoomSnapshot) => {
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
      });
      updateSnapshot(snapshot.id, { uploadStatus: 'UPLOADED', serverPhotoId: uploaded.id });
    } catch {
      updateSnapshot(snapshot.id, { uploadStatus: 'FAILED' });
    }
  };

  const takeSnapshot = async () => {
    if (!camera || !ready || !hasPermissions || capturingPhoto) return;
    if (recording && Platform.OS === 'android') {
      setError('On Android, pause after the video to take a still photo for this room.');
      return;
    }
    setCapturingPhoto(true);
    setError(null);
    try {
      const photo = await camera.takePictureAsync({ quality: 0.82, shutterSound: false });
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
        recordingSessionId: recording ? sessionIdRef.current : undefined,
        videoTimestampMs: recording ? secondsRef.current * 1000 : undefined,
        captureSource:
          recording && Platform.OS === 'ios'
            ? 'NATIVE_STILL_DURING_VIDEO'
            : 'SEPARATE_PHOTO_CAPTURE',
        sequenceNumber: photoCount + 1,
        findingId,
      });
      addSnapshot(snapshot);
      setPhotoCount((count) => count + 1);
      const advancedToFindingContext = captureType === 'AREA_OVERVIEW';
      if (advancedToFindingContext) setCaptureType('FINDING_CONTEXT');
      void Haptics.selectionAsync().catch(() => undefined);
      announce(
        `Photo ${photoCount + 1} saved.${
          advancedToFindingContext ? ' Next snapshot: finding context.' : ''
        }`,
      );
      void uploadSnapshot(snapshot);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The snapshot could not be saved.');
    } finally {
      setCapturingPhoto(false);
    }
  };

  /** Marks the moment without interrupting the take. Detail comes later. */
  const markFinding = () => {
    if (!recording) return;
    const marker: FindingMarker = {
      id: `marker-${Date.now()}`,
      videoTimestampMs: secondsRef.current * 1000,
      rotationDegrees: Math.round(sensor.trackerRef.current.clockwiseRotationDegrees),
      createdAt: new Date().toISOString(),
    };
    setFindingMarkers((markers) => [...markers, marker]);
    setCaptureType('FINDING_CONTEXT');
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    announce(
      `Finding marked at ${formatDuration(secondsRef.current)}. Next snapshot: finding context.`,
    );
  };

  const switchFacing = () => {
    // Guarded so repeated taps cannot stack camera reconfigurations.
    if (switching || stopping) return;
    setSwitching(true);
    setFacing((value) => (value === 'back' ? 'front' : 'back'));
    setTorch(false);
    setTimeout(() => mountedRef.current && setSwitching(false), 400);
  };

  const leaveScreen = () => {
    if (recording || stopping) {
      Alert.alert(
        'Stop recording first?',
        'Leaving now discards the take in progress. Nothing already saved is affected.',
        [
          { text: 'Keep recording', style: 'cancel' },
          { text: 'Stop and review', onPress: stopRecording },
        ],
      );
      return;
    }
    router.back();
  };

  if (!hasPermissions) {
    return (
      <View className="flex-1 items-center justify-center bg-black px-8">
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
          className="mt-6 min-h-12 justify-center rounded-xl bg-primary px-6 py-4"
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
      </View>
    );
  }

  const showGuidance = primary || guidance.step === 'SENSOR_UNAVAILABLE';

  return (
    <View className="flex-1 bg-black">
      <StatusBar style="light" />
      <CameraView
        ref={setCamera}
        style={StyleSheet.absoluteFill}
        facing={facing}
        enableTorch={torch && facing === 'back'}
        mode="video"
        mute={false}
        videoQuality="720p"
        onCameraReady={() => setReady(true)}
        onMountError={(event) => setError(event.message)}
      />

      {/* Scrims sized to the measured zones, so they never encroach on the
          preview region the framing guide occupies. */}
      <View
        pointerEvents="none"
        className="absolute inset-x-0 top-0 bg-black/40"
        style={{ height: insets.top + headerHeight }}
      />
      <View
        pointerEvents="none"
        className="absolute inset-x-0 bottom-0 bg-black/55"
        style={{ height: insets.bottom + bottomStackHeight }}
      />

      <FramingGuide layout={layout} />

      {showGuidance ? (
        <RotationGuidance
          guidance={guidance}
          layout={layout}
          reduceMotion={reduceMotion}
          showProgress={primary && sensorSupported}
        />
      ) : null}

      {/* Zone 1 — header */}
      <View className="absolute inset-x-0 top-0" style={{ paddingTop: insets.top }}>
        <CameraHeader
          areaName={room.data?.name ?? 'Area'}
          subtitle={primary ? 'Primary walkthrough' : (purposeDetail?.label ?? 'Additional evidence')}
          torch={torch}
          torchAvailable={facing === 'back'}
          facing={facing}
          switching={switching}
          onBack={leaveScreen}
          onToggleTorch={() => setTorch((value) => !value)}
          onSwitchFacing={switchFacing}
          onLayout={setHeaderHeight}
        />
        <View className="items-center" style={{ paddingTop: SPACING.xs }}>
          <RecordingStatusPill
            phase={stopping ? 'SAVING' : recording ? 'RECORDING' : 'READY'}
            elapsed={formatDuration(seconds)}
            readyDetail={
              primary
                ? startConfirmed
                  ? 'Wall 1 confirmed'
                  : 'Confirm Wall 1 to begin'
                : (purposeDetail?.label ?? 'Additional evidence')
            }
          />
        </View>
      </View>

      {/* Wall 1 confirmation gates only the guidance, never the camera. */}
      {primary && !startConfirmed && !recording ? (
        <View
          className="absolute inset-x-0 items-center px-6"
          style={{ top: layout.guide.top + layout.guide.height / 2 - 40 }}
        >
          <Pressable
            accessibilityHint="Marks your starting wall so the turn can be measured"
            accessibilityLabel="Confirm Wall 1"
            accessibilityRole="button"
            className="min-h-12 flex-row items-center rounded-2xl bg-white/95 px-5 py-3 active:opacity-80"
            style={{ gap: SPACING.sm }}
            onPress={() => {
              setStartConfirmed(true);
              void Haptics.selectionAsync().catch(() => undefined);
              announce('Wall 1 confirmed. Hold a wide view, then start recording.');
            }}
          >
            <CheckIcon size={18} className="text-black" />
            <Text className="font-bold text-black">Confirm Wall 1</Text>
          </Pressable>
        </View>
      ) : null}

      {/* Zones 3–5 — capture info, controls, status. Measured as one stack so
          the framing guide above always knows how much room it has left. */}
      <View
        className="absolute inset-x-0 bottom-0"
        style={{ paddingBottom: insets.bottom }}
        onLayout={(event) =>
          setBottomStackHeight(Math.round(event.nativeEvent.layout.height - insets.bottom))
        }
      >
        {error ? (
          <View
            accessibilityLiveRegion="assertive"
            accessibilityRole="alert"
            className="mx-4 mb-3 rounded-xl bg-red-950/85 px-4 py-2.5"
          >
            <Text className="text-center text-xs text-red-100">{error}</Text>
          </View>
        ) : null}

        <CaptureInfoRow
          nextLabel={snapshotLabel(captureType)}
          photoCount={photoCount}
          findingCount={primary ? findingMarkers.length : undefined}
          secondaryLabel={primary ? undefined : (purposeDetail?.label ?? 'Additional evidence')}
          onPressType={() => setTypeSheetOpen(true)}
        />

        <CameraControls
          recording={recording}
          saving={stopping}
          ready={ready}
          capturingPhoto={capturingPhoto}
          tertiaryLabel={primary && recording ? 'Mark finding' : 'Open guide'}
          onSnapshot={() => void takeSnapshot()}
          onToggleRecording={recording ? stopRecording : () => void beginRecording()}
          onTertiary={primary && recording ? markFinding : () => setGuideOpen(true)}
        />

        <CameraStatusBar
          micOn={Boolean(microphonePermission?.granted)}
          motionActive={primary && recording && sensorSupported}
          offline={!isOnline}
        />
      </View>

      {!ready ? (
        <View className="absolute inset-0 items-center justify-center bg-black/40">
          <ActivityIndicator color="#fff" />
        </View>
      ) : null}

      <SnapshotTypeSheet
        visible={typeSheetOpen}
        selected={captureType}
        onSelect={setCaptureType}
        onClose={() => setTypeSheetOpen(false)}
      />
      <GuideSheet
        visible={guideOpen}
        mode={mode}
        guidance={guidance}
        purpose={purpose}
        onClose={() => setGuideOpen(false)}
      />
    </View>
  );
}
