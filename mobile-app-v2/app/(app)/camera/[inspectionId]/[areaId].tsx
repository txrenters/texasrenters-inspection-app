import { useEffect, useRef, useState } from 'react';
import {
  CameraView,
  type CameraType,
  useCameraPermissions,
  useMicrophonePermissions,
} from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import {
  ArrowLeftIcon,
  CameraIcon,
  FocusIcon,
  ImageIcon,
  InfoIcon,
  RotateCcwIcon,
  SquareIcon,
  ZapIcon,
  ZapOffIcon,
} from 'lucide-react-native';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { GuidedCaptureOverlay } from '@/src/capture/GuidedCaptureOverlay';
import {
  GUIDED_CAPTURE_POLICY,
  evaluateCapture,
  guidedCaptureState,
  rotationProgress,
  type GuidedCaptureSummary,
} from '@/src/capture/guided-capture';
import { useGuidedCaptureSensor } from '@/src/capture/use-guided-capture';
import type { PhotoCaptureType, RoomSnapshot } from '@/src/domain/models';
import { useRoom } from '@/src/features/queries';
import { announce } from '@/src/lib/announce';
import { buildRecordingDraft, persistRecording } from '@/src/media/local-recordings';
import { buildRoomSnapshot, persistRoomSnapshot } from '@/src/media/local-snapshots';
import { uploadRoomPhoto } from '@/src/media/photo-upload';
import { useDemoStore } from '@/src/stores/demo.store';
import { registerIcons } from '@/src/lib/icons';

registerIcons(
  ArrowLeftIcon,
  CameraIcon,
  FocusIcon,
  ImageIcon,
  InfoIcon,
  RotateCcwIcon,
  SquareIcon,
  ZapIcon,
  ZapOffIcon,
);

