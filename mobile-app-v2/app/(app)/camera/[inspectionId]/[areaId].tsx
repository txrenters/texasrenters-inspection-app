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
import { cssInterop } from 'nativewind';
import {
  ArrowLeftIcon,
  CameraIcon,
  CheckIcon,
  RotateCcwIcon,
  SquareIcon,
  ZapIcon,
  ZapOffIcon,
} from 'lucide-react-native';
import {
  ActivityIndicator,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { PhotoCaptureType, RoomSnapshot } from '@/src/domain/models';
import { useRoom } from '@/src/features/queries';
import { buildRecordingDraft, persistRecording } from '@/src/media/local-recordings';
import { buildRoomSnapshot, persistRoomSnapshot } from '@/src/media/local-snapshots';
import { uploadRoomPhoto } from '@/src/media/photo-upload';
import { useDemoStore } from '@/src/stores/demo.store';

for (const icon of [
  ArrowLeftIcon,
  CameraIcon,
  CheckIcon,
  RotateCcwIcon,
  SquareIcon,
  ZapIcon,
  ZapOffIcon,
]) {
  cssInterop(icon, { className: { target: 'style', nativeStyleToProp: { color: true } } });
}

const MAX_RECORDING_SECONDS = 10 * 60;

function formatDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
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

  const beginRecording = async () => {
    if (!(await requestPermissions())) return;
    if (!camera || !ready || recording) return;
    setError(null);
    secondsRef.current = 0;
    setSeconds(0);
    setRecording(true);
    setStopping(false);
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
        videoTimestampMs: recording ? secondsRef.current * 1000 : undefined,
        captureSource:
          recording && Platform.OS === 'ios'
            ? 'NATIVE_STILL_DURING_VIDEO'
            : 'SEPARATE_PHOTO_CAPTURE',
        sequenceNumber: photoCount + 1,
      });
      addSnapshot(snapshot);
      setPhotoCount((count) => count + 1);
      if (captureType === 'AREA_OVERVIEW') setCaptureType('FINDING_CONTEXT');
      void Haptics.selectionAsync().catch(() => undefined);
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
        {error ? <Text className="mt-3 text-center text-sm text-red-300">{error}</Text> : null}
        <Pressable
          className="mt-6 rounded-xl bg-primary px-6 py-4"
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
      <SafeAreaView edges={['top', 'bottom']} className="flex-1 justify-between">
        <View className="flex-row items-center gap-3 px-5 py-3">
          <Pressable
            className="h-10 w-10 items-center justify-center rounded-full bg-black/40"
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
            className="h-10 w-10 items-center justify-center rounded-full bg-black/40"
            onPress={() => setTorch((value) => !value)}
          >
            {torch ? (
              <ZapIcon size={20} className="text-white" />
            ) : (
              <ZapOffIcon size={20} className="text-white" />
            )}
          </Pressable>
          <Pressable
            className="h-10 w-10 items-center justify-center rounded-full bg-black/40"
            onPress={() => setFacing((value) => (value === 'back' ? 'front' : 'back'))}
          >
            <RotateCcwIcon size={20} className="text-white" />
          </Pressable>
        </View>

        <View className="items-center px-5 pb-4">
          <View className="mb-5 rounded-full bg-black/65 px-5 py-2">
            <Text className="text-lg font-bold text-white">
              {formatDuration(seconds)} {recording ? 'REC' : 'READY'}
            </Text>
          </View>
          {error ? (
            <View className="mb-4 w-full rounded-xl bg-red-950/80 px-4 py-3">
              <Text className="text-center text-xs text-red-100">{error}</Text>
            </View>
          ) : null}
          <View className="mb-5 flex-row items-center justify-center gap-8">
            <View className="items-center">
              <Text className="text-2xl font-bold text-white">{photoCount}</Text>
              <Text className="text-xs text-white/70">photos</Text>
            </View>
            <Pressable
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
              className="items-center"
              onPress={() =>
                setCaptureType((value) =>
                  value === 'AREA_OVERVIEW' ? 'FINDING_CONTEXT' : 'AREA_OVERVIEW',
                )
              }
            >
              <CheckIcon size={22} className="text-white" />
              <Text className="mt-1 max-w-24 text-center text-xs text-white/70">
                {captureType === 'AREA_OVERVIEW' ? 'Area overview' : 'Finding context'}
              </Text>
            </Pressable>
          </View>
          <Pressable
            className={`h-20 w-20 items-center justify-center rounded-full border-4 border-white ${
              recording ? 'bg-red-500' : 'bg-red-500'
            }`}
            disabled={!ready || stopping}
            onPress={recording ? stopRecording : () => void beginRecording()}
          >
            {recording ? (
              <SquareIcon size={27} className="text-white" />
            ) : (
              <View className="h-14 w-14 rounded-full bg-red-500" />
            )}
          </Pressable>
          <Text className="mt-2 text-sm font-semibold text-white">
            {stopping ? 'Saving…' : recording ? 'Stop & review' : 'Record'}
          </Text>
        </View>
      </SafeAreaView>
    </View>
  );
}
