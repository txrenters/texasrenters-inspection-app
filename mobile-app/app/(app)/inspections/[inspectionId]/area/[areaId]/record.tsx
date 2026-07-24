import { useEffect, useRef, useState } from 'react';
import {
  CameraView,
  type CameraType,
  useCameraPermissions,
  useMicrophonePermissions,
} from 'expo-camera';
import * as DocumentPicker from 'expo-document-picker';
import { router, useLocalSearchParams } from 'expo-router';
import { Image, Linking, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { AppButton, ConfirmationModal } from '../../../../../../src/components/ui';
import { environment, isDemoMode } from '../../../../../../src/config/environment';
import { useInspection, useProperty, useRoom } from '../../../../../../src/features/queries';
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
  { value: 'FINDING_DETAIL', label: 'Finding close-up' },
  { value: 'SUPPORTING_EVIDENCE', label: 'Supporting' },
];
const CAPTURE_TYPE_LABELS: Record<PhotoCaptureType, string> = {
  AREA_OVERVIEW: 'area overview',
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
  const room = useRoom(areaId);
  const inspection = useInspection(inspectionId);
  const property = useProperty(inspection.data?.propertyId ?? '');
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
  const [guideOpen, setGuideOpen] = useState(false);
  const [videoGuideOpen, setVideoGuideOpen] = useState(false);
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
        ownerUserId,
        inspectionId,
        roomId: areaId,
        uri: stored.uri,
        durationSeconds: duration,
        sizeBytes: stored.sizeBytes,
        recordingType: isAdditionalVideo ? 'ADDITIONAL_ISSUE' : 'PRIMARY_AREA',
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
      storeDraft(result.uri, Math.max(1, secondsRef.current));
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
    void beginRecording();
  };

  // Captures directly from the live preview — no camera-mode switching, so it
  // works mid-recording too. Spotting a defect during the tour must not force
  // the technician to stop the video.
  const uploadSnapshot = async (snapshot: RoomSnapshot) => {
    // In demo mode there is no backend session; treat the local save as final.
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
      });
      updateSnapshot(snapshot.id, { uploadStatus: 'UPLOADED', serverPhotoId: uploaded.id });
    } catch {
      // The photo stays on the device and can be retried; never lost.
      updateSnapshot(snapshot.id, { uploadStatus: 'FAILED' });
    }
  };

  const takeSnapshot = async () => {
    const camera = cameraRef.current;
    if (!camera || !cameraReady || !hasPermissions || capturingSnapshot) return;

    setCapturingSnapshot(true);
    setError(null);
    setSnapshotMessage(null);
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
      });
      addSnapshot(snapshot);
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
              key={`video-${cameraGeneration}`}
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

        {isAdditionalVideo ? (
          <View style={styles.additionalBanner}>
            <Text style={styles.additionalBannerTitle}>Additional labeled clip</Text>
            <Text style={styles.additionalBannerText}>
              This extra recording is saved alongside the room’s primary walkthrough — it does not
              replace it. You’ll add a label after recording.
            </Text>
          </View>
        ) : null}

        <View style={styles.prompts}>
          <Text style={styles.promptTitle}>Capture guidance</Text>
          {isAdditionalVideo ? (
            <>
              <Text style={styles.prompt}>• Focus on the single issue this clip documents.</Text>
              <Text style={styles.prompt}>• Narrate what the reviewer is looking at.</Text>
              <Text style={styles.prompt}>• Include enough surroundings to show the location.</Text>
            </>
          ) : (
            <>
              <Text style={styles.prompt}>
                • State the room name — your narration is transcribed.
              </Text>
              <Text style={styles.prompt}>• Show the entire room.</Text>
              <Text style={styles.prompt}>• Describe and approach visible defects.</Text>
              <Text style={styles.prompt}>
                • Spot a defect? Snap a photo without stopping the video.
              </Text>
              <Text style={styles.prompt}>• Stop before leaving this room.</Text>
            </>
          )}
        </View>

        {error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        ) : null}

        <AppButton
          compact
          variant="ghost"
          label="Recording guide"
          onPress={() => setVideoGuideOpen(true)}
        />

        <View style={styles.captureTypeRow}>
          {CAPTURE_TYPE_OPTIONS.map((option) => (
            <Pressable
              key={option.value}
              accessibilityRole="button"
              accessibilityState={{ selected: captureType === option.value }}
              onPress={() => setCaptureType(option.value)}
              style={[styles.captureChip, captureType === option.value && styles.captureChipSelected]}
            >
              <Text
                style={[
                  styles.captureChipText,
                  captureType === option.value && styles.captureChipTextSelected,
                ]}
              >
                {option.label}
              </Text>
            </Pressable>
          ))}
        </View>

        <View style={styles.snapshotRow}>
          <AppButton
            accessibilityLabel={`Take ${CAPTURE_TYPE_LABELS[captureType]} for ${room.data?.name ?? 'this room'}`}
            compact
            disabled={!hasPermissions || !cameraReady || capturingSnapshot}
            label={capturingSnapshot ? 'Saving…' : `Take ${CAPTURE_TYPE_LABELS[captureType]}`}
            loading={capturingSnapshot}
            onPress={() => void takeSnapshot()}
            variant="outline"
          />
          <AppButton
            compact
            label="How to photograph"
            onPress={() => setGuideOpen(true)}
            variant="ghost"
          />
          <View style={styles.snapshotSummary}>
            <Text style={styles.snapshotCount}>
              {roomSnapshots.length} {roomSnapshots.length === 1 ? 'photo' : 'photos'} saved
            </Text>
            <Text style={styles.snapshotHint}>Overview first, then close-ups — even mid-recording.</Text>
          </View>
          {latestSnapshot ? (
            <Image
              accessibilityLabel="Latest saved photo"
              source={{ uri: latestSnapshot.uri }}
              style={styles.snapshotThumbnail}
            />
          ) : null}
        </View>

        {failedPhotos.length ? (
          <View style={styles.retryRow}>
            <Text style={styles.retryText}>
              {failedPhotos.length} photo{failedPhotos.length === 1 ? '' : 's'} still to upload.
            </Text>
            <AppButton
              compact
              label="Retry uploads"
              variant="ghost"
              onPress={() => failedPhotos.forEach((photo) => void uploadSnapshot(photo))}
            />
          </View>
        ) : null}

        {snapshotMessage ? (
          <Text accessibilityLiveRegion="polite" style={styles.snapshotMessage}>
            {snapshotMessage}
          </Text>
        ) : null}

        <PhotoGuidanceModal visible={guideOpen} onClose={() => setGuideOpen(false)} />
        <VideoGuideModal
          visible={videoGuideOpen}
          onClose={() => setVideoGuideOpen(false)}
          title={isOutdoorArea ? 'Outdoor recording guide' : 'Indoor recording guide'}
          steps={videoSteps}
        />

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
              disabled={!hasPermissions || !cameraReady || capturingSnapshot}
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
    additionalBanner: {
      borderRadius: radius.md,
      padding: spacing.md,
      gap: spacing.xs,
      backgroundColor: 'rgba(245,158,11,0.18)',
      borderWidth: 1,
      borderColor: 'rgba(245,158,11,0.5)',
    },
    additionalBannerTitle: { ...typography.label, color: '#FFE0A6' },
    additionalBannerText: { ...typography.caption, color: '#F5E7CE' },
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
    captureTypeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
    captureChip: {
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.35)',
      borderRadius: radius.round,
      paddingHorizontal: spacing.md,
      paddingVertical: 6,
      backgroundColor: 'rgba(255,255,255,0.06)',
    },
    captureChipSelected: { borderColor: colors.white, backgroundColor: 'rgba(255,255,255,0.22)' },
    captureChipText: { ...typography.caption, color: '#D7E2E0' },
    captureChipTextSelected: { color: colors.white, fontWeight: '800' },
    retryRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
    },
    retryText: { ...typography.caption, color: '#FFD9A8' },
    guideBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.55)' },
    guideSheet: {
      maxHeight: '80%',
      backgroundColor: colors.surface,
      borderTopLeftRadius: radius.lg,
      borderTopRightRadius: radius.lg,
      padding: spacing.lg,
      gap: spacing.sm,
    },
    guideTitle: { ...typography.title, color: colors.textPrimary },
    guideList: { gap: spacing.sm, paddingBottom: spacing.sm },
    guideItem: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' },
    guideBullet: { ...typography.body, color: colors.primary, fontWeight: '800' },
    guideText: { ...typography.body, color: colors.textPrimary, flex: 1 },
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
