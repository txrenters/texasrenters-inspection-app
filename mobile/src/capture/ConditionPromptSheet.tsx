import { CheckIcon, ChevronLeftIcon, XIcon } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { BottomSheet } from '../components/BottomSheet';
import type { ChecklistAssessment, ChecklistItemWithAssessment } from '../domain/models';
import { registerIcons } from '../lib/icons';

registerIcons(CheckIcon, ChevronLeftIcon, XIcon);

/** The three axes the printed report scores, in the order it prints them. */
const AXES = [
  { key: 'isClean', label: 'Clean', question: 'Is it clean?' },
  { key: 'isUndamaged', label: 'Undamaged', question: 'Is it undamaged?' },
  { key: 'isWorking', label: 'Working', question: 'Is it working?' },
] as const;

type AxisKey = (typeof AXES)[number]['key'];

const EMPTY: ChecklistAssessment = {
  isClean: null,
  isUndamaged: null,
  isWorking: null,
  comment: null,
};

/**
 * One large Yes/No pair, sized for a thumb while the other hand holds the phone.
 *
 * Deliberately not a small tri-state toggle: this is answered mid-recording,
 * often at arm's length, and a mistap costs a wrong assessment in the report.
 * Clearing is done with Back rather than by tapping the active answer again —
 * an accidental double-tap on a control this size is far likelier than a
 * deliberate one, and silently unsetting an answer would be invisible here.
 */
