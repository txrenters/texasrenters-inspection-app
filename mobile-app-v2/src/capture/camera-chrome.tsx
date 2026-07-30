import {
  ArrowLeftIcon,
  CameraIcon,
  ChevronDownIcon,
  CircleDotIcon,
  InfoIcon,
  MicIcon,
  RotateCcwIcon,
  SquareIcon,
  WifiOffIcon,
  ZapIcon,
  ZapOffIcon,
} from 'lucide-react-native';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';

import { registerIcons } from '../lib/icons';
import { SPACING, TOUCH, type CameraLayout } from './camera-layout';

registerIcons(
  ArrowLeftIcon,
  CameraIcon,
  ChevronDownIcon,
  CircleDotIcon,
  InfoIcon,
  MicIcon,
  RotateCcwIcon,
  SquareIcon,
  WifiOffIcon,
  ZapIcon,
  ZapOffIcon,
);

/**
 * Camera chrome is deliberately fixed-dark rather than theme-aware.
 *
 * A light-theme card over a live preview is unreadable against a bright window
 * and washes out a dark room. Sheets and review screens still follow the app
 * theme — only the surfaces sitting directly on the preview are pinned.
 */
const SURFACE = 'bg-black/55';
const SURFACE_STRONG = 'bg-black/70';

/** A circular translucent control. Used for every icon-only camera action. */
function RoundControl({
  accessibilityLabel,
  accessibilityState,
  children,
  onPress,
  disabled,
}: {
  accessibilityLabel: string;
  accessibilityState?: { checked?: boolean; disabled?: boolean; busy?: boolean };
  children: React.ReactNode;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole={accessibilityState?.checked === undefined ? 'button' : 'switch'}
      accessibilityState={accessibilityState}
      className={`h-11 w-11 items-center justify-center rounded-full ${SURFACE} active:opacity-70`}
      disabled={disabled}
      hitSlop={SPACING.sm}
      onPress={onPress}
    >
      {children}
    </Pressable>
  );
}

export function CameraHeader({
  areaName,
  subtitle,
  torch,
  torchAvailable,
  facing,
  switching,
  onBack,
  onToggleTorch,
  onSwitchFacing,
  onLayout,
}: {
  areaName: string;
  subtitle: string;
  torch: boolean;
  torchAvailable: boolean;
  facing: 'back' | 'front';
  switching: boolean;
  onBack: () => void;
  onToggleTorch: () => void;
  onSwitchFacing: () => void;
  onLayout?: (height: number) => void;
}) {
  return (
    <View
      className="flex-row items-center px-4 py-2"
      style={{ gap: SPACING.md }}
      onLayout={(event) => onLayout?.(event.nativeEvent.layout.height)}
    >
      <RoundControl accessibilityLabel="Back to area" onPress={onBack}>
        <ArrowLeftIcon size={20} className="text-white" />
      </RoundControl>

      <View className="min-w-0 flex-1">
        <Text className="text-base font-semibold text-white" numberOfLines={1}>
          {areaName}
        </Text>
        <Text className="text-xs text-white/70" numberOfLines={1}>
          {subtitle}
        </Text>
      </View>

      <RoundControl
        accessibilityLabel={torch ? 'Turn flash off' : 'Turn flash on'}
        accessibilityState={{ checked: torch, disabled: !torchAvailable }}
        disabled={!torchAvailable}
        onPress={onToggleTorch}
      >
        {/* Icon changes with state, so flash is never conveyed by colour alone. */}
        {torch ? (
          <ZapIcon size={19} className="text-amber-300" />
        ) : (
          <ZapOffIcon size={19} className={torchAvailable ? 'text-white' : 'text-white/40'} />
        )}
      </RoundControl>

      <RoundControl
        accessibilityLabel={
          facing === 'back' ? 'Switch to front camera' : 'Switch to rear camera'
        }
        accessibilityState={{ busy: switching, disabled: switching }}
        disabled={switching}
        onPress={onSwitchFacing}
      >
        {switching ? (
          <ActivityIndicator color="#fff" size="small" />
        ) : (
          <RotateCcwIcon size={19} className="text-white" />
        )}
      </RoundControl>
    </View>
  );
}

export type RecordingPhase = 'READY' | 'RECORDING' | 'SAVING';

