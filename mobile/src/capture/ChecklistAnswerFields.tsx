import { Pressable, Text, TextInput, View } from 'react-native';

import type { ChecklistAssessment } from '../domain/models';
import type { ChecklistItem } from './area-checklist';

/**
 * The answer controls for the items a tick cannot express.
 *
 * Every checklist in this app was three yes/no axes until the office's HVAC
 * form arrived: sixty items, of which eight are measurements, two are free
 * text, and three are a single choice. A temperature split is the diagnosis of
 * an air-conditioning inspection, and typed into a comment box it is neither
 * comparable between visits nor printable on a report.
 *
 * Separated from `AreaChecklistSheet` because the sheet is already long and
 * these are self-contained: each takes a value and reports a new one.
 */

/**
 * A measurement, with its unit shown rather than assumed.
 *
 * `decimal-pad` because a split is 18.5 as often as 18, and because a technician
 * on a roof should not be hunting for a decimal point on a full keyboard.
 * Negative values are allowed — an outdoor temperature can be below zero.
 */
export function ReadingField({
  item,
  value,
  onChange,
}: {
  item: ChecklistItem;
  value: number | null;
  onChange: (next: number | null) => void;
}) {
  return (
    <View className="mt-2 flex-row items-center gap-2">
      <TextInput
        accessibilityLabel={`${item.label}${item.unit ? ` in ${item.unit}` : ''}`}
        className="min-h-11 flex-1 rounded-lg border border-border bg-card px-3 text-sm text-foreground"
        defaultValue={value == null ? '' : String(value)}
        keyboardType="numbers-and-punctuation"
        onEndEditing={(event) => {
          const raw = event.nativeEvent.text.trim();
          if (!raw) return onChange(null);
          const parsed = Number(raw);
          // Rejected rather than coerced: Number('') is 0, and a blank field
          // recorded as zero degrees is a measurement nobody took.
          if (Number.isFinite(parsed)) onChange(parsed);
        }}
        placeholder="—"
        placeholderTextColor="#9ca3af"
      />
      {item.unit ? (
        <Text className="w-12 text-sm font-semibold text-muted-foreground">{item.unit}</Text>
      ) : null}
    </View>
  );
}

/** A blank line on the printed form. */
export function TextField({
  item,
  value,
  onChange,
}: {
  item: ChecklistItem;
  value: string | null;
  onChange: (next: string | null) => void;
}) {
  return (
    <TextInput
      accessibilityLabel={item.label}
      className="mt-2 min-h-11 rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground"
      defaultValue={value ?? ''}
      multiline
      onEndEditing={(event) => onChange(event.nativeEvent.text.trim() || null)}
      placeholder="—"
      placeholderTextColor="#9ca3af"
    />
  );
}

/**
 * Exactly one option, or none.
 *
 * Tapping the active option clears it, the same gesture the yes/no axes use, so
 * "not assessed" stays reachable — a form that cannot be un-answered records a
 * guess as a finding.
 */
export function ChoiceField({
  item,
  value,
  onChange,
}: {
  item: ChecklistItem;
  value: string | null;
  onChange: (next: string | null) => void;
}) {
  return (
    <View className="mt-2 gap-1.5">
      {(item.choices ?? []).map((choice) => {
        const active = value === choice;
        return (
          <Pressable
            accessibilityLabel={`${item.label}: ${choice}`}
            accessibilityRole="radio"
            accessibilityState={{ checked: active }}
            className={`min-h-11 justify-center rounded-lg border px-3 ${
              active ? 'border-primary bg-primary/15' : 'border-border bg-card'
            }`}
            key={choice}
            onPress={() => onChange(active ? null : choice)}
          >
            <Text
              className={`text-sm ${active ? 'font-semibold text-primary' : 'text-foreground'}`}
            >
              {choice}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * What was wrong, asked only once an answer says something was.
 *
 * From the field feedback: *"Comments: Required only when an issue is
 * identified."* Prompted rather than required — see `choiceInvitesComment` in
 * shared for why the literal wording is not what gets the office a real
 * sentence.
 *
 * `onEndEditing` rather than `onChangeText`, matching `TextField` above: a
 * technician typing a sentence should not fire a request per keystroke, and the
 * whole assessment is re-sent on every write.
 */
export function CommentField({
  item,
  value,
  onChange,
}: {
  item: ChecklistItem;
  value: string | null;
  onChange: (next: string | null) => void;
}) {
  return (
    <View className="mt-2">
      <Text className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        What did you find?{' '}
        <Text className="font-normal normal-case tracking-normal">(optional)</Text>
      </Text>
      <TextInput
        accessibilityLabel={`What did you find in ${item.label}, optional`}
        className="min-h-11 rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground"
        defaultValue={value ?? ''}
        multiline
        onEndEditing={(event) => onChange(event.nativeEvent.text.trim() || null)}
        placeholder="Scuffed paint behind the door…"
        placeholderTextColor="#9ca3af"
        textAlignVertical="top"
      />
    </View>
  );
}

/**
 * Whether an item counts as answered, for the coverage figure in the header.
 *
 * A reading of zero and an empty string are different things: the first is a
 * measurement, the second is a blank field. `!= null` rather than truthiness,
 * because 0 °F is an answer.
 */
export function isAnswered(
  item: ChecklistItem,
  assessment: ChecklistAssessment | undefined,
): boolean {
  if (!assessment) return false;
  switch (item.responseType ?? 'STATUS') {
    case 'READING':
      return assessment.numericValue != null;
    case 'TEXT':
    case 'CHOICE':
      return Boolean(assessment.textValue);
    default:
      return (
        assessment.isClean !== null ||
        assessment.isUndamaged !== null ||
        assessment.isWorking !== null
      );
  }
}
