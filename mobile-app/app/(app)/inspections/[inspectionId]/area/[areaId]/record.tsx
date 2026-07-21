import { useEffect, useRef, useState } from 'react';
import {
  CameraView,
  type CameraType,
  useCameraPermissions,
  useMicrophonePermissions,
} from 'expo-camera';
import * as DocumentPicker from 'expo-document-picker';
import { router, useLocalSearchParams } from 'expo-router';
import { Linking, StyleSheet, Text, View } from 'react-native';

import { AppButton, ConfirmationModal } from '../../../../../../src/components/ui';
import { environment } from '../../../../../../src/config/environment';
import { useInspection, useProperty, useRoom } from '../../../../../../src/features/queries';
import {
  buildRecordingDraft,
  persistRecording,
} from '../../../../../../src/media/local-recordings';
import { useDemoStore } from '../../../../../../src/stores/demo.store';
import {
  type AppColors,
  radius,
  spacing,
  typography,
  useThemedStyles,
} from '../../../../../../src/theme';

const MAX_RECORDING_SECONDS = 10 * 60;

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
  const cameraRef = useRef<CameraView>(null);
  const secondsRef = useRef(0);
  const cancelRequestedRef = useRef(false);
  const mountedRef = useRef(true);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [microphonePermission, requestMicrophonePermission] = useMicrophonePermissions();
  const [cameraReady, setCameraReady] = useState(false);
  const [recording, setRecording] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [paused, setPaused] = useState(false);
  const [pauseSupported, setPauseSupported] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [torch, setTorch] = useState(false);
  const [facing, setFacing] = useState<CameraType>('back');
  const [error, setError] = useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const hasPermissions = Boolean(cameraPermission?.granted && microphonePermission?.granted);
  const canAskForPermissions =
    (!cameraPermission || cameraPermission.granted || cameraPermission.canAskAgain) &&
    (!microphonePermission || microphonePermission.granted || microphonePermission.canAskAgain);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelRequestedRef.current = true;
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

  const startRecording = async () => {
    const camera = cameraRef.current;
    if (!camera || !cameraReady || !hasPermissions || recording) return;

    cancelRequestedRef.current = false;
    secondsRef.current = 0;
    setSeconds(0);
    setPaused(false);
    setStopping(false);
    setError(null);
    setRecording(true);

    try {
      const result = await camera.recordAsync({ maxDuration: MAX_RECORDING_SECONDS });
      if (!result || cancelRequestedRef.current || !mountedRef.current) return;
      storeDraft(result.uri, Math.max(1, secondsRef.current));
    } catch (recordingError) {
      if (!cancelRequestedRef.current && mountedRef.current) {
        setError(
          errorMessage(recordingError, 'The video could not be recorded. Please try again.'),
        );
      }
    } finally {
      if (mountedRef.current) {
        setRecording(false);
        setStopping(false);
        setPaused(false);
      }
    }
  };

  const stopRecording = () => {
    if (!recording || stopping) return;
    setStopping(true);
    cameraRef.current?.stopRecording();
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
              ref={cameraRef}
              active
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
          <Text style={styles.prompt}>• State the room name.</Text>
          <Text style={styles.prompt}>• Show the entire room.</Text>
          <Text style={styles.prompt}>• Describe and approach visible defects.</Text>
          <Text style={styles.prompt}>• Stop before leaving this room.</Text>
        </View>

        {error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
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
              disabled={!hasPermissions || !cameraReady}
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