const MAX_RECORDING_SECONDS = 10 * 60;

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
  const [camera, setCamera] = useState<CameraView | null>(null);
  const secondsRef = useRef(0);
  const mountedRef = useRef(true);
  // 360° walkthrough telemetry. The refs feed the capture summary attached to
  // the recording; none of them drive the visible chrome below.
  const captureSessionIdRef = useRef(newCaptureSessionId());
  const sessionStartedAtRef = useRef(new Date().toISOString());
  const snapshotTypesRef = useRef<PhotoCaptureType[]>([]);
  const motionSupportedRef = useRef(false);
  const guidanceMilestoneRef = useRef(0);
  const previousGuidanceRef = useRef<string | null>(null);
  const [motionResolved, setMotionResolved] = useState(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [microphonePermission, requestMicrophonePermission] = useMicrophonePermissions();
  const [ready, setReady] = useState(false);
  const [recording, setRecording] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [torch, setTorch] = useState(false);
  const [facing, setFacing] = useState<CameraType>('back');
  const [captureType, setCaptureType] = useState<PhotoCaptureType>('AREA_OVERVIEW');
  const [photoCount, setPhotoCount] = useState(0);
  const [capturingPhoto, setCapturingPhoto] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setDraft = useDemoStore((state) => state.setDraftRecording);
  const addSnapshot = useDemoStore((state) => state.addSnapshot);
  const updateSnapshot = useDemoStore((state) => state.updateSnapshot);
  const ownerUserId = useDemoStore((state) => state.selectedUserId ?? undefined);
  const isAdditional = recordingType === 'ADDITIONAL_ISSUE';
  const hasPermissions = Boolean(cameraPermission?.granted && microphonePermission?.granted);
  const guidedSensor = useGuidedCaptureSensor(recording && !isAdditional);
  const guidanceState = guidedCaptureState({
    tracker: guidedSensor.tracker,
    recording,
    sensorSupported: motionResolved ? motionSupportedRef.current : true,
    durationSeconds: seconds,
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      camera?.stopRecording();
    };
  }, [camera]);

  // Haptic tick at each quarter of the clockwise loop, heavy at completion —
  // progress a technician can feel without looking away from the room.
  useEffect(() => {
    if (!recording || isAdditional || !motionSupportedRef.current) return;
    const milestone =
      [100, 75, 50, 25].find(
        (value) => Math.round(rotationProgress(guidedSensor.tracker) * 100) >= value,
      ) ?? 0;
    if (milestone <= guidanceMilestoneRef.current) return;
    guidanceMilestoneRef.current = milestone;
    void Haptics.impactAsync(
      milestone >= 100 ? Haptics.ImpactFeedbackStyle.Heavy : Haptics.ImpactFeedbackStyle.Light,
    ).catch(() => undefined);
  }, [guidedSensor.tracker, isAdditional, recording]);

  // Spoken guidance on state *changes* only, so a screen reader hears the
  // correction once rather than on every sensor sample.
  useEffect(() => {
    if (!recording || isAdditional || previousGuidanceRef.current === guidanceState) return;
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
    } else if (guidanceState === 'COMPLETE') {
      announce('Clockwise walkthrough complete.');
    }
  }, [guidanceState, isAdditional, recording]);

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
    if (isAdditional) return undefined;
    const evaluation = evaluateCapture({
      tracker: guidedSensor.trackerRef.current,
      durationSeconds,
      sensorSupported: motionSupportedRef.current,
    });
    const hasOverview = snapshotTypesRef.current.includes('AREA_OVERVIEW');
    return {
      sessionId: captureSessionIdRef.current,
      policyVersion: GUIDED_CAPTURE_POLICY.version,
      startedAt: sessionStartedAtRef.current,
      completedAt: new Date().toISOString(),
      durationSeconds,
      clockwiseRotationDegrees: Math.round(
        guidedSensor.trackerRef.current.clockwiseRotationDegrees,
      ),
      counterClockwiseRotationDegrees: Math.round(
        guidedSensor.trackerRef.current.counterClockwiseRotationDegrees,
      ),
      startHeadingDegrees: guidedSensor.trackerRef.current.startHeadingDegrees,
      endHeadingDegrees: guidedSensor.trackerRef.current.endHeadingDegrees,
      returnedToStart: evaluation.returnedToStart,
      sensorSupported: motionSupportedRef.current,
      sensorConfidence: evaluation.confidence,
      coverageStatus: evaluation.status,
      manualConfirmation: false,
      evidenceComplete: hasOverview,
      snapshotCount: snapshotTypesRef.current.length,
      findingMarkerCount: 0,
    };
  };

  const beginRecording = async () => {
    if (!(await requestPermissions())) return;
    if (!camera || !ready || recording) return;
    setError(null);
    secondsRef.current = 0;
    setSeconds(0);
    sessionStartedAtRef.current = new Date().toISOString();
    guidanceMilestoneRef.current = 0;
    previousGuidanceRef.current = null;

    if (!isAdditional) {
      guidedSensor.reset();
      const sensorGranted = await guidedSensor.requestAccess();
      motionSupportedRef.current = sensorGranted;
      setMotionResolved(true);
      if (!sensorGranted) {
        announce('Motion guidance unavailable. Complete one slow clockwise walkthrough manually.');
      }
    }

    setRecording(true);
    setStopping(false);
    announce(
      isAdditional
        ? 'Additional evidence recording started.'
        : 'Wall 1 registered. Begin one slow clockwise walkthrough.',
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
          recordingType: isAdditional ? 'ADDITIONAL_ISSUE' : 'PRIMARY_AREA',
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
      });
      addSnapshot(snapshot);
      // Feeds evidenceComplete/snapshotCount in the capture summary.
      snapshotTypesRef.current.push(captureType);
      setPhotoCount((count) => count + 1);
      // Capturing an overview advances the selector to finding context.
      const advancedToFindingContext = captureType === 'AREA_OVERVIEW';
      if (advancedToFindingContext) setCaptureType('FINDING_CONTEXT');
      void Haptics.selectionAsync().catch(() => undefined);
      // Haptics alone do not say *what* happened, and the shutter is muted so
      // it never lands on the inspection audio. Announce the count, and the new
      // selection when it just changed underneath the technician.
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
        mode="video"
        mute={false}
        videoQuality="720p"
        onCameraReady={() => setReady(true)}
        onMountError={(event) => setError(event.message)}
      />
      <View className="absolute inset-x-0 top-0 h-44 bg-black/45" />
      <View className="absolute inset-x-0 bottom-0 h-72 bg-black/60" />
      <View
        style={{ ...StyleSheet.absoluteFillObject, pointerEvents: 'none' }}
        className="items-center justify-center"
      >
        <View className="h-[48%] w-[82%] rounded-3xl border border-white/30">
          <View className="absolute left-1/3 top-0 h-full w-px bg-white/15" />
          <View className="absolute right-1/3 top-0 h-full w-px bg-white/15" />
          <View className="absolute left-0 top-1/3 h-px w-full bg-white/15" />
          <View className="absolute bottom-1/3 left-0 h-px w-full bg-white/15" />
        </View>
      </View>
      <SafeAreaView edges={['top', 'bottom']} className="flex-1 justify-between">
        <View className="flex-row items-center gap-3 px-5 py-3">
          <Pressable
            // While recording this button stops the take rather than leaving,
            // so the label must not say "Back" — that would read as discarding.
            accessibilityLabel={recording ? 'Stop recording and review' : 'Back to area'}
            accessibilityRole="button"
            className="h-10 w-10 items-center justify-center rounded-full bg-black/40"
            // 40pt visual, 44pt target: hitSlop keeps the design and still
            // clears the minimum for a gloved or unsteady hand.
            hitSlop={8}
            onPress={() => (recording ? stopRecording() : router.back())}
          >
            <ArrowLeftIcon size={21} className="text-white" />
          </Pressable>
          <View className="min-w-0 flex-1">
            <Text numberOfLines={1} className="text-xl font-bold text-white">
              {room.data?.name ?? 'Room'}
            </Text>
            <Text className="text-xs text-white/70">
              {isAdditional ? 'Additional evidence clip' : 'Primary room walkthrough'}
            </Text>
          </View>
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

        <View className="items-center px-5 pb-4">
          {/* Live 360° guidance. Only while recording a primary walkthrough, so
              the idle screen keeps its uncluttered layout; additional evidence
              clips are free-form and get no rotation coaching. */}
          {recording && !isAdditional ? (
            <View className="mb-4 w-full" pointerEvents="none">
              <GuidedCaptureOverlay state={guidanceState} tracker={guidedSensor.tracker} />
            </View>
          ) : null}
          {/* The elapsed time is the only signal that recording is actually
              running. Sighted users get the red REC badge; this gives everyone
              else the same information without spamming every tick. */}
          <View
            accessibilityLabel={
              recording ? `Recording, ${formatDuration(seconds)} elapsed` : 'Ready to record'
            }
            accessibilityRole="timer"
            className="mb-5 rounded-full bg-black/65 px-5 py-2"
          >
            <Text className="text-lg font-bold text-white">
              {formatDuration(seconds)} {recording ? 'REC' : 'READY'}
            </Text>
          </View>
          <View className="mb-4 w-full">
            <View className="mb-2 flex-row items-end justify-between">
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
              className="mb-4 w-full rounded-xl bg-red-950/80 px-4 py-3"
            >
              <Text className="text-center text-xs text-red-100">{error}</Text>
            </View>
          ) : null}
          <View className="mb-5 flex-row items-center justify-center gap-8">
            {/* Grouped, or VoiceOver reads "3" and "photos" as two stops. */}
            <View
              accessible
              accessibilityLabel={`${photoCount} photo${photoCount === 1 ? '' : 's'} captured`}
              className="items-center"
            >
              <Text className="text-2xl font-bold text-white">{photoCount}</Text>
              <Text className="text-xs text-white/70">photos</Text>
            </View>
            <Pressable
              accessibilityHint={
                captureType === 'AREA_OVERVIEW'
                  ? 'Captures a wide shot of the area'
                  : 'Captures a close-up for a finding'
              }
              accessibilityLabel={capturingPhoto ? 'Saving photo' : 'Take photo'}
              accessibilityRole="button"
              accessibilityState={{ busy: capturingPhoto, disabled: !ready || capturingPhoto }}
              className="h-16 w-16 items-center justify-center rounded-full border-4 border-white bg-white/15"
              onPress={() => void takeSnapshot()}
              disabled={!ready || capturingPhoto}
            >
              {capturingPhoto ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <CameraIcon size={27} className="text-white" />
              )}
            </Pressable>
            <Pressable
              accessibilityLabel="Room capture guide"
              accessibilityRole="button"
              className="min-h-11 min-w-11 items-center justify-center"
              onPress={() =>
                Alert.alert(
                  'Room capture guide',
                  'Start with a wide room overview. Move slowly clockwise, narrate visible conditions, then capture focused context for any finding.',
                )
              }
            >
              <InfoIcon size={22} className="text-white" />
              <Text className="mt-1 text-center text-xs text-white/70">Guide</Text>
            </Pressable>
          </View>
          <Pressable
            accessibilityHint={recording ? 'Ends the take and opens the review screen' : undefined}
            accessibilityLabel={
              stopping ? 'Saving recording' : recording ? 'Stop recording' : 'Start recording'
            }
            accessibilityRole="button"
            accessibilityState={{ busy: stopping, disabled: !ready || stopping }}
            className="h-20 w-20 items-center justify-center rounded-full border-4 border-white bg-red-500"
            disabled={!ready || stopping}
            onPress={recording ? stopRecording : () => void beginRecording()}
          >
            {recording ? (
              <SquareIcon size={27} className="text-white" />
            ) : (
              <View className="h-14 w-14 rounded-full bg-red-500" />
            )}
          </Pressable>
          {/* importantForAccessibility="no": the label above already conveys
              this, and leaving it focusable makes the technician swipe past a
              duplicate of the control they just heard. */}
          <Text importantForAccessibility="no" className="mt-2 text-sm font-semibold text-white">
            {stopping ? 'Saving…' : recording ? 'Stop & review' : 'Record'}
          </Text>
        </View>
      </SafeAreaView>
    </View>
  );
}
