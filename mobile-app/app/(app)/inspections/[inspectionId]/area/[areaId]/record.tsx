import { useEffect, useRef, useState } from 'react';
import {
  CameraView,
  type CameraMode,
  type CameraType,
  useCameraPermissions,
  useMicrophonePermissions,
} from 'expo-camera';
import * as DocumentPicker from 'expo-document-picker';
import { router, useLocalSearchParams } from 'expo-router';
import { Image, Linking, StyleSheet, Text, View } from 'react-native';

import { AppButton, ConfirmationModal } from '../../../../../../src/components/ui';
import { environment } from '../../../../../../src/config/environment';
import { useInspection, useProperty, useRoom } from '../../../../../../src/features/queries';
import {
  buildRecordingDraft,
  persistRecording,
} from '../../../../../../src/media/local-recordings';
import {
  buildRoomSnapshot,
  persistRoomSnapshot,
} from '../../../../../../src/media/local-snapshots';
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

export default function RecordRoomScreen() {
  const styles = useThemedStyles(createStyles);
  const { inspectionId = '', areaId = '' } = useLocalSearchParams<{
    inspectionId: string;
    areaId: string;
  }>();
  const room = useRoom(areaId);
  const inspection = useInspection(inspectionId);
  const property = useProperty(inspection.data?.propertyId ?? '');
  const setDraft = useDemoStore((state) => state.setDraftRecording);
  const addSnapshot = useDemoStore((state) => state.addSnapshot);
  const snapshots = useDemoStore((state) => state.snapshots ?? []);
  const roomSnapshots = snapshots.filter(
    (snapshot) => snapshot.inspectionId === inspectionId && snapshot.roomId === areaId,
  );
  const latestSnapshot = roomSnapshots[0];
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
  const [cameraMode, setCameraMode] = useState<CameraMode>('video');
  const [cameraActive, setCameraActive] = useState(true);
  const [cameraGeneration, setCameraGeneration] = useState(0);
  const [snapshotRequested, setSnapshotRequested] = useState(false);
  const [recording, setRecording] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [paused, setPaused] = useState(false);
  const [pauseSupported, setPauseSupported] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [torch, setTorch] = useState(false);
  const [facing, setFacing] = useState<CameraType>('back');
  const [capturingSnapshot, setCapturingSnapshot] = useState(false);
  const [snapshotMessage, setSnapshotMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
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

  const requestPermissions = async () => {
    setError(null);
    if (!canAskForPermissions) {
      await Linking.openSettings();
      return;
    }

    const cameraResult = cameraPermission?.granted
      ? cameraPermission
      : await requestCameraPermission();
    const microphoneResult = microphonePermission?.granted
      ? microphonePermission
      : await requestMicrophonePermission();

    if (!cameraResult.granted || !microphoneResult.granted) {
      setError('Camera and microphone access are both required to record room evidence.');
    }
  };

  const storeDraft = (temporaryUri: string, duration: number) => {
    const stored = persistRecording(temporaryUri, inspectionId, areaId);
    setDraft(
      buildRecordingDraft({
        inspectionId,
        roomId: areaId,
        uri: stored.uri,
        durationSeconds: duration,
        sizeBytes: stored.sizeBytes,
      }),
    );
    router.replace({
      pathname: '/(app)/inspections/[inspectionId]/area/[areaId]/review',
      params: { inspectionId, areaId },
    });
  };

  const beginRecording = async () => {
    const camera = cameraRef.current;
    if (!camera || !cameraReady || cameraMode !== 'video' || !hasPermissions || recording) return;

    cancelRequestedRef.current = false;
    secondsRef.current = 0;
    setSeconds(0);
    setPaused(false);
    setStopping(false);
    setError(null);
    recordingSettledRef.current = false;
    setRecording(true);

    try {
      const result = await camera.recordAsync({ maxDuration: MAX_RECORDING_SECONDS });
      recordingSettledRef.current = true;
      clearRecordingTimers();
      if (!result || cancelRequestedRef.current || !mountedRef.current) return;
      storeDraft(result.uri, Math.max(1, secondsRef.current));
    } catch (recordingError) {
      if (!cancelRequestedRef.current && mountedRef.current) {
        setError(
          errorMessage(recordingError, 'The video could not be recorded. Please try again.'),
        );
        setCameraReady(false);
        setCameraMode('video');
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
    if (!cameraReady || cameraMode !== 'video' || !hasPermissions || recording) return;
    setError(null);
    setSnapshotMessage(null);
    void beginRecording();
  };

  const captureSnapshot = async () => {
    const camera = cameraRef.current;
    if (
      !camera ||
      !cameraReady ||
      cameraMode !== 'picture' ||
      !hasPermissions ||
      recording ||
      capturingSnapshot
    )
      return;

    setCapturingSnapshot(true);
    setError(null);
    setSnapshotMessage(null);
    try {
      const captured = await camera.takePictureAsync({ quality: 0.82 });
      const stored = persistRoomSnapshot(captured.uri, inspectionId, areaId);
      addSnapshot(
        buildRoomSnapshot({
          inspectionId,
          roomId: areaId,
          uri: stored.uri,
          width: captured.width,
          height: captured.height,
          sizeBytes: stored.sizeBytes,
        }),
      );
      setSnapshotMessage('Snapshot saved to this room.');
    } catch (snapshotError) {
      setError(errorMessage(snapshotError, 'The snapshot could not be saved. Please try again.'));
    } finally {
      if (mountedRef.current) {
        setCapturingSnapshot(false);
        setCameraReady(false);
        setCameraMode('video');
      }
    }
  };

  useEffect(() => {
    if (!snapshotRequested || !cameraReady || cameraMode !== 'picture') return;
    setSnapshotRequested(false);
    void captureSnapshot();
  }, [cameraMode, cameraReady, snapshotRequested]);

  const takeSnapshot = () => {
    if (!cameraReady || cameraMode !== 'video' || !hasPermissions || recording) return;
    setError(null);
    setSnapshotMessage(null);
    setSnapshotRequested(true);
    setCameraReady(false);
    setCameraMode('picture');
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
      setCameraMode('video');
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
    if (!result.canceled && result.assets[0]) storeDraft(result.assets[0].uri, 37);
  };

  return (
    <View style={styles.root}>
      <View style={styles.cameraScreen}>
        <View style={styles.topBar}>
          <View style={styles.roomContext}>
            <Text style={styles.address}>{property.data?.address ?? 'Demo property'}</Text>
            <Text style={styles.room}>{room.data?.name ?? 'Room'}</Text>
          </View>
          <View style={styles.cameraBadge}>
            <Text style={styles.cameraBadgeText}>LOCAL CAMERA</Text>
          </View>
        </View>

        <View style={styles.viewfinder}>
          {hasPermissions ? (
            <CameraView
              key={`${cameraMode}-${cameraGeneration}`}
              ref={cameraRef}
              active={cameraActive}
              enableTorch={torch && facing === 'back'}
              facing={facing}
              mode={cameraMode}
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

          <View style={styles.frameOverlay}>
            <View style={styles.cornerTopLeft} />
            <View style={styles.cornerTopRight} />
            <View style={styles.cornerBottomLeft} />
            <View style={styles.cornerBottomRight} />
            {hasPermissions ? (
              <View style={styles.recordingReadout}>
                <Text style={styles.timer}>{formatTimer(seconds)}</Text>
                <Text style={styles.recordStatus}>
                  {stopping
                    ? 'SAVING VIDEO'
                    : recording
                      ? paused
                        ? 'PAUSED'
                        : '● RECORDING'
                      : 'READY'}
                </Text>
              </View>
            ) : null}
          </View>
        </View>

        <View style={styles.prompts}>
          <Text style={styles.promptTitle}>Capture guidance</Text>
          <Text style={styles.prompt}>• State the room name — your narration is transcribed.</Text>
          <Text style={styles.prompt}>• Show the entire room.</Text>
          <Text style={styles.prompt}>• Describe and approach visible defects.</Text>
          <Text style={styles.prompt}>• Stop the video first if you want to snap a photo.</Text>
          <Text style={styles.prompt}>• Stop before leaving this room.</Text>
        </View>

        {error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        ) : null}

        <View style={styles.snapshotRow}>
          <AppButton
            accessibilityLabel={`Take snapshot for ${room.data?.name ?? 'this room'}`}
            compact
            disabled={
              !hasPermissions ||
              !cameraReady ||
              cameraMode !== 'video' ||
              recording ||
              snapshotRequested
            }
            label={capturingSnapshot ? 'Saving snapshot…' : 'Snap photo'}
            loading={capturingSnapshot}
            onPress={takeSnapshot}
            variant="outline"
          />
          <View style={styles.snapshotSummary}>
            <Text style={styles.snapshotCount}>
              {roomSnapshots.length} {roomSnapshots.length === 1 ? 'snapshot' : 'snapshots'} saved
            </Text>
            <Text style={styles.snapshotHint}>
              {recording
                ? 'Stop the video to snap a photo.'
                : 'Photos stay attached to this inspection room.'}
            </Text>
          </View>
          {latestSnapshot ? (
            <Image
              accessibilityLabel="Latest saved room snapshot"
              source={{ uri: latestSnapshot.uri }}
              style={styles.snapshotThumbnail}
            />
          ) : null}
        </View>

        {snapshotMessage ? (
          <Text accessibilityLiveRegion="polite" style={styles.snapshotMessage}>
            {snapshotMessage}
          </Text>
        ) : null}

        <View style={styles.toolRow}>
          <AppButton
            compact
            disabled={!hasPermissions || facing === 'front'}
            label={torch ? 'Torch on' : 'Torch off'}
            onPress={() => setTorch((value) => !value)}
            variant="ghost"
          />
          <View style={styles.mic}>
            <Text style={styles.micText}>
              {hasPermissions ? '● Mic active' : 'Mic unavailable'}
            </Text>
          </View>
          <AppButton
            compact
            disabled={!hasPermissions || recording}
            label={facing === 'front' ? 'Front' : 'Rear'}
            onPress={() => setFacing((value) => (value === 'back' ? 'front' : 'back'))}
            variant="ghost"
          />
        </View>

        <View style={styles.controls}>
          <AppButton compact label="Cancel" onPress={() => setCancelOpen(true)} variant="ghost" />
          {!recording ? (
            <AppButton
              disabled={
                !hasPermissions ||
                !cameraReady ||
                cameraMode !== 'video' ||
                snapshotRequested ||
                capturingSnapshot
              }
              label={hasPermissions && !cameraReady ? 'Starting camera…' : 'Start recording'}
              onPress={() => void startRecording()}
            />
          ) : (
            <AppButton
              disabled={stopping}
              label={stopping ? 'Saving…' : 'Stop & review'}
              onPress={stopRecording}
              variant="danger"
            />
          )}
          {recording && pauseSupported ? (
            <AppButton
              compact
              disabled={stopping}
              label={paused ? 'Resume' : 'Pause'}
              onPress={() => void togglePause()}
              variant="outline"
            />
          ) : (
            <View style={styles.controlSpacer} />
          )}
        </View>

        {environment.enableTestVideoPicker && !recording ? (
          <AppButton
            label="Choose development test video"
            onPress={() => void pickTestVideo()}
            variant="outline"
          />
        ) : null}
      </View>

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

const corner = {
  position: 'absolute' as const,
  width: 34,
  height: 34,
  borderColor: 'rgba(255,255,255,0.75)',
};

const createStyles = (colors: AppColors) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: '#0C1615' },
    cameraScreen: {
      flex: 1,
      width: '100%',
      maxWidth: 720,
      alignSelf: 'center',
      padding: spacing.md,
      gap: spacing.md,
    },
    topBar: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    roomContext: { flex: 1 },
    address: { ...typography.caption, color: '#BFD2D0' },
    room: { ...typography.heading, color: colors.white },
    cameraBadge: {
      borderRadius: radius.round,
      paddingHorizontal: spacing.sm,
      paddingVertical: 5,
      backgroundColor: colors.primarySoft,
    },
    cameraBadgeText: { fontSize: 10, color: colors.primaryDark, fontWeight: '900' },
    viewfinder: {
      flex: 1,
      minHeight: 220,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.lg,
      backgroundColor: '#243B39',
      overflow: 'hidden',
    },
    permissionPanel: {
      maxWidth: 360,
      alignItems: 'center',
      gap: spacing.md,
      padding: spacing.lg,
    },
    permissionTitle: { ...typography.heading, color: colors.white, textAlign: 'center' },
    permissionText: { ...typography.body, color: '#D7E2E0', textAlign: 'center' },
    frameOverlay: {
      ...StyleSheet.absoluteFillObject,
      pointerEvents: 'none',
      alignItems: 'center',
      justifyContent: 'center',
    },
    recordingReadout: {
      alignItems: 'center',
      borderRadius: radius.md,
      backgroundColor: 'rgba(0,0,0,0.48)',
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
    cornerTopLeft: { ...corner, top: 24, left: 24, borderTopWidth: 3, borderLeftWidth: 3 },
    cornerTopRight: { ...corner, top: 24, right: 24, borderTopWidth: 3, borderRightWidth: 3 },
    cornerBottomLeft: { ...corner, bottom: 24, left: 24, borderBottomWidth: 3, borderLeftWidth: 3 },
    cornerBottomRight: {
      ...corner,
      bottom: 24,
      right: 24,
      borderBottomWidth: 3,
      borderRightWidth: 3,
    },
    timer: {
      color: colors.white,
      fontSize: 44,
      lineHeight: 52,
      fontWeight: '300',
      fontVariant: ['tabular-nums'],
    },
    recordStatus: { ...typography.label, color: '#F3B2B2', letterSpacing: 1 },
    prompts: {
      borderRadius: radius.md,
      padding: spacing.md,
      backgroundColor: 'rgba(255,255,255,0.08)',
      gap: spacing.xs,
    },
    promptTitle: { ...typography.label, color: colors.white },
    prompt: { ...typography.caption, color: '#D7E2E0' },
    error: { ...typography.caption, color: '#FFB4B4', textAlign: 'center' },
    snapshotRow: {
      minHeight: 68,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      borderRadius: radius.md,
      padding: spacing.sm,
      backgroundColor: 'rgba(255,255,255,0.08)',
    },
    snapshotSummary: { flex: 1, gap: 2 },
    snapshotCount: { ...typography.label, color: colors.white },
    snapshotHint: { ...typography.caption, color: '#BFD2D0' },
    snapshotThumbnail: {
      width: 52,
      height: 52,
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.45)',
    },
    snapshotMessage: { ...typography.caption, color: '#B9E1CE', textAlign: 'center' },
    toolRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
    },
    mic: { paddingHorizontal: spacing.sm },
    micText: { ...typography.caption, color: '#B9E1CE' },
    controls: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
    },
    controlSpacer: { width: 70 },
  });
