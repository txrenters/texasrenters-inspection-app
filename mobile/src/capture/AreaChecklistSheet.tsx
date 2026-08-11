import { CheckIcon, CircleIcon, MicIcon } from 'lucide-react-native';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { BottomSheet } from '../components/BottomSheet';
import { registerIcons } from '../lib/icons';
import type { ChecklistAssessment } from '../domain/models';
import { checklistProgress, type ChecklistItem } from './area-checklist';

registerIcons(CheckIcon, CircleIcon, MicIcon);

/**
 * The area's coverage checklist, opened from the camera's guide control.
 *
 * Replaces a static "Room capture guide" alert that said the same three
 * sentences in every room. This is specific to the area being recorded, and
 * doubles as a record of what the technician actually covered.
 *
 * Ticking is manual here. Items are also ticked automatically when the
 * technician says them aloud — see `matchChecklistMentions` — but a mention is
 * only evidence that something was talked about, so the technician stays able
 * to correct it either way.
 */
/** The three axes the printed report scores, in the order it prints them. */
const AXES = [
  { key: 'isClean', label: 'Clean' },
  { key: 'isUndamaged', label: 'Undamaged' },
  { key: 'isWorking', label: 'Working' },
] as const;

export type ChecklistAxisKey = (typeof AXES)[number]['key'];

/**
 * Clean / Undamaged / Working for one item, answered in place.
 *
 * Yes / No / unanswered rather than a checkbox: a checkbox cannot say "I did
 * not assess this", so a skipped item would be indistinguishable from a faulty
 * one, and the report prints those cells blank precisely because the
 * distinction matters. Tapping the active answer clears it.
 */
function AxisRow({
  assessment,
  label,
  onAnswer,
}: {
  assessment: ChecklistAssessment | undefined;
  label: string;
  onAnswer: (axis: ChecklistAxisKey, next: boolean | null) => void;
}) {
  return (
    <View className="mt-2 flex-row gap-2">
      {AXES.map((axis) => {
        const value = assessment?.[axis.key] ?? null;
        return (
          <View className="flex-1" key={axis.key}>
            <Text className="mb-1 text-center text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {axis.label}
            </Text>
            <View className="flex-row gap-1">
              {[true, false].map((option) => {
                const active = value === option;
                return (
                  <Pressable
                    accessibilityLabel={`${label}, ${axis.label}: ${option ? 'yes' : 'no'}`}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: active }}
                    className={`min-h-11 flex-1 items-center justify-center rounded-lg border ${
                      active
                        ? option
                          ? 'border-chart-3 bg-chart-3/20'
                          : 'border-destructive bg-destructive/15'
                        : 'border-border bg-card'
                    }`}
                    key={String(option)}
                    onPress={() => onAnswer(axis.key, active ? null : option)}
                  >
                    <Text
                      className={`text-xs font-bold ${
                        active
                          ? option
                            ? 'text-chart-3'
                            : 'text-destructive'
                          : 'text-muted-foreground'
                      }`}
                    >
                      {option ? 'Y' : 'N'}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        );
      })}
    </View>
  );
}

export function AreaChecklistSheet({
  areaName,
  assessments,
  items,
  checkedIds,
  onAssess,
  onToggle,
  visible,
  onClose,
  recording,
}: {
  areaName: string;
  items: ChecklistItem[];
  /** Current condition answers, keyed by checklist item id. */
  assessments?: Map<string, ChecklistAssessment>;
  /** Records one axis. Omitted when there is nothing to record against. */
  onAssess?: (itemId: string, axis: ChecklistAxisKey, next: boolean | null) => void;
  checkedIds: readonly string[];
  onToggle: (id: string) => void;
  visible: boolean;
  onClose: () => void;
  /** Drives the "listening" hint; the sheet itself never touches the microphone. */
  recording: boolean;
}) {
  const { covered, total } = checklistProgress(items, checkedIds);
  const checked = new Set(checkedIds);

  return (
    <BottomSheet className="max-h-[82%]" onClose={onClose} visible={visible}>
      <View className="flex-row items-start justify-between gap-3">
        <View className="min-w-0 flex-1">
          <Text className="text-xl font-bold text-foreground">{areaName} checklist</Text>
          <Text
            accessibilityLabel={`${covered} of ${total} items covered`}
            className="mt-1 text-sm text-muted-foreground"
          >
            {covered} of {total} covered
          </Text>
        </View>
        <Pressable
          accessibilityLabel="Close checklist"
          accessibilityRole="button"
          className="min-h-11 justify-center px-2"
          onPress={onClose}
        >
          <Text className="font-semibold text-primary">Done</Text>
        </Pressable>
      </View>

      {recording ? (
        <View className="mt-4 flex-row items-center gap-2 rounded-xl bg-primary/10 px-3 py-2.5">
          <MicIcon size={15} className="text-primary" />
          <Text className="min-w-0 flex-1 text-xs leading-4 text-primary">
            Items tick themselves when you mention them out loud. Tap any item to set it yourself.
          </Text>
        </View>
      ) : null}

      <ScrollView className="mt-4" showsVerticalScrollIndicator={false}>
        {items.map((item) => {
          const isChecked = checked.has(item.id);
          return (
            <View
              className={`mb-2 rounded-xl border px-4 py-3 ${
                isChecked ? 'border-chart-3/40 bg-chart-3/10' : 'border-border bg-card'
              }`}
              key={item.id}
            >
              <Pressable
                accessibilityHint={isChecked ? 'Marks this as not covered' : 'Marks this covered'}
                accessibilityLabel={item.label}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: isChecked }}
                className="min-h-11 flex-row items-center gap-3"
                onPress={() => onToggle(item.id)}
              >
              {isChecked ? (
                <CheckIcon size={18} className="text-chart-3" />
              ) : (
                <CircleIcon size={18} className="text-muted-foreground" />
              )}
              <Text
                className={`min-w-0 flex-1 text-sm ${
                  isChecked ? 'font-semibold text-foreground' : 'text-foreground'
                }`}
              >
                {item.label}
              </Text>
              </Pressable>
              {/* The condition answers sit in the same card as the item they
                  are about. This is the checklist the technician already opens
                  from the camera; asking them to score somewhere else is the
                  extra step this workflow exists to remove. */}
              {onAssess ? (
                <AxisRow
                  assessment={assessments?.get(item.id)}
                  label={item.label}
                  onAnswer={(axis, next) => onAssess(item.id, axis, next)}
                />
              ) : null}
            </View>
          );
        })}
        <Text className="mb-2 mt-1 px-1 text-xs leading-4 text-muted-foreground">
          The checklist guides coverage. It does not replace the walkthrough video, and an unticked
          item does not block completing the area.
        </Text>
      </ScrollView>
    </BottomSheet>
  );
}
