import { answerAfterToggle, choicesInAnswer } from '@texasrenters/shared';
import { CheckIcon } from 'lucide-react-native';
import { Pressable, Text, TextInput, View } from 'react-native';

import { PRESS_ROW } from '../components/ui/press';
import type { ChecklistAssessment } from '../domain/models';
import { registerIcons } from '../lib/icons';
import type { ChecklistItem } from './area-checklist';

registerIcons(CheckIcon);

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
 * The answer a tap on one option leaves behind: that option, or none.
 *
 * One value, never a set. Choosing another option replaces the answer, so the
 * selection moves rather than accumulating. Tapping the chosen option clears
 * it, the same gesture the yes/no axes use, so "not assessed" stays reachable —
 * a form that cannot be un-answered records a guess as a finding.
 */
export function choiceAfterTap(current: string | null, tapped: string): string | null {
  return current === tapped ? null : tapped;
}

/**
 * Exactly one option, or none, drawn as a radio list.
 *
 * One bordered group with a ring on every option and a tick in the chosen one.
 * The options used to be separate bordered buttons, and demoed to the product
 * owner they read as independent toggles — the occupied questions looked as
 * though several answers could be picked at once. They never could: one value
 * is stored, and `choiceAfterTap` is the whole rule.
 *
 * Rows inside the group dim on press rather than shrink, because they are
 * divided by hairlines and have no edges of their own — see `PRESS_ROW`.
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
    <View
      accessibilityLabel={item.label}
      accessibilityRole="radiogroup"
      className="mt-2 overflow-hidden rounded-xl border border-border"
    >
      {(item.choices ?? []).map((choice, index) => {
        const active = value === choice;
        return (
          <Pressable
            // The state already says "selected"; the hint says what a second
            // tap does, which nothing on screen does.
            accessibilityHint={active ? 'Tap again to clear the answer' : undefined}
            accessibilityLabel={`${item.label}: ${choice}`}
            accessibilityRole="radio"
            accessibilityState={{ checked: active }}
            className={`min-h-12 flex-row items-center gap-3 px-3 ${
              index > 0 ? 'border-t border-border' : ''
            } ${active ? 'bg-primary/10' : ''} ${PRESS_ROW}`}
            key={choice}
            onPress={() => onChange(choiceAfterTap(value, choice))}
          >
            {/* The radio: an empty ring, or filled with a tick. The ring is what
                identifies the control, so it carries WCAG 1.4.11's 3:1 — and
                `muted-foreground` rather than `input`, which drops below that
                on the green wash of an item the checklist sheet shows as
                covered. */}
            <View
              className={`h-5 w-5 items-center justify-center rounded-full ${
                active ? 'bg-primary' : 'border-2 border-muted-foreground'
              }`}
            >
              {active ? (
                <CheckIcon size={13} strokeWidth={3} className="text-primary-foreground" />
              ) : null}
            </View>
            <Text
              className={`min-w-0 flex-1 text-sm text-foreground ${active ? 'font-semibold' : ''}`}
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
 * Any number of options, drawn as checkboxes.
 *
 * The occupied condition questions, since 2026-09-15: the office asked for
 * checkboxes, because a room can be clean and still need attention. Every
 * ticked option is stored in the one answer, in the order the question offers
 * them (`answerAfterToggle`), and printed on the report as written.
 *
 * Square boxes rather than the radio list's rings, so the control says what it
 * does: the rings were introduced when the separate buttons read as though
 * several could be picked and only one could. Now several can.
 */
export function ChoicesField({
  item,
  value,
  onChange,
}: {
  item: ChecklistItem;
  value: string | null;
  onChange: (next: string | null) => void;
}) {
  const picked = new Set(choicesInAnswer(value));
  const offered = item.choices ?? [];
  return (
    <View accessibilityLabel={item.label} className="mt-2 overflow-hidden rounded-xl border border-border">
      {offered.map((choice, index) => {
        const active = picked.has(choice);
        return (
          <Pressable
            accessibilityLabel={`${item.label}: ${choice}`}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: active }}
            className={`min-h-12 flex-row items-center gap-3 px-3 ${
              index > 0 ? 'border-t border-border' : ''
            } ${active ? 'bg-primary/10' : ''} ${PRESS_ROW}`}
            key={choice}
            onPress={() => onChange(answerAfterToggle(value, choice, offered))}
          >
            {/* The box: empty, or filled with a tick. Its edge carries WCAG
                1.4.11's 3:1, `muted-foreground` for the same reason as above. */}
            <View
              className={`h-5 w-5 items-center justify-center rounded-md ${
                active ? 'bg-primary' : 'border-2 border-muted-foreground'
              }`}
            >
              {active ? (
                <CheckIcon size={13} strokeWidth={3} className="text-primary-foreground" />
              ) : null}
            </View>
            <Text
              className={`min-w-0 flex-1 text-sm text-foreground ${active ? 'font-semibold' : ''}`}
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
