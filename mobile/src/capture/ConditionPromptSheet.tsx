import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, XIcon } from 'lucide-react-native';
import { useMemo, useRef, useState } from 'react';
import { PanResponder, Pressable, Text, View } from 'react-native';

import { BottomSheet } from '../components/BottomSheet';
import type { ChecklistAssessment, ChecklistItemWithAssessment } from '../domain/models';
import { registerIcons } from '../lib/icons';

registerIcons(CheckIcon, ChevronLeftIcon, ChevronRightIcon, XIcon);

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

/** The answers already stored for an item, as a draft to edit. */
function assessmentOf(item: ChecklistItemWithAssessment | undefined): ChecklistAssessment {
  if (!item) return EMPTY;
  return {
    isClean: item.isClean,
    isUndamaged: item.isUndamaged,
    isWorking: item.isWorking,
    comment: null,
  };
}

const isAnswered = (item: ChecklistItemWithAssessment) =>
  item.isClean !== null || item.isUndamaged !== null || item.isWorking !== null;

/** Every axis answered, so the item can be written as a complete assessment. */
const isComplete = (draft: ChecklistAssessment) =>
  draft.isClean !== null && draft.isUndamaged !== null && draft.isWorking !== null;

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
            <Icon size={26} className={option ? 'text-chart-3' : 'text-destructive'} />
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
 * It is also a list the technician can simply read. Closing with "Later" and
 * reopening from the camera's checklist button lands back here, and swiping or
 * pressing the arrows walks every item in either direction without answering
 * anything — a technician who wants to know what is coming before they start
 * filming should not have to answer their way through it to find out.
 *
 * Every answer is saved as soon as it is complete, not batched at the end. A
 * recording interrupted by a call or a dead battery keeps what was assessed.
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
   * The item being shown, chosen once when the sheet first mounts.
   *
   * The first *unanswered* one rather than the first in the list, so the
   * technician starts where there is work rather than re-reading what they have
   * already scored. Browsing from there is free in both directions.
   */
  const firstUnanswered = Math.max(
    0,
    items.findIndex((row) => !isAnswered(row)),
  );
  const [index, setIndex] = useState(firstUnanswered);
  const [axis, setAxis] = useState(0);
  /**
   * Answers for the item on screen, held locally until every axis is in.
   *
   * Hydrated from what is already stored whenever the item changes. It used to
   * reset to empty on every move, which made browsing useless and actively
   * misleading — stepping back to an item you had just answered showed it
   * blank, as though the answer had been lost.
   *
   * The item is written once, complete: the API takes the whole assessment on
   * every call, so writing after each axis would send rows that each clear the
   * answers given before them.
   */
  const [draft, setDraft] = useState<ChecklistAssessment>(() => assessmentOf(items[firstUnanswered]));

  const item = items[index];
  const remaining = useMemo(() => items.filter((row) => !isAnswered(row)).length, [items]);

  function goToItem(next: number) {
    if (next < 0 || next >= items.length) return;
    setIndex(next);
    setAxis(0);
    setDraft(assessmentOf(items[next]));
  }

  /**
   * Horizontal swipe moves between items.
   *
   * Claimed only once the drag is clearly sideways and past a threshold, so it
   * cannot steal a tap on the large Yes/No targets directly beneath it — those
   * are the controls a technician is aiming at while holding a phone one-handed,
   * and losing one to an over-eager gesture would silently misfile an answer.
   */
  const swipe = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_event, gesture) =>
        Math.abs(gesture.dx) > 24 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 2,
      onPanResponderRelease: (_event, gesture) => {
        if (gesture.dx <= -40) goToItemRef.current(indexRef.current + 1);
        else if (gesture.dx >= 40) goToItemRef.current(indexRef.current - 1);
      },
    }),
  ).current;
  // PanResponder is created once, so its handlers would close over the first
  // render's state forever. Refs keep them pointed at the current values.
  const indexRef = useRef(index);
  indexRef.current = index;
  const goToItemRef = useRef(goToItem);
  goToItemRef.current = goToItem;

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
  const atFirst = index === 0;
  const atLast = index === items.length - 1;

  function answer(value: boolean) {
    const next = { ...draft, [current.key as AxisKey]: value };
    setDraft(next);
    // Written the moment every axis is known, rather than only on the third tap.
    // Revisiting an answered item to correct one axis completes the assessment
    // immediately, so the correction is saved even if the technician swipes away
    // without touching the other two.
    if (isComplete(next)) onRecord(item!.id, next);
    if (axis < AXES.length - 1) {
      setAxis(axis + 1);
      return;
    }
    // Last axis of a freshly answered item: move on, so the sequence runs
    // without the technician reaching for anything.
    //
    // Deliberately *not* closing and reopening between items. That was the first
    // attempt, and it does not work: React Native's Modal silently refuses to
    // show again while the previous dismissal is still animating, so the next
    // question never appeared. Any fixed delay is a race against an animation
    // whose length is not ours to know.
    if (atLast) {
      // Finishing the last item closes the sheet. Advancing past it renders the
      // "complete" panel, and with nothing to close it that panel sat over the
      // camera telling the technician to stop recording, every time, for the
      // rest of the area. The panel is worth keeping for someone who *opens* the
      // checklist with nothing left to answer; not for someone who just finished.
      onClose();
      return;
    }
    goToItem(index + 1);
  }

  function back() {
    if (axis > 0) {
      setAxis(axis - 1);
      return;
    }
    goToItem(index - 1);
  }

  return (
    <BottomSheet onClose={onClose} visible={visible}>
      <View {...swipe.panHandlers}>
        <View className="flex-row items-center justify-between gap-3">
          <Text className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Item {index + 1} of {items.length}
            {remaining ? ` · ${remaining} unassessed` : ''}
          </Text>
          <Pressable
            accessibilityLabel="Close checklist"
            accessibilityRole="button"
            hitSlop={8}
            onPress={onClose}
          >
            <Text className="text-sm font-semibold text-muted-foreground">Later</Text>
          </Pressable>
        </View>

        {/* Item navigation, level with the item name: browsing the list is a
            first-class action here, not a consolation for not answering. */}
        <View className="mt-3 flex-row items-center gap-2">
          <Pressable
            accessibilityLabel="Previous item"
            accessibilityRole="button"
            className="h-11 w-11 items-center justify-center rounded-full bg-muted active:scale-[0.95]"
            disabled={atFirst}
            hitSlop={4}
            onPress={() => goToItem(index - 1)}
          >
            <ChevronLeftIcon
              size={20}
              className={atFirst ? 'text-muted-foreground/40' : 'text-foreground'}
            />
          </Pressable>
          <View className="min-w-0 flex-1">
            <Text className="text-xl font-bold text-foreground" numberOfLines={2}>
              {item.label}
            </Text>
          </View>
          <Pressable
            accessibilityLabel="Next item"
            accessibilityRole="button"
            className="h-11 w-11 items-center justify-center rounded-full bg-muted active:scale-[0.95]"
            disabled={atLast}
            hitSlop={4}
            onPress={() => goToItem(index + 1)}
          >
            <ChevronRightIcon
              size={20}
              className={atLast ? 'text-muted-foreground/40' : 'text-foreground'}
            />
          </Pressable>
        </View>

        <Text className="mt-1 text-base text-muted-foreground">{current.question}</Text>

        {/* The axes for this item, so the technician can see what they said
            without leaving the question. Tappable, so correcting one answer does
            not mean answering all three again. */}
        <View className="mt-3 flex-row gap-2">
          {AXES.map((entry, position) => {
            const value = draft[entry.key as AxisKey];
            return (
              <Pressable
                accessibilityLabel={`${entry.label}: ${
                  value === null ? 'not answered' : value ? 'yes' : 'no'
                }`}
                accessibilityRole="button"
                accessibilityState={{ selected: position === axis }}
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
                onPress={() => setAxis(position)}
              >
                <Text className="text-[11px] font-semibold text-muted-foreground">
                  {entry.label}
                  {value === null ? '' : value ? ' ✓' : ' ✗'}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <AnswerRow onAnswer={answer} value={draft[current.key as AxisKey]} />

        <View className="mt-3 flex-row items-center justify-between">
          <Pressable
            accessibilityLabel="Previous question"
            accessibilityRole="button"
            className="min-h-11 flex-row items-center gap-1 px-1"
            disabled={atFirst && axis === 0}
            onPress={back}
          >
            <ChevronLeftIcon
              size={16}
              className={atFirst && axis === 0 ? 'text-muted-foreground' : 'text-foreground'}
            />
            <Text
              className={`text-sm ${atFirst && axis === 0 ? 'text-muted-foreground' : 'text-foreground'}`}
            >
              Back
            </Text>
          </Pressable>
          <Text className="text-[11px] text-muted-foreground">Swipe to browse</Text>
          <Pressable
            accessibilityLabel="Skip this item"
            accessibilityRole="button"
            className="min-h-11 justify-center px-1"
            onPress={() => {
              // Skipped, not answered: the item keeps its nulls, and the report
              // prints those cells blank rather than as a fault.
              if (atLast) {
                onClose();
                return;
              }
              goToItem(index + 1);
            }}
          >
            <Text className="text-sm text-muted-foreground">Skip item</Text>
          </Pressable>
        </View>

        {saving ? <Text className="mt-2 text-xs text-muted-foreground">Saving…</Text> : null}
      </View>
    </BottomSheet>
  );
}