function AnswerRow({
  onAnswer,
  value,
}: {
  onAnswer: (next: boolean) => void;
  value: boolean | null;
}) {
  return (
    <View className="mt-5 flex-row gap-3">
      {[true, false].map((option) => {
        const active = value === option;
        const Icon = option ? CheckIcon : XIcon;
        return (
          <Pressable
            accessibilityLabel={option ? 'Yes' : 'No'}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            className={`min-h-20 flex-1 items-center justify-center gap-1 rounded-2xl border-2 active:scale-[0.97] ${
              active
                ? option
                  ? 'border-chart-3 bg-chart-3/20'
                  : 'border-destructive bg-destructive/15'
                : 'border-border bg-card'
            }`}
            key={String(option)}
            onPress={() => onAnswer(option)}
          >
            <Icon
              size={26}
              className={option ? 'text-chart-3' : 'text-destructive'}
            />
            <Text className="text-base font-semibold text-foreground">{option ? 'Yes' : 'No'}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * The detailed condition checklist, walked one question at a time.
 *
 * Opens once the sensor confirms the 360 sweep, so the technician records the
 * room first and assesses it second, while still standing in it. Each item is
 * asked on all three axes the report scores rather than as a single verdict:
 * the office needs to know *which* of clean, undamaged and working failed, and
 * reconstructing that from a video afterwards is the hour-long review this is
 * meant to replace.
 *
 * Every answer is saved as it is given, not batched at the end. A recording
 * interrupted by a call or a dead battery keeps what was already assessed.
 */
export function ConditionPromptSheet({
  items,
  onClose,
  onRecord,
  saving,
  visible,
}: {
  items: ChecklistItemWithAssessment[];
  onClose: () => void;
  onRecord: (itemId: string, assessment: ChecklistAssessment) => void;
  saving: boolean;
  visible: boolean;
}) {
  /**
   * The item being asked, chosen when the sheet opens.
   *
   * The first *unanswered* one rather than the first in the list, so reopening
   * continues where the technician left off instead of re-asking what they have
   * already scored.
   */
  const firstUnanswered = Math.max(
    0,
    items.findIndex(
      (row) => row.isClean === null && row.isUndamaged === null && row.isWorking === null,
    ),
  );
  const [index, setIndex] = useState(firstUnanswered);
  const [axis, setAxis] = useState(0);
  /**
   * Answers for the item being asked, held locally until all three axes are in.
   *
   * The item is written once, complete: the API takes the whole assessment on
   * every call, so writing after each axis would send two rows that each clear
   * the answers given before them.
   */
  const [draft, setDraft] = useState<ChecklistAssessment>(EMPTY);

  const item = items[index];
  const remaining = useMemo(
    () =>
      items.filter(
        (row) => row.isClean === null && row.isUndamaged === null && row.isWorking === null,
      ).length,
    [items],
  );

  if (!item)
    return (
      <BottomSheet onClose={onClose} visible={visible}>
        <Text className="text-lg font-bold text-foreground">Checklist complete</Text>
        <Text className="mt-2 text-sm leading-5 text-muted-foreground">
          Every item in this area has been assessed. Stop the recording when you are done.
        </Text>
        <Pressable
          accessibilityRole="button"
          className="mt-5 min-h-14 items-center justify-center rounded-2xl bg-primary active:scale-[0.98]"
          onPress={onClose}
        >
          <Text className="text-base font-semibold text-primary-foreground">Back to recording</Text>
        </Pressable>
      </BottomSheet>
    );

  const current = AXES[axis]!;

  function answer(value: boolean) {
    const next = { ...draft, [current.key as AxisKey]: value };
    if (axis < AXES.length - 1) {
      setDraft(next);
      setAxis(axis + 1);
      return;
    }
    // Last axis: persist and move straight to the next item.
    //
    // Deliberately *not* closing and reopening between items. That was the
    // first attempt, and it does not work: React Native's Modal silently
    // refuses to show again while the previous dismissal is still animating,
    // so the next question never appeared. Any fixed delay is a race against
    // an animation whose length is not ours to know.
    //
    // Advancing in place is also what the technician wants — the sequence runs
    // without them reaching for anything. The sheet closes when the checklist
    // is finished, or when they choose Later.
    onRecord(item!.id, next);
    setDraft(EMPTY);
    setAxis(0);
    setIndex(index + 1);
  }

  function back() {
    if (axis > 0) {
      setAxis(axis - 1);
      return;
    }
    if (index > 0) {
      setDraft(EMPTY);
      setAxis(0);
      setIndex(index - 1);
    }
  }

  return (
    <BottomSheet onClose={onClose} visible={visible}>
      <View className="flex-row items-center justify-between gap-3">
        <Text className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Item {index + 1} of {items.length}
          {remaining ? ` · ${remaining} unassessed` : ''}
        </Text>
        <Pressable accessibilityLabel="Close checklist" accessibilityRole="button" hitSlop={8} onPress={onClose}>
          <Text className="text-sm font-semibold text-muted-foreground">Later</Text>
        </Pressable>
      </View>

      <Text className="mt-3 text-xl font-bold text-foreground">{item.label}</Text>
      <Text className="mt-1 text-base text-muted-foreground">{current.question}</Text>

      {/* The axes already answered for this item, so the technician can see
          what they said without leaving the question. */}
      <View className="mt-3 flex-row gap-2">
        {AXES.map((entry, position) => {
          const value = draft[entry.key as AxisKey];
          return (
            <View
              className={`rounded-full px-2.5 py-1 ${
                position === axis
                  ? 'bg-primary/15'
                  : value === null
                    ? 'bg-muted'
                    : value
                      ? 'bg-chart-3/15'
                      : 'bg-destructive/15'
              }`}
              key={entry.key}
            >
              <Text className="text-[11px] font-semibold text-muted-foreground">
                {entry.label}
                {value === null ? '' : value ? ' ✓' : ' ✗'}
              </Text>
            </View>
          );
        })}
      </View>

      <AnswerRow onAnswer={answer} value={draft[current.key as AxisKey]} />

      <View className="mt-3 flex-row items-center justify-between">
        <Pressable
          accessibilityLabel="Previous question"
          accessibilityRole="button"
          className="min-h-11 flex-row items-center gap-1 px-1"
          disabled={axis === 0 && index === 0}
          onPress={back}
        >
          <ChevronLeftIcon
            size={16}
            className={axis === 0 && index === 0 ? 'text-muted-foreground' : 'text-foreground'}
          />
          <Text
            className={`text-sm ${axis === 0 && index === 0 ? 'text-muted-foreground' : 'text-foreground'}`}
          >
            Back
          </Text>
        </Pressable>
        <Pressable
          accessibilityLabel="Skip this item"
          accessibilityRole="button"
          className="min-h-11 justify-center px-1"
          onPress={() => {
            // Skipped, not answered: the item keeps its nulls, and the report
            // prints those cells blank rather than as a fault.
            setDraft(EMPTY);
            setAxis(0);
            setIndex(index + 1);
          }}
        >
          <Text className="text-sm text-muted-foreground">Skip item</Text>
        </Pressable>
      </View>

      {saving ? (
        <Text className="mt-2 text-xs text-muted-foreground">Saving…</Text>
      ) : null}
    </BottomSheet>
  );
}
