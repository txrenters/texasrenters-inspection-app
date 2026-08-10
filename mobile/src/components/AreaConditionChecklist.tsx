import { CheckIcon, ClipboardListIcon, MinusIcon, XIcon } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import type { ChecklistAssessment, ChecklistItemWithAssessment } from '../domain/models';
import { registerIcons } from '../lib/icons';

registerIcons(CheckIcon, ClipboardListIcon, MinusIcon, XIcon);

/** The three axes the printed report scores, in the order it prints them. */
const AXES = [
  { key: 'isClean', label: 'Clean' },
  { key: 'isUndamaged', label: 'Undamaged' },
  { key: 'isWorking', label: 'Working' },
] as const;

type AxisKey = (typeof AXES)[number]['key'];

/**
 * One axis as a three-state control.
 *
 * Yes / No / unassessed, rather than a checkbox. A checkbox has no way to say
 * "I did not assess this", so an item the technician skipped would be
 * indistinguishable from one they found faulty — and the report prints those
 * cells blank precisely because the distinction matters.
 *
 * Tapping the active value clears it back to unassessed, so a mistap is
 * recoverable without a separate reset control.
 */
function AxisControl({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: boolean | null;
  disabled: boolean;
  onChange: (next: boolean | null) => void;
}) {
  const state = value === null ? 'Not assessed' : value ? 'Yes' : 'No';
  return (
    <View className="flex-1">
      <Text className="mb-1.5 text-center text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </Text>
      <View className="flex-row gap-1">
        {[true, false].map((option) => {
          const active = value === option;
          return (
            <Pressable
              accessibilityLabel={`${label}: ${option ? 'yes' : 'no'}`}
              accessibilityRole="radio"
              accessibilityState={{ checked: active, disabled }}
              className={`min-h-11 flex-1 items-center justify-center rounded-lg border ${
                active
                  ? option
                    ? 'border-chart-3 bg-chart-3/15'
                    : 'border-destructive bg-destructive/10'
                  : 'border-border bg-card'
              } ${disabled ? 'opacity-50' : 'active:opacity-70'}`}
              disabled={disabled}
              key={String(option)}
              // Tapping the active value clears it — the only way back to
              // "not assessed" once something has been chosen.
              onPress={() => onChange(active ? null : option)}
            >
              {option ? (
                <CheckIcon
                  size={16}
                  className={active ? 'text-chart-3' : 'text-muted-foreground'}
                />
              ) : (
                <XIcon
                  size={16}
                  className={active ? 'text-destructive' : 'text-muted-foreground'}
                />
              )}
            </Pressable>
          );
        })}
      </View>
      {/* Never colour alone: the chosen state is also stated in words. */}
      <Text className="mt-1 text-center text-[10px] text-muted-foreground">{state}</Text>
    </View>
  );
}

function ChecklistItemRow({
  item,
  disabled,
  onChange,
}: {
  item: ChecklistItemWithAssessment;
  disabled: boolean;
  onChange: (assessment: ChecklistAssessment) => void;
}) {
  // Local so typing stays responsive; committed on blur rather than per
  // keystroke, which would queue a write for every letter typed offline.
  const [comment, setComment] = useState<string | null>(null);
  const displayedComment = comment ?? item.comment ?? '';

  const current: ChecklistAssessment = {
    isClean: item.isClean,
    isUndamaged: item.isUndamaged,
    isWorking: item.isWorking,
    comment: item.comment,
  };
  const assessed = AXES.some((axis) => item[axis.key] !== null);

  return (
    <View className="border-b border-border py-4 last:border-b-0">
      <View className="flex-row items-center gap-2">
        {assessed ? (
          <CheckIcon size={14} className="text-chart-3" />
        ) : (
          <MinusIcon size={14} className="text-muted-foreground" />
        )}
        <Text className="min-w-0 flex-1 text-sm font-semibold text-foreground">{item.label}</Text>
      </View>

      <View className="mt-3 flex-row gap-2">
        {AXES.map((axis) => (
          <AxisControl
            disabled={disabled}
            key={axis.key}
            label={axis.label}
            onChange={(next) => onChange({ ...current, [axis.key as AxisKey]: next })}
            value={item[axis.key]}
          />
        ))}
      </View>

      <TextInput
        accessibilityLabel={`Comment for ${item.label}`}
        className="mt-3 min-h-11 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
        editable={!disabled}
        multiline
        onBlur={() => {
          const next = displayedComment.trim() || null;
          if (next !== (item.comment ?? null)) onChange({ ...current, comment: next });
          setComment(null);
        }}
        onChangeText={setComment}
        placeholder="Comment (optional)"
        placeholderTextColor="#94a3b8"
        value={displayedComment}
      />
    </View>
  );
}

/**
 * The condition checklist for one area.
 *
 * This is what the office's printed report is built from: every item scored
 * Clean / Undamaged / Working with a comment. It is deliberately separate from
 * the in-camera coverage prompt, which answers a different question — that one
 * tracks whether the technician *talked about* an item during the walkthrough,
 * this one records what they *found*.
 */
export function AreaConditionChecklist({
  items,
  disabled = false,
  disabledReason,
  onChange,
}: {
  items: readonly ChecklistItemWithAssessment[];
  /** Set once the inspection is finalized; the server refuses writes then. */
  disabled?: boolean;
  disabledReason?: string;
  onChange: (itemId: string, assessment: ChecklistAssessment) => void;
}) {
  if (!items.length) return null;

  const assessed = items.filter((item) =>
    AXES.some((axis) => item[axis.key] !== null),
  ).length;

  return (
    <View className="mx-5 mt-4 rounded-2xl bg-card p-5">
      <View className="flex-row items-center justify-between">
        <View className="flex-row items-center gap-2">
          <ClipboardListIcon size={17} className="text-primary" />
          <Text className="text-base font-semibold text-foreground">Condition checklist</Text>
        </View>
        <View
          accessibilityLabel={`${assessed} of ${items.length} items assessed`}
          className={`rounded-full px-2.5 py-1 ${
            assessed >= items.length ? 'bg-chart-3/15' : 'bg-muted'
          }`}
        >
          <Text
            className={`text-xs font-semibold ${
              assessed >= items.length ? 'text-chart-3' : 'text-muted-foreground'
            }`}
          >
            {assessed}/{items.length}
          </Text>
        </View>
      </View>

      <Text className="mt-1 text-xs leading-5 text-muted-foreground">
        {disabled
          ? (disabledReason ?? 'This inspection is closed.')
          : 'Leave an axis untouched if you did not assess it — blank is not the same as No.'}
      </Text>

      <View className="mt-2">
        {items.map((item) => (
          <ChecklistItemRow
            disabled={disabled}
            item={item}
            key={item.id}
            onChange={(assessment) => onChange(item.id, assessment)}
          />
        ))}
      </View>
    </View>
  );
}
