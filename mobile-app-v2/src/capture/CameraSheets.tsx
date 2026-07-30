import { CheckIcon, XIcon } from 'lucide-react-native';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { PhotoCaptureType } from '../domain/models';
import { registerIcons } from '../lib/icons';
import { SPACING } from './camera-layout';
import type { Guidance } from './guidance-state';
import { purposeByValue, type RecordingMode } from './recording-mode';

registerIcons(CheckIcon, XIcon);

export const SNAPSHOT_TYPES: { value: PhotoCaptureType; label: string; hint: string }[] = [
  { value: 'AREA_OVERVIEW', label: 'Area overview', hint: 'Wide shot showing the whole area' },
  { value: 'FINDING_CONTEXT', label: 'Finding context', hint: 'Where the issue sits in the room' },
  { value: 'FINDING_CLOSE_UP', label: 'Finding close-up', hint: 'The issue itself, in detail' },
  { value: 'SUPPORTING_ANGLE', label: 'Supporting angle', hint: 'A second view of the same issue' },
  { value: 'SCALE_REFERENCE', label: 'Scale reference', hint: 'Something for size comparison' },
  { value: 'SERIAL_OR_LABEL', label: 'Serial or label', hint: 'Model plate, serial, or sticker' },
  {
    value: 'VIDEO_FRAME_SNAPSHOT',
    label: 'Video-frame evidence',
    hint: 'A still pulled from the recording',
  },
  { value: 'OTHER', label: 'Other', hint: 'Anything the categories above do not cover' },
];

/**
 * Sheets follow the app theme, unlike the camera chrome.
 *
 * They cover the preview entirely, so there is no readability reason to pin
 * them dark, and a technician switching between this and the rest of the app
 * should not meet a different visual language.
 */
function Sheet({
  children,
  onClose,
  title,
  visible,
}: {
  children: React.ReactNode;
  onClose: () => void;
  title: string;
  visible: boolean;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal animationType="slide" transparent visible={visible} onRequestClose={onClose}>
      <Pressable
        accessibilityLabel="Close"
        accessibilityRole="button"
        className="flex-1 bg-black/60"
        onPress={onClose}
      />
      <View
        accessibilityViewIsModal
        className="rounded-t-3xl bg-background"
        style={{ paddingBottom: Math.max(insets.bottom, SPACING.base) + SPACING.sm }}
      >
        <View
          className="flex-row items-center px-5 pb-2 pt-4"
          style={{ gap: SPACING.md }}
        >
          <Text className="min-w-0 flex-1 text-lg font-bold text-foreground">{title}</Text>
          <Pressable
            accessibilityLabel="Close"
            accessibilityRole="button"
            className="h-11 w-11 items-center justify-center rounded-full bg-muted active:opacity-70"
            onPress={onClose}
          >
            <XIcon size={18} className="text-foreground" />
          </Pressable>
        </View>
        {children}
      </View>
    </Modal>
  );
}

export function SnapshotTypeSheet({
  visible,
  selected,
  onSelect,
  onClose,
}: {
  visible: boolean;
  selected: PhotoCaptureType;
  onSelect: (value: PhotoCaptureType) => void;
  onClose: () => void;
}) {
  return (
    <Sheet title="Next snapshot" visible={visible} onClose={onClose}>
      <ScrollView className="max-h-96" contentContainerStyle={{ paddingBottom: SPACING.sm }}>
        <View accessibilityRole="radiogroup" className="px-5">
          {SNAPSHOT_TYPES.map((type) => {
            const active = type.value === selected;
            return (
              <Pressable
                accessibilityLabel={`${type.label}. ${type.hint}`}
                accessibilityRole="radio"
                accessibilityState={{ selected: active }}
                className={`min-h-14 flex-row items-center rounded-xl px-3 py-3 active:opacity-70 ${
                  active ? 'bg-primary/10' : ''
                }`}
                key={type.value}
                style={{ gap: SPACING.md }}
                // Selecting applies and closes: one tap, one unambiguous
                // outcome, no separate confirm step to forget.
                onPress={() => {
                  onSelect(type.value);
                  onClose();
                }}
              >
                <View className="min-w-0 flex-1">
                  <Text
                    className={`text-sm font-semibold ${
                      active ? 'text-primary' : 'text-foreground'
                    }`}
                  >
                    {type.label}
                  </Text>
                  <Text className="mt-0.5 text-xs text-muted-foreground">{type.hint}</Text>
                </View>
                {active ? <CheckIcon size={18} className="text-primary" /> : null}
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
    </Sheet>
  );
}

export function GuideSheet({
  visible,
  onClose,
  mode,
  guidance,
  purpose,
}: {
  visible: boolean;
  onClose: () => void;
  mode: RecordingMode;
  guidance: Guidance;
  purpose?: string | null;
}) {
  const primary = mode === 'PRIMARY_AREA_WALKTHROUGH';
  const purposeDetail = purposeByValue(purpose as never);

  return (
    <Sheet title={primary ? 'Walkthrough guide' : 'Capture guide'} visible={visible} onClose={onClose}>
      <View className="px-5" style={{ gap: SPACING.base }}>
        <View>
          <Text className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Current step
          </Text>
          <Text className="mt-1 text-base font-semibold text-foreground">
            {guidance.headline}
          </Text>
          <Text className="mt-0.5 text-sm leading-5 text-muted-foreground">
            {guidance.instruction}
          </Text>
        </View>

        {primary ? (
          <View>
            <Text className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Progress
            </Text>
            <Text className="mt-1 text-base font-semibold text-foreground">
              {Math.round(guidance.progress * 100)}% of the turn
            </Text>
          </View>
        ) : null}

        <View>
          <Text className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {primary ? 'The walkthrough' : 'Recommended capture'}
          </Text>
          {/* Short and ordered. The full procedure belongs here, not over the
              live preview where it would compete with the room. */}
          {(primary
            ? [
                'Face Wall 1 and hold a wide view.',
                'Move clockwise, slowly, keeping walls in frame.',
                'Cover upper, middle and lower surfaces.',
                'Pause on anything of concern and mark it.',
                'Return to Wall 1, then stop and review.',
              ]
            : [
                purposeDetail?.guidance ?? 'Start wide for context, then move closer.',
                'Narrate what you are showing and why.',
                'Stop once the evidence is clear.',
              ]
          ).map((line, index) => (
            <View className="mt-2 flex-row" key={line} style={{ gap: SPACING.sm }}>
              <Text className="text-sm font-bold text-primary">{index + 1}</Text>
              <Text className="min-w-0 flex-1 text-sm leading-5 text-foreground">{line}</Text>
            </View>
          ))}
        </View>

        <Text className="text-xs leading-5 text-muted-foreground">
          Motion tracking is an estimate. Your recording and photos are the evidence — the
          office reviews them.
        </Text>
      </View>
    </Sheet>
  );
}