export function RecordingStatusPill({
  phase,
  elapsed,
  readyDetail,
}: {
  phase: RecordingPhase;
  elapsed: string;
  readyDetail: string;
}) {
  if (phase === 'SAVING')
    return (
      <View
        accessibilityLiveRegion="polite"
        accessibilityRole="progressbar"
        className={`flex-row items-center rounded-full ${SURFACE_STRONG} px-4 py-1.5`}
        style={{ gap: SPACING.sm }}
      >
        <ActivityIndicator color="#fff" size="small" />
        <Text className="text-sm font-semibold text-white">Saving recording…</Text>
      </View>
    );

  if (phase === 'RECORDING')
    return (
      <View
        accessibilityLabel={`Recording, ${elapsed} elapsed`}
        accessibilityRole="timer"
        className={`flex-row items-center rounded-full ${SURFACE_STRONG} px-4 py-1.5`}
        style={{ gap: SPACING.sm }}
      >
        {/* Red is reserved for the live recording state and nothing else. */}
        <View className="h-2.5 w-2.5 rounded-full bg-red-500" />
        <Text className="text-sm font-black tracking-wide text-red-400">REC</Text>
        <Text className="font-mono text-sm font-semibold text-white">{elapsed}</Text>
      </View>
    );

  return (
    <View
      accessible
      accessibilityLabel={`Ready. ${readyDetail}`}
      className={`items-center rounded-full ${SURFACE_STRONG} px-4 py-1.5`}
    >
      <Text className="text-xs font-black tracking-[2px] text-white/90">READY</Text>
      <Text className="text-[11px] text-white/60">{readyDetail}</Text>
    </View>
  );
}

/**
 * Corner brackets rather than a full rectangle.
 *
 * A closed box reads as an object-detection boundary — as though anything
 * outside it were excluded from the recording, which is not true. Brackets
 * suggest framing without implying a crop.
 */
export function FramingGuide({ layout }: { layout: CameraLayout }) {
  if (layout.collapsed) return null;
  const corner = 'absolute h-9 w-9 border-white/45';
  return (
    <View
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={{
        position: 'absolute',
        top: layout.guide.top,
        left: layout.guide.left,
        width: layout.guide.width,
        height: layout.guide.height,
      }}
    >
      <View className={`${corner} left-0 top-0 rounded-tl-2xl border-l-2 border-t-2`} />
      <View className={`${corner} right-0 top-0 rounded-tr-2xl border-r-2 border-t-2`} />
      <View className={`${corner} bottom-0 left-0 rounded-bl-2xl border-b-2 border-l-2`} />
      <View className={`${corner} bottom-0 right-0 rounded-br-2xl border-b-2 border-r-2`} />
    </View>
  );
}

/**
 * One compact row above the controls: what the next snapshot will be, and the
 * running counts. Replaces the full-width segmented buttons that used to sit
 * permanently across the preview.
 */
export function CaptureInfoRow({
  nextLabel,
  photoCount,
  findingCount,
  secondaryLabel,
  onPressType,
}: {
  nextLabel: string;
  photoCount: number;
  findingCount?: number;
  secondaryLabel?: string;
  onPressType: () => void;
}) {
  return (
    <View
      className="flex-row items-center px-4"
      style={{ gap: SPACING.md, paddingBottom: SPACING.md }}
    >
      <Pressable
        accessibilityHint="Opens the snapshot type selector"
        accessibilityLabel={`Next snapshot: ${nextLabel}`}
        accessibilityRole="button"
        className={`min-h-11 min-w-0 flex-1 flex-row items-center rounded-xl ${SURFACE} px-3 py-2 active:opacity-70`}
        style={{ gap: SPACING.sm }}
        onPress={onPressType}
      >
        <View className="min-w-0 flex-1">
          <Text className="text-[10px] font-bold uppercase tracking-wider text-white/55">
            Next snapshot
          </Text>
          <Text className="text-sm font-semibold text-white" numberOfLines={1}>
            {nextLabel}
          </Text>
        </View>
        <ChevronDownIcon size={16} className="text-white/70" />
      </Pressable>

      <View
        accessible
        accessibilityLabel={
          findingCount === undefined
            ? `${photoCount} photos captured`
            : `${photoCount} photos, ${findingCount} findings marked`
        }
        className={`min-h-11 justify-center rounded-xl ${SURFACE} px-3 py-2`}
      >
        <Text className="text-xs font-semibold text-white">
          {photoCount} photo{photoCount === 1 ? '' : 's'}
        </Text>
        <Text className="text-[11px] text-white/60" numberOfLines={1}>
          {secondaryLabel ?? `${findingCount ?? 0} finding${findingCount === 1 ? '' : 's'}`}
        </Text>
      </View>
    </View>
  );
}

/**
 * Three columns on one shared grid: snapshot, record, tertiary. Record is
 * visually dominant because it is the action the whole screen exists for.
 */
