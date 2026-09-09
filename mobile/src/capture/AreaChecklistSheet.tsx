import { CheckIcon, CircleIcon, MicIcon } from 'lucide-react-native';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { BottomSheet } from '../components/BottomSheet';
import { registerIcons } from '../lib/icons';
import type { ChecklistAssessment } from '../domain/models';
import { checklistProgress, type ChecklistItem } from './area-checklist';
import { choiceInvitesComment } from '@texasrenters/shared';

import { CommentField, ChoiceField, ReadingField, TextField, isAnswered } from './ChecklistAnswerFields';

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

/**
 * The control an item's answer needs.
 *
 * Kept beside the sheet rather than inside the map so the branch reads as one
 * decision. An item whose type the app does not recognise falls back to the
 * three axes, which is what every checklist was before the HVAC form.
 */
function renderAnswer(
  item: ChecklistItem,
  assessment: ChecklistAssessment | undefined,
  onAssess: (itemId: string, axis: ChecklistAxisKey, next: boolean | null) => void,
  onRecord?: (itemId: string, patch: { numericValue?: number | null; textValue?: string | null; comment?: string | null }) => void,
) {
  switch (item.responseType ?? 'STATUS') {
    case 'READING':
      return onRecord ? (
        <ReadingField
          item={item}
          onChange={(numericValue) => onRecord(item.id, { numericValue })}
          value={assessment?.numericValue ?? null}
        />
      ) : null;
    case 'TEXT':
      return onRecord ? (
        <TextField
          item={item}
          onChange={(textValue) => onRecord(item.id, { textValue })}
          value={assessment?.textValue ?? null}
        />
      ) : null;
    case 'CHOICE':
      return onRecord ? (
        <>
          <ChoiceField
            item={item}
            onChange={(textValue) =>
              onRecord(item.id, {
                textValue,
                // Clearing the answer clears the explanation with it. A comment
                // about damage left behind on a row now answered "Clean" is
                // worse than no comment: it reads as a finding on a room the
                // technician has just said is fine.
                ...(choiceInvitesComment(textValue) ? {} : { comment: null }),
              })
            }
            value={assessment?.textValue ?? null}
          />
          {/* Only once an answer says there is something to explain. A box on
              every row is the toll the feedback asked us to remove. */}
          {choiceInvitesComment(assessment?.textValue) ? (
            <CommentField
              item={item}
              onChange={(comment) => onRecord(item.id, { comment })}
              value={assessment?.comment ?? null}
            />
          ) : null}
        </>
      ) : null;
    default:
      return (
        <AxisRow
          assessment={assessment}
          label={item.label}
          onAnswer={(axis, next) => onAssess(item.id, axis, next)}
        />
      );
  }
}

export function AreaChecklistSheet({
  areaName,
  assessments,
  items,
  checkedIds,
  onAssess,
  onRecord,
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
  /**
   * Records an answer that is not one of the three axes — a measurement, a
   * line of text, or a chosen option. Separate from `onAssess` because those
   * carry a value rather than a yes/no, and collapsing the two would make every
   * caller unpack a union to find out which it had.
   */
  onRecord?: (itemId: string, patch: { numericValue?: number | null; textValue?: string | null; comment?: string | null }) => void;
  checkedIds: readonly string[];
  onToggle: (id: string) => void;
  visible: boolean;
  onClose: () => void;
  /** Drives the "listening" hint; the sheet itself never touches the microphone. */
  recording: boolean;
}) {
  /**
   * Coverage counts an assessed item as covered.
   *
   * There are two records over the same list: a coverage tick, set by tapping a
   * row or by the transcript mentioning it, and a condition assessment written
   * to the server. The header only ever counted the first, so a technician who
   * answered Clean / Undamaged / Working on every item was still told 0 of 7 —
   * the work was done and the screen said none of it was.
   *
   * Answering three axes about an item is not something you can do without
   * having looked at it, so it counts. The union, not a replacement: spoken
   * coverage still ticks items nobody answered by hand.
   */
  /**
   * Answered counts as covered, for every shape of answer.
   *
   * This used to look only at the three yes/no axes, so on an HVAC checklist a
   * technician could fill in all eight measurements and still be told nothing
   * was covered.
   */
  const assessedIds = items
    .filter((item) => isAnswered(item, assessments?.get(item.id)))
    .map((item) => item.id);
  const { covered, total } = checklistProgress(items, [
    ...new Set([...checkedIds, ...assessedIds]),
  ]);
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

      {/*
        Said before the list, not after it.

        This sentence used to sit at the bottom, under the last item — which on
        a move-out is eighty-three rows down, and on any list is after the
        technician has already decided the thing looks mandatory. The 2026-09-09
        field feedback reported the checklist as *preventing* completion. It
        never has: no answer here is consulted by the area gate or by
        `completeInspection`. What the screen did was imply otherwise, and an
        implication answered at the end is not answered at all.
      */}
      <Text className="mt-3 text-xs leading-4 text-muted-foreground">
        Optional. Nothing here has to be answered to finish this area — it is a guide, and a record
        of what you covered.
      </Text>

      {recording ? (
        <View className="mt-3 flex-row items-center gap-2 rounded-xl bg-primary/10 px-3 py-2.5">
          <MicIcon size={15} className="text-primary" />
          <Text className="min-w-0 flex-1 text-xs leading-4 text-primary">
            Items tick themselves when you mention them out loud. Tap any item to set it yourself.
          </Text>
        </View>
      ) : null}

      <ScrollView className="mt-4" showsVerticalScrollIndicator={false}>
        {items.map((item, index) => {
          const isChecked = checked.has(item.id);
          // Printed when it changes rather than by grouping into nested lists:
          // the form has eleven sections and a technician scrolls straight
          // through them in order.
          const heading =
            item.section && item.section !== items[index - 1]?.section ? item.section : null;
          return (
            <View key={`group-${item.id}`}>
            {heading ? (
              <Text className="mb-1.5 mt-3 px-1 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                {heading}
              </Text>
            ) : null}
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
              {onAssess ? renderAnswer(item, assessments?.get(item.id), onAssess, onRecord) : null}
            </View>
            </View>
          );
        })}
        {/* The "does not block" half of this moved above the list, where it is
            read before the technician forms an impression rather than after.
            What is left is the part that is genuinely a footnote. */}
        <Text className="mb-2 mt-1 px-1 text-xs leading-4 text-muted-foreground">
          The checklist records coverage. It does not replace the walkthrough.
        </Text>
      </ScrollView>
    </BottomSheet>
  );
}