export function CameraControls({
  recording,
  saving,
  ready,
  capturingPhoto,
  tertiaryLabel,
  tertiaryDisabled,
  onSnapshot,
  onToggleRecording,
  onTertiary,
}: {
  recording: boolean;
  saving: boolean;
  ready: boolean;
  capturingPhoto: boolean;
  tertiaryLabel: string;
  tertiaryDisabled?: boolean;
  onSnapshot: () => void;
  onToggleRecording: () => void;
  onTertiary: () => void;
}) {
  return (
    <View
      className="flex-row items-center justify-between px-8"
      style={{ paddingBottom: SPACING.base }}
    >
      <View className="items-center" style={{ width: 72, gap: SPACING.xs }}>
        <Pressable
          accessibilityLabel={capturingPhoto ? 'Saving photo' : 'Take photo'}
          accessibilityRole="button"
          accessibilityState={{ busy: capturingPhoto, disabled: !ready || capturingPhoto }}
          className={`items-center justify-center rounded-full ${SURFACE} border border-white/25 active:opacity-70`}
          disabled={!ready || capturingPhoto}
          style={{ height: TOUCH.snapshot, width: TOUCH.snapshot }}
          onPress={onSnapshot}
        >
          {capturingPhoto ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <CameraIcon size={24} className="text-white" />
          )}
        </Pressable>
        <Text importantForAccessibility="no" className="text-[11px] text-white/70">
          Snapshot
        </Text>
      </View>

      <View className="items-center" style={{ gap: SPACING.xs }}>
        <Pressable
          accessibilityHint={recording ? 'Ends the take and opens review' : undefined}
          accessibilityLabel={
            saving ? 'Saving recording' : recording ? 'Stop recording' : 'Start recording'
          }
          accessibilityRole="button"
          accessibilityState={{ busy: saving, disabled: !ready || saving }}
          className="items-center justify-center rounded-full border-[5px] border-white active:opacity-80"
          disabled={!ready || saving}
          style={{ height: TOUCH.record, width: TOUCH.record }}
          onPress={onToggleRecording}
        >
          {saving ? (
            <ActivityIndicator color="#fff" />
          ) : recording ? (
            <SquareIcon size={26} className="text-white" fill="#fff" />
          ) : (
            <View className="h-14 w-14 rounded-full bg-red-500" />
          )}
        </Pressable>
        <Text importantForAccessibility="no" className="text-[11px] font-semibold text-white">
          {saving ? 'Saving' : recording ? 'Stop' : 'Record'}
        </Text>
      </View>

      <View className="items-center" style={{ width: 72, gap: SPACING.xs }}>
        <Pressable
          accessibilityLabel={tertiaryLabel}
          accessibilityRole="button"
          accessibilityState={{ disabled: tertiaryDisabled }}
          className={`items-center justify-center rounded-full ${SURFACE} border border-white/20 active:opacity-70`}
          disabled={tertiaryDisabled}
          style={{ height: TOUCH.control, width: TOUCH.control }}
          onPress={onTertiary}
        >
          {tertiaryLabel.startsWith('Mark') ? (
            <CircleDotIcon size={20} className="text-white" />
          ) : (
            <InfoIcon size={20} className="text-white" />
          )}
        </Pressable>
        <Text importantForAccessibility="no" className="text-[11px] text-white/70">
          {tertiaryLabel.startsWith('Mark') ? 'Finding' : 'Guide'}
        </Text>
      </View>
    </View>
  );
}

/** Concise icon-and-label status items. Never one long sentence. */
export function CameraStatusBar({
  micOn,
  motionActive,
  offline,
}: {
  micOn: boolean;
  motionActive: boolean;
  offline: boolean;
}) {
  return (
    <View
      className="flex-row items-center justify-center px-4"
      style={{ gap: SPACING.base, paddingBottom: SPACING.sm }}
    >
      <View accessible accessibilityLabel={micOn ? 'Microphone on' : 'Microphone off'}
        className="flex-row items-center" style={{ gap: SPACING.xs }}>
        <MicIcon size={12} className={micOn ? 'text-white/80' : 'text-amber-300'} />
        <Text className="text-[11px] text-white/70">{micOn ? 'Mic on' : 'No mic'}</Text>
      </View>

      {motionActive ? (
        <View accessible accessibilityLabel="Motion guidance active"
          className="flex-row items-center" style={{ gap: SPACING.xs }}>
          <RotateCcwIcon size={12} className="text-white/80" />
          <Text className="text-[11px] text-white/70">Motion active</Text>
        </View>
      ) : null}

      {offline ? (
        <View accessible accessibilityLabel="Offline. The recording will save on this device."
          className="flex-row items-center" style={{ gap: SPACING.xs }}>
          <WifiOffIcon size={12} className="text-amber-300" />
          <Text className="text-[11px] text-amber-200">Offline · saves locally</Text>
        </View>
      ) : null}
    </View>
  );
}
